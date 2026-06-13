// Project 4 — main-process IPC for the React agent pane.
//
// M-int-2: single-session agent IPC ported from agent-viewer.
// M-int-3: doc-context priming (debounced 500ms).
// M-int-4a: multi-session support. A Map<sessionId, ClaudeSession> holds
// every live session; the canonical conversational session is "conv"
// (CONV_SESSION_ID). Workers (Create Context, Sling) take their own
// sessionId. Events emit with sessionId attached so the renderer can
// route per session.
import { BrowserWindow, ipcMain } from 'electron';

import {
  clearSavedSessionId,
  loadSavedSessionId,
  saveSessionId,
} from './session-store.js';
import { startSession, type ClaudeSession } from './claude-backend.js';
import {
  CONV_SESSION_ID,
  type BackendEvent,
} from '@shared/agent-pane/types.js';
import { MAX_WORKER_PTYS } from '@shared/types';

const sessions = new Map<string, ClaudeSession>();
let mainWindowRef: BrowserWindow | null = null;

function emitToRenderer(sessionId: string, event: BackendEvent): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  mainWindowRef.webContents.send('agent:event', { ...event, sessionId });
}

function makeEmit(sessionId: string) {
  return (event: BackendEvent) => emitToRenderer(sessionId, event);
}

function ensureSession(options?: {
  sessionId?: string;
  resume?: string | null;
  model?: string;
}): ClaudeSession {
  const sessionId = options?.sessionId ?? CONV_SESSION_ID;
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  // Only the conv session participates in the saved-resume mechanism today.
  // Workers always start fresh.
  const isConv = sessionId === CONV_SESSION_ID;
  const explicitResume = options?.resume;
  let resume: string | undefined;
  if (isConv) {
    resume =
      explicitResume === null
        ? undefined
        : (explicitResume ?? loadSavedSessionId() ?? undefined);
  }

  const session = startSession({
    emit: makeEmit(sessionId),
    resume,
    onSessionId: isConv ? saveSessionId : () => undefined,
    // When the session dies on its own (SDK stream end or error), drop it
    // from the registry so the next send lazily creates a FRESH one instead
    // of resurrecting a zombie. Host-initiated close() suppresses this
    // callback, so endSession's own delete remains the path for teardown.
    onClosed: () => {
      sessions.delete(sessionId);
    },
    model: options?.model,
  });
  sessions.set(sessionId, session);
  return session;
}

/** Count live worker sessions (everything except the conv session). Mirrors
 * the pty route's MAX_WORKER_PTYS accounting (claude-pty.ts spawnWorker). */
function workerSessionCount(): number {
  let n = 0;
  for (const id of sessions.keys()) {
    if (id !== CONV_SESSION_ID) n += 1;
  }
  return n;
}

async function endSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  await session.close();
  sessions.delete(sessionId);
}

async function endAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => endSession(id)));
}

// ─── Doc-switch debounce (M-int-3, conv session only) ────────────────────

const DOC_SWITCH_DEBOUNCE_MS = 500;
let pendingDocSwitch: { path: string; pages: number; comments: number } | null =
  null;
let docSwitchTimer: ReturnType<typeof setTimeout> | null = null;
let lastDocSwitch: { path: string; pages: number; comments: number } | null =
  null;

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function buildDocPrimingLine(p: { path: string; pages: number; comments: number }): string {
  const base = basenameOf(p.path);
  const ext = base.toLowerCase().split('.').pop() ?? '';
  const verb = (ext === 'md' || ext === 'markdown') ? 'editing' : 'reviewing';
  const unit = p.pages === 1 && (ext === 'md' || ext === 'markdown') ? 'file' : `${p.pages} pages`;
  return `[Now ${verb}: ${base} — ${p.path} (${unit}, ${p.comments} comments)]`;
}

function flushDocSwitch(): void {
  docSwitchTimer = null;
  const p = pendingDocSwitch;
  pendingDocSwitch = null;
  if (!p) return;
  lastDocSwitch = p;
  const s = ensureSession();
  s.send(buildDocPrimingLine(p));
}

// ─── IPC handlers ────────────────────────────────────────────────────────

/** Update the main window reference when the window is recreated. */
export function rebindMainWindow(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;
}

