// §9.2 — embedded Claude pane: pty manager.
//
// Owns the conversational pty (one global per app instance, persistent across
// doc switches) and worker ptys (ephemeral, per-task — rev-1md.3 toolbar
// spawns).
//
// Process model:
//   - claude CLI binary discovered from PATH on first spawn (cached).
//   - When gas-town is detected, the pty wraps `gt rig run reviewer/<you>`
//     so the embedded session has its own rig identity (§9.2.5).
//   - Skill priming (§9.2.3) is written to stdin as the first line: the
//     slash-command `/review-pdf-to-latex`. Claude Code 2.1.146 has no
//     `--skill` flag (verified by rev-a1u spike), so slash-commands are
//     the activation path.
//
// IPC channels (renderer ↔ main):
//   - pty:probeReviewer    → check gt presence + identity
//   - pty:start            → lazy spawn the conversational pty
//   - pty:input            → write to stdin
//   - pty:resize           → propagate xterm.js resize to the pty
//   - pty:kill             → ask main to SIGTERM + SIGKILL the pty
//   - pty:onData           → main → renderer data stream
//   - pty:onExit           → main → renderer exit notification
//   - pty:freshStart       → kill+respawn conv pty with handoff priming
//   - pty:startWorker      → spawn an ephemeral worker pty (rev-1md.3)
//   - pty:workerInput      → stdin to a specific worker
//   - pty:workerResize     → resize a specific worker
//   - pty:killWorker       → SIGTERM + SIGKILL a specific worker
//   - pty:onWorkerData     → main → renderer worker data stream
//   - pty:onWorkerExit     → main → renderer worker exit notification
//   - pty:onWorkerProgress → §9.2.7 β/γ structured progress markers

import { BrowserWindow, ipcMain, app } from 'electron';
import { typedHandle } from './typed-ipc.js';
import { assertObjectArg, assertStringArg } from './ipc-validators.js';
import {
  resolveSessionCwd,
  resolveSkipPermissions,
  ptySkipPermissionArgs,
} from './session-policy.js';
import {
  whichSync,
  probeReviewer,
  reviewerEnvOverlay,
  _resetReviewerProbeCacheForTests,
} from './reviewer-probe.js';
import {
  PRIMING_SLASH_COMMAND,
  PRIMING_CONV_FALLBACK_MS,
  PRIMING_WORKER_FALLBACK_MS,
  detectClaudeReady,
  buildFreshStartPriming,
  buildCreateContextPriming,
  buildSlingPriming,
} from '@shared/priming';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import {
  MAX_WORKER_PTYS,
  type FreshStartParams,
  type FreshStartResult,
  type PtyExitEvent,
  type PtyStartParams,
  type PtyStartResult,
  type ReviewerProbe,
  type WorkerProgressMarker,
  type WorkerStartParams,
  type WorkerStartResult,
} from '@shared/pty';

// ─── State ────────────────────────────────────────────────────────────────

interface ConvPtyHandle {
  pty: IPty;
  webContents: Electron.WebContents;
  /** PDF-source dir at spawn time. Subsequent doc switches do NOT cd the pty
   *  per §9.2.9 — relative path resolution stays anchored to the spawn dir. */
  cwd: string;
}

let convHandle: ConvPtyHandle | null = null;

// Throwaway-ID for crash detection — bumped each spawn so a late onExit from
// the previous pty doesn't fire restart UI on the new one.
let convGeneration = 0;

interface WorkerPtyHandle {
  pty: IPty;
  webContents: Electron.WebContents;
  workerId: string;
  /** Line-buffer for β-marker extraction. The parser reads complete lines
   *  only — partial fragments are held until the next newline arrives. */
  lineBuffer: string;
}

const workerHandles = new Map<string, WorkerPtyHandle>();

// ─── Binary discovery ─────────────────────────────────────────────────────

let claudeBinaryCache: string | null | undefined = undefined;
function findClaude(): string | null {
  if (claudeBinaryCache !== undefined) return claudeBinaryCache;
  claudeBinaryCache = whichSync('claude');
  return claudeBinaryCache;
}

// Reviewer-rig gating (probeReviewer / reviewerEnvOverlay) lives in the shared
// reviewer-probe module so the SDK/agent-pane route applies the same gate.

// ─── Spawn the conversational pty ─────────────────────────────────────────

