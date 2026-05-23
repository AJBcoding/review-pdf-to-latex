// Project 4 / M-int-2 — main-process IPC handlers for the React agent pane.
//
// Ported from agent-viewer's src/main/index.ts. Provides the 6 IPC methods
// the renderer's preload bridge (window.agentViewer) calls into, plus
// emits BackendEvents back to the renderer via "agent:event".
//
// Coexists with the legacy claude-pty IPC: the renderer chooses which path
// to use via the localStorage feature flag (see desktop/renderer/index.ts).
import { BrowserWindow, ipcMain } from 'electron';

import {
  clearSavedSessionId,
  loadSavedSessionId,
  saveSessionId,
} from './session-store.js';
import { startSession, type ClaudeSession } from './claude-backend.js';
import type { BackendEvent } from '@shared/agent-pane/types.js';

let session: ClaudeSession | null = null;
let mainWindowRef: BrowserWindow | null = null;

// Project 4 / M-int-3 — doc-switch debounce. Format mirrors the legacy
// claude-pane '[Now viewing: …]' line so users grepping scrollback have
// the same affordance.
const DOC_SWITCH_DEBOUNCE_MS = 500;
let pendingDocSwitch: { path: string; pages: number; comments: number } | null =
  null;
let docSwitchTimer: ReturnType<typeof setTimeout> | null = null;

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function flushDocSwitch(): void {
  docSwitchTimer = null;
  const p = pendingDocSwitch;
  pendingDocSwitch = null;
  if (!p) return;
  const base = basenameOf(p.path);
  const line = `[Now viewing: ${base} — ${p.path} (${p.pages} pages, ${p.comments} comments)]`;
  const s = ensureSession();
  s.send(line);
}

function emitToRenderer(event: BackendEvent): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('agent:event', event);
  }
}

function ensureSession(options?: {
  resume?: string | null;
  model?: string;
}): ClaudeSession {
  if (session) return session;
  const explicitResume = options?.resume;
  // explicit null = "no resume". undefined = "use saved".
  const resume =
    explicitResume === null
      ? undefined
      : (explicitResume ?? loadSavedSessionId() ?? undefined);
  session = startSession({
    emit: emitToRenderer,
    resume,
    onSessionId: saveSessionId,
    model: options?.model,
  });
  return session;
}

async function endSession(): Promise<void> {
  if (!session) return;
  await session.close();
  session = null;
}

/** Register the agent-pane IPC handlers. Safe to call once at app boot. */
export function registerAgentPaneIpc(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;

  ipcMain.handle(
    'agent:send',
    (_e, payload: { text: string; model?: string }) => {
      if (typeof payload?.text !== 'string') return;
      const s = ensureSession({
        model: typeof payload.model === 'string' ? payload.model : undefined,
      });
      s.send(payload.text);
    },
  );

  ipcMain.handle('agent:interrupt', async () => {
    if (session) await session.interrupt();
  });

  ipcMain.handle(
    'agent:setModel',
    async (_e, payload: { modelId: string }) => {
      if (!session) return;
      if (typeof payload?.modelId !== 'string') return;
      await session.setModel(payload.modelId);
    },
  );

  ipcMain.handle(
    'agent:approveTool',
    (
      _e,
      payload: { toolUseId: string; allow: boolean; denyReason?: string },
    ) => {
      if (!session) return;
      if (typeof payload?.toolUseId !== 'string') return;
      session.approve(
        payload.toolUseId,
        payload.allow === true,
        payload.denyReason,
      );
    },
  );

  ipcMain.handle('agent:newSession', async () => {
    await endSession();
    clearSavedSessionId();
  });

  ipcMain.handle('agent:close', async () => {
    await endSession();
  });

  ipcMain.handle('agent:getSavedSessionId', () => loadSavedSessionId());

  // Project 4 / M-int-3 — doc-switch context priming. Debounced 500ms so
  // rapid tree navigation only emits one line. Equivalent of the xterm
  // pane's notifyDocSwitch (claude-pane.ts:439).
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
}

/** Tear down the live session on app quit. */
export async function shutdownAgentPane(): Promise<void> {
  await endSession();
}