/** Register the agent-pane IPC handlers. Safe to call once at app boot. */
export function registerAgentPaneIpc(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;

  ipcMain.handle(
    'agent:send',
    (
      _e,
      payload: { text: string; model?: string; sessionId?: string },
    ) => {
      if (typeof payload?.text !== 'string') return;
      const sessionId = payload.sessionId ?? CONV_SESSION_ID;
      // Create-only-for-conv: a send to an unknown worker id must NOT spin up
      // a brand-new full Claude session (a renderer routing bug — e.g. a
      // stale `worker-ctx-${Date.now()}` id — would otherwise mint N silent
      // background sessions, each a real query() subprocess with cost). Worker
      // sessions are created exclusively via agent:spawnSession; a send to an
      // unknown worker is a logged no-op, matching the pty route's behavior.
      if (sessionId !== CONV_SESSION_ID && !sessions.has(sessionId)) {
        console.warn(
          `[agent-pane] agent:send to unknown worker session "${sessionId}" — ignoring (workers are created via agent:spawnSession)`,
        );
        return;
      }
      const s = ensureSession({
        sessionId,
        model: typeof payload.model === 'string' ? payload.model : undefined,
      });
      s.send(payload.text);
    },
  );

  ipcMain.handle(
    'agent:interrupt',
    async (_e, payload?: { sessionId?: string }) => {
      const sessionId = payload?.sessionId ?? CONV_SESSION_ID;
      const session = sessions.get(sessionId);
      if (session) await session.interrupt();
    },
  );

  ipcMain.handle(
    'agent:setModel',
    async (_e, payload: { modelId: string; sessionId?: string }) => {
      if (typeof payload?.modelId !== 'string') return;
      const session = sessions.get(payload.sessionId ?? CONV_SESSION_ID);
      if (session) await session.setModel(payload.modelId);
    },
  );

  ipcMain.handle(
    'agent:approveTool',
    (
      _e,
      payload: {
        toolUseId: string;
        allow: boolean;
        denyReason?: string;
        sessionId?: string;
      },
    ) => {
      if (typeof payload?.toolUseId !== 'string') return;
      const session = sessions.get(payload.sessionId ?? CONV_SESSION_ID);
      if (!session) return;
      session.approve(
        payload.toolUseId,
        payload.allow === true,
        payload.denyReason,
      );
    },
  );

  ipcMain.handle(
    'agent:newSession',
    async (_e, payload?: { sessionId?: string }) => {
      const sessionId = payload?.sessionId ?? CONV_SESSION_ID;
      await endSession(sessionId);
      if (sessionId === CONV_SESSION_ID) {
        clearSavedSessionId();
        if (lastDocSwitch) {
          const s = ensureSession({ resume: null });
          s.send(buildDocPrimingLine(lastDocSwitch));
        }
      }
    },
  );

  ipcMain.handle(
    'agent:close',
    async (_e, payload?: { sessionId?: string }) => {
      const sessionId = payload?.sessionId ?? CONV_SESSION_ID;
      await endSession(sessionId);
    },
  );

  ipcMain.handle('agent:getSavedSessionId', () => loadSavedSessionId());

  ipcMain.handle(
    'agent:notifyDocSwitch',
    (
      _e,
      payload: { path: string; pages: number; comments: number } | null,
    ) => {
      if (
        !payload ||
        typeof payload.path !== 'string' ||
        typeof payload.pages !== 'number' ||
        typeof payload.comments !== 'number'
      ) {
        return;
      }
      pendingDocSwitch = payload;
      if (docSwitchTimer !== null) clearTimeout(docSwitchTimer);
      docSwitchTimer = setTimeout(flushDocSwitch, DOC_SWITCH_DEBOUNCE_MS);
    },
  );

  ipcMain.handle(
    'agent:freshStart',
    async (_e, payload: { handoffText: string; model?: string }) => {
      if (!payload || typeof payload.handoffText !== 'string') return;
      await endSession(CONV_SESSION_ID);
      clearSavedSessionId();
      const s = ensureSession({
        resume: null,
        model: typeof payload.model === 'string' ? payload.model : undefined,
      });
      s.send(payload.handoffText);
    },
  );

  // M-int-4a — worker session spawn. Creates a session keyed by workerId
  // and sends the first prompt. Events scope to the worker via sessionId
  // so the renderer can route them. Workers don't participate in the
  // saved-resume mechanism (each spawn is a fresh conversation).
  ipcMain.handle(
    'agent:spawnSession',
    (
      _e,
      payload: { sessionId: string; prompt: string; model?: string },
    ) => {
      if (
        !payload ||
        typeof payload.sessionId !== 'string' ||
        !payload.sessionId ||
        payload.sessionId === CONV_SESSION_ID ||
        typeof payload.prompt !== 'string'
      ) {
        return;
      }
      // Cap simultaneous worker sessions, mirroring the pty route's
      // MAX_WORKER_PTYS guard. Without this, spawnSession had no limit while
      // the pty route refused past 16 — accidental fan-out (a stuck loop
      // spamming Create Context) could open unbounded query() subprocesses.
      // Re-spawning an already-live id is fine (it reuses the entry).
      if (
        !sessions.has(payload.sessionId) &&
        workerSessionCount() >= MAX_WORKER_PTYS
      ) {
        console.warn(
          `[agent-pane] worker session limit reached (${MAX_WORKER_PTYS}) — refusing to spawn "${payload.sessionId}"`,
        );
        return;
      }
      const s = ensureSession({
        sessionId: payload.sessionId,
        model: typeof payload.model === 'string' ? payload.model : undefined,
      });
      s.send(payload.prompt);
    },
  );

  ipcMain.handle('agent:listSessions', () => [...sessions.keys()]);
}

/** Tear down all live sessions on app quit. */
export async function shutdownAgentPane(): Promise<void> {
  await endAllSessions();
}