/**
 * Send a multi-line message to claude's TUI as a single user turn by
 * wrapping it in xterm bracketed-paste markers and committing with \r.
 *
 * Why this matters: claude's TUI treats a bare \r as "submit the current
 * buffer." Writing a multi-line string with \r between lines causes it to
 * submit each line as its own turn, which produces the "Enter hangs after
 * first round" symptom (claude is mid-response on the first line while
 * subsequent lines pile into the input queue). Bracketed paste signals to
 * the TUI that the content is from a paste, so newlines are taken as soft
 * newlines (the TUI buffers them) and only the trailing \r commits.
 *
 * Sequence reference: xterm DEC mode 2004 (https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode).
 * ESC [ 200 ~  = paste start; ESC [ 201 ~  = paste end.
 */
function writeBracketedPaste(p: IPty, text: string): void {
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';
  // Normalize line endings to \n inside the paste; the TUI handles \n as soft
  // newlines under bracketed-paste mode. A stray \r mid-paste would still
  // submit early on some TUIs, so we strip them.
  const normalized = text.replace(/\r\n?/g, '\n');
  p.write(`${PASTE_START}${normalized}${PASTE_END}\r`);
}

/**
 * Fire `prime()` once claude's interactive prompt is observed in the pty
 * output (priming.detectClaudeReady), falling back to a wall-clock timeout only
 * if the ready marker never arrives. This replaces the prior fire-on-magic-delay
 * approach (rev-gkl) that raced claude's startup screen-clear and dropped the
 * slash-command from visible scrollback (C11). `alive()` lets the caller abort
 * if the pty was replaced or killed before priming fires; the readiness listener
 * disposes itself after firing so it never leaks past startup.
 */
function primeWhenReady(
  p: IPty,
  alive: () => boolean,
  fallbackMs: number,
  prime: () => void,
): void {
  let fired = false;
  let buffer = '';
  let disposable: { dispose(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try { disposable?.dispose(); } catch { /* already disposed */ }
    disposable = null;
  };

  const fireOnce = (): void => {
    if (fired) return;
    fired = true;
    cleanup();
    if (!alive()) return;
    prime();
  };

  disposable = p.onData((data) => {
    if (fired) return;
    buffer += data;
    // Bound the buffer — ready markers sit near the tail of the startup render,
    // so the last few KB is always enough and a slow-talking session can't grow
    // it without bound.
    if (buffer.length > 65536) buffer = buffer.slice(-65536);
    if (detectClaudeReady(buffer)) fireOnce();
  });

  timer = setTimeout(fireOnce, fallbackMs);
}

function buildPtyEnv(reviewer: ReviewerProbe): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    TERM: 'xterm-256color',
    ...reviewerEnvOverlay(reviewer),
  };
}

function spawnConversational(
  webContents: Electron.WebContents,
  params: PtyStartParams,
  primingExtra?: string,
): PtyStartResult {
  // Idempotent: if a pty is already alive for this webContents, return its
  // shape. Renderer should call start once on first PDF open; later calls
  // (e.g., after a Restart click) get a fresh pty via freshStart.
  if (convHandle && !convHandle.webContents.isDestroyed()) {
    return {
      ok: true,
      already_running: true,
      cwd: convHandle.cwd,
      reviewer: probeReviewer(),
    };
  }

  const claudeBin = findClaude();
  if (!claudeBin) {
    return { ok: false, reason: 'claude_not_found' };
  }

  const reviewer = probeReviewer();

  // Working dir + skip-permissions: §9.2.9 source-dir anchoring and the AJB
  // default-skip ask, both via the shared session-policy module (X8 parity
  // with the SDK route).
  const cwd = resolveSessionCwd(params.docSourceDir, dirname(app.getPath('userData')));

  const env = buildPtyEnv(reviewer);
  const cols = Math.max(20, params.cols ?? 80);
  const rows = Math.max(5, params.rows ?? 24);

  const skipPerms = resolveSkipPermissions(params.dangerouslySkipPermissions);
  const claudeArgs: string[] = ptySkipPermissionArgs(skipPerms);

  let p: IPty;
  try {
    p = pty.spawn(claudeBin, claudeArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const generation = ++convGeneration;
  const handle: ConvPtyHandle = { pty: p, webContents, cwd };
  convHandle = handle;

  p.onData((data) => {
    if (webContents.isDestroyed()) return;
    webContents.send('pty:onData', { generation, data });
  });
  p.onExit(({ exitCode, signal }) => {
    if (convHandle === handle) convHandle = null;
    if (webContents.isDestroyed()) return;
    const ev: PtyExitEvent = { generation, exitCode, signal: signal ?? null };
    webContents.send('pty:onExit', ev);
  });

  // Skill priming (§9.2.3). The slash-command is the activation path;
  // primingExtra carries the Fresh-Start handoff line when present.
  //
  // Fire when claude's interactive prompt is observed in the output rather than
  // on a magic wall-clock delay (rev-gkl bumped it 500 → 1500ms chasing the
  // startup screen-clear race; C11 flagged the fragility). The observed-output
  // trigger fires right after the render settles; PRIMING_CONV_FALLBACK_MS is a
  // safety net only, so behavior is unchanged when detection misses.
  primeWhenReady(
    p,
    () => convHandle === handle,
    PRIMING_CONV_FALLBACK_MS,
    () => {
      console.log('[claude-pty] firing slash-command priming /review-pdf-to-latex (observed-ready trigger)');
      try { p.write(`${PRIMING_SLASH_COMMAND}\r`); } catch { /* pty closed */ }
      if (primingExtra && primingExtra.trim().length > 0) {
        // Give claude a beat to ack the slash-command before the next line —
        // empirically the slash echo + skill banner take ~150-300ms.
        setTimeout(() => {
          if (convHandle !== handle) return;
          try {
            // Single-line: bare \r. Multi-line: bracketed-paste so claude
            // sees it as one user turn (same fix as worker pty).
            if (primingExtra.includes('\n') || primingExtra.includes('\r')) {
              writeBracketedPaste(p, primingExtra);
            } else {
              p.write(`${primingExtra}\r`);
            }
          } catch { /* pty closed */ }
        }, 350);
      }
    },
  );

  return { ok: true, already_running: false, cwd, reviewer };
}

function killConversational(): void {
  if (!convHandle) return;
  const p = convHandle.pty;
  convHandle = null;
  try { p.kill('SIGTERM'); } catch { /* already dead */ }
  // SIGKILL fallback per §9.2.2 — give it a moment, then force.
  setTimeout(() => {
    try { p.kill('SIGKILL'); } catch { /* gone */ }
  }, 1500);
}

// ─── §9.2.6 Fresh Start ──────────────────────────────────────────────────

function freshStart(
  webContents: Electron.WebContents,
  params: FreshStartParams,
): FreshStartResult {
  // Kill the existing pty if any. spawnConversational below sees convHandle=null
  // and proceeds with a clean spawn. The previous pty's onExit fires for the
  // *renderer*; we set a fresh generation so the renderer's onExit handler
  // filters stale events.
  if (convHandle) {
    const stale = convHandle;
    convHandle = null;
    try { stale.pty.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { stale.pty.kill('SIGKILL'); } catch { /* gone */ }
    }, 1500);
  }

  const result = spawnConversational(
    webContents,
    {
      docSourceDir: params.docSourceDir,
      cols: params.cols,
      rows: params.rows,
      dangerouslySkipPermissions: params.dangerouslySkipPermissions,
    },
    buildFreshStartPriming(params.handoffNotes),
  );

  if (!result.ok) return result;
  return { ok: true, cwd: result.cwd, reviewer: result.reviewer };
}

// ─── §9.2.6 worker ptys ──────────────────────────────────────────────────

/** Extract `[β] key=value key="quoted value" ...` lines out of the worker's
 *  stdout. Returns the cleaned stream (with marker lines removed) plus any
 *  parsed markers. Lines without a complete trailing newline are held in the
 *  lineBuffer for the next chunk. */
function extractProgressMarkers(
  handle: WorkerPtyHandle,
  chunk: string,
): { passthrough: string; markers: WorkerProgressMarker[] } {
  const merged = handle.lineBuffer + chunk;
  // Split on \n while preserving \r — terminals emit \r\n; we keep \r in the
  // passthrough so xterm.js gets faithful output.
  const lastNl = merged.lastIndexOf('\n');
  if (lastNl === -1) {
    handle.lineBuffer = merged;
    return { passthrough: '', markers: [] };
  }
  const complete = merged.slice(0, lastNl + 1);
  handle.lineBuffer = merged.slice(lastNl + 1);
  const markers: WorkerProgressMarker[] = [];
  const passthrough = complete.split('\n').map((line) => {
    // Strip a trailing \r so the regex can match the marker tail cleanly.
    const trimmed = line.replace(/\r$/, '');
    const m = /^\[β\]\s+(.*)$/.exec(trimmed);
    if (!m) return line;
    const parsed = parseMarker(m[1]);
    if (parsed) {
      markers.push(parsed);
      // Drop the marker line from passthrough — the strip carries it.
      return null;
    }
    return line;
  }).filter((l): l is string => l !== null).join('\n');
  return { passthrough, markers };
}

/** Parse `key=value key="quoted value with spaces"` into a marker.
 *  Unknown kinds / missing required fields drop the marker silently. */
function parseMarker(payload: string): WorkerProgressMarker | null {
  const tokens = tokenizeMarker(payload);
  const kind = tokens.kind;
  if (kind === 'progress') {
    const done = Number(tokens.done);
    const total = Number(tokens.total);
    if (!Number.isFinite(done) || !Number.isFinite(total)) return null;
    const phase = (tokens.phase ?? 'work').toString();
    const label = tokens.label ? String(tokens.label) : null;
    return { kind: 'progress', phase, done, total, label };
  }
  if (kind === 'status') {
    if (!tokens.text) return null;
    return { kind: 'status', text: String(tokens.text) };
  }
  if (kind === 'done') {
    return { kind: 'done', text: tokens.text ? String(tokens.text) : null };
  }
  if (kind === 'error') {
    if (!tokens.text) return null;
    return { kind: 'error', text: String(tokens.text) };
  }
  return null;
}

function tokenizeMarker(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload)) !== null) {
    const key = m[1];
    const quoted = m[2];
    const bare = m[3];
    out[key] = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare;
  }
  return out;
}

function spawnWorker(
  webContents: Electron.WebContents,
  params: WorkerStartParams,
): WorkerStartResult {
  if (workerHandles.size >= MAX_WORKER_PTYS) {
    return {
      ok: false,
      reason: 'limit_exceeded',
      error: `worker limit reached (${MAX_WORKER_PTYS})`,
    };
  }
  // Sling requires gas-town — the worker's whole job is to gt mail. Bail
  // early with a clear reason rather than spawning a doomed claude session.
  if (params.kind === 'sling') {
    const r = probeReviewer();
    if (!r.enabled) {
      return { ok: false, reason: 'no_gt', error: 'gas-town is required for Sling' };
    }
    if (!params.destination) {
      return { ok: false, reason: 'spawn_failed', error: 'destination required for Sling' };
    }
  }
  const claudeBin = findClaude();
  if (!claudeBin) return { ok: false, reason: 'claude_not_found' };

  const reviewer = probeReviewer();
  const cwd = resolveSessionCwd(params.docSourceDir, dirname(app.getPath('userData')));

  const env = buildPtyEnv(reviewer);
  const cols = Math.max(20, params.cols ?? 100);
  const rows = Math.max(5, params.rows ?? 24);

  const skipPerms = resolveSkipPermissions(params.dangerouslySkipPermissions);
  const claudeArgs: string[] = ptySkipPermissionArgs(skipPerms);

  let p: IPty;
  try {
    p = pty.spawn(claudeBin, claudeArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const workerId = params.workerId ?? randomUUID();
  const handle: WorkerPtyHandle = { pty: p, webContents, workerId, lineBuffer: '' };
  workerHandles.set(workerId, handle);

  p.onData((data) => {
    if (webContents.isDestroyed()) return;
    const { passthrough, markers } = extractProgressMarkers(handle, data);
    if (passthrough.length > 0) {
      webContents.send('pty:onWorkerData', { workerId, data: passthrough });
    }
    for (const marker of markers) {
      webContents.send('pty:onWorkerProgress', { workerId, marker });
    }
  });
  p.onExit(({ exitCode, signal }) => {
    workerHandles.delete(workerId);
    if (webContents.isDestroyed()) return;
    // Flush any trailing line in the buffer (no newline came) — preserves
    // last-second output if the worker exits abruptly.
    if (handle.lineBuffer.length > 0) {
      webContents.send('pty:onWorkerData', { workerId, data: handle.lineBuffer });
      handle.lineBuffer = '';
    }
    webContents.send('pty:onWorkerExit', {
      workerId, exitCode, signal: signal ?? null,
    });
  });

  // Priming. Same observed-output trigger as the conv pty — fire when claude's
  // prompt is rendered rather than on a magic delay, with PRIMING_WORKER_FALLBACK_MS
  // as a safety net only. Slash-command first, then the bundle as a follow-up
  // message. The bundle goes in as a single (multi-line) message so claude
  // sees it as one user turn.
  const primingText =
    params.kind === 'sling'
      ? buildSlingPriming(params)
      : buildCreateContextPriming(params);

  primeWhenReady(
    p,
    () => workerHandles.has(workerId),
    PRIMING_WORKER_FALLBACK_MS,
    () => {
      try { p.write(`${PRIMING_SLASH_COMMAND}\r`); } catch { /* pty closed */ }
      setTimeout(() => {
        if (!workerHandles.has(workerId)) return;
        try {
          // Multi-line priming uses bracketed-paste mode so claude's TUI
          // treats the entire prompt as a single user turn. The previous
          // approach (write each line followed by \r) made claude submit
          // each line as its own message, which produced the "Enter hangs
          // after first round" bug AJB hit during M7 verification.
          // ESC [ 200 ~ ... ESC [ 201 ~ is the standard xterm bracketed-paste
          // start/end; the final \r commits the now-multi-line buffer.
          writeBracketedPaste(p, primingText);
        } catch { /* pty closed */ }
      }, 400);
    },
  );

  return { ok: true, workerId, cwd, reviewer };
}

function killWorker(workerId: string): void {
  const handle = workerHandles.get(workerId);
  if (!handle) return;
  workerHandles.delete(workerId);
  try { handle.pty.kill('SIGTERM'); } catch { /* already dead */ }
  setTimeout(() => {
    try { handle.pty.kill('SIGKILL'); } catch { /* gone */ }
  }, 1500);
}

// ─── IPC wiring ───────────────────────────────────────────────────────────

export function registerClaudePtyIpc(): void {
  typedHandle('probeReviewer', (): ReviewerProbe => probeReviewer());

  typedHandle('startPty', (event, params): PtyStartResult => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: 'no_window' };
    return spawnConversational(event.sender, params);
  }, ([params]) => assertObjectArg('pty:start', params));

  ipcMain.on('pty:input', (event, data: string) => {
    if (!convHandle) return;
    if (event.sender !== convHandle.webContents) return;
    try { convHandle.pty.write(data); } catch { /* pty closed */ }
  });

  ipcMain.on('pty:resize', (event, cols: number, rows: number) => {
    if (!convHandle) return;
    if (event.sender !== convHandle.webContents) return;
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    try { convHandle.pty.resize(c, r); } catch { /* pty closed */ }
  });

  typedHandle('killPty', () => {
    killConversational();
    return { ok: true } as const;
  });

  // §9.2.6 Fresh Start — kill + respawn with handoff priming.
  typedHandle('freshStartPty', (event, params): FreshStartResult => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: 'no_window' };
    return freshStart(event.sender, params);
  }, ([params]) => assertObjectArg('pty:freshStart', params));

  // §9.2.6 worker spawn.
  typedHandle('startWorkerPty', (event, params): WorkerStartResult => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: 'no_window' };
    return spawnWorker(event.sender, params);
  }, ([params]) => assertObjectArg('pty:startWorker', params));

  ipcMain.on('pty:workerInput', (event, workerId: string, data: string) => {
    const h = workerHandles.get(workerId);
    if (!h || event.sender !== h.webContents) return;
    try { h.pty.write(data); } catch { /* pty closed */ }
  });

  ipcMain.on('pty:workerResize', (event, workerId: string, cols: number, rows: number) => {
    const h = workerHandles.get(workerId);
    if (!h || event.sender !== h.webContents) return;
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    try { h.pty.resize(c, r); } catch { /* pty closed */ }
  });

  typedHandle('killWorkerPty', (event, workerId) => {
    const h = workerHandles.get(workerId);
    if (!h || event.sender !== h.webContents) return { ok: true } as const;
    killWorker(workerId);
    return { ok: true } as const;
  }, ([workerId]) => assertStringArg('pty:killWorker', workerId));
}

/** Tear down on app quit. Safe to call repeatedly. */
export function shutdownClaudePty(): void {
  killConversational();
  for (const id of Array.from(workerHandles.keys())) {
    killWorker(id);
  }
}

/** Test seam — clear the binary + reviewer caches. Used by future integration
 *  tests; no production caller. */
export function _resetCachesForTests(): void {
  claudeBinaryCache = undefined;
  _resetReviewerProbeCacheForTests();
}
