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
import { spawnSync as spawnSyncBlocking } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  type ToolbarContextBundle,
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

/** Cached reviewer probe; only re-run if forced (no real path to gt install
 *  during a session, so caching is safe). */
let reviewerProbeCache: ReviewerProbe | null = null;

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

/** Resolve a binary name via PATH. Returns absolute path or null. Mirrors
 *  `which` semantics — checks each PATH entry for an executable file. */
function whichSync(bin: string): string | null {
  const PATH = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${bin}${ext.toLowerCase()}`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch { /* PATH entry unreadable */ }
    }
  }
  return null;
}

let claudeBinaryCache: string | null | undefined = undefined;
function findClaude(): string | null {
  if (claudeBinaryCache !== undefined) return claudeBinaryCache;
  claudeBinaryCache = whichSync('claude');
  return claudeBinaryCache;
}

// ─── Reviewer rig probe ───────────────────────────────────────────────────

/** Run `gt --version` (the canonical presence check per §9.2.5). Fast, no
 *  Dolt touch. Identity comes from `gt whoami` only when probing shows
 *  enabled — we don't pre-emptively touch it. */
function probeReviewer(): ReviewerProbe {
  if (reviewerProbeCache) return reviewerProbeCache;
  const gtPath = whichSync('gt');
  if (!gtPath) {
    reviewerProbeCache = { enabled: false, reason: 'no_gt' };
    return reviewerProbeCache;
  }
  // 2s timeout — `gt --version` should be sub-second; anything slower means
  // gt is wedged and we'd rather degrade than block app startup.
  const r = spawnSyncBlocking(gtPath, ['--version'], { timeout: 2000, encoding: 'utf8' });
  if (r.status !== 0) {
    reviewerProbeCache = { enabled: false, reason: 'gt_failed', gtPath, exitCode: r.status };
    return reviewerProbeCache;
  }
  const version = (r.stdout || '').trim();
  // Identity probe — `gt whoami` is reserved for *display*, not gating. We
  // run it here so the Settings UI can show it without a second round-trip.
  // If it fails, the pane still gets a Reviewer rig — the identity label is
  // best-effort.
  let identity: string | null = null;
  const w = spawnSyncBlocking(gtPath, ['whoami'], { timeout: 2000, encoding: 'utf8' });
  if (w.status === 0) identity = (w.stdout || '').trim() || null;
  reviewerProbeCache = { enabled: true, gtPath, version, identity };
  return reviewerProbeCache;
}

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

function buildPtyEnv(reviewer: ReviewerProbe): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    TERM: 'xterm-256color',
  };
  if (reviewer.enabled) env.GT_RIG = 'reviewer';
  return env;
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
      reviewer: reviewerProbeCache ?? probeReviewer(),
    };
  }

  const claudeBin = findClaude();
  if (!claudeBin) {
    return { ok: false, reason: 'claude_not_found' };
  }

  const reviewer = probeReviewer();

  // Working dir: §9.2.9 — source dir of the PDF the user just opened. Falls
  // back to userData if the source path doesn't resolve.
  let cwd = params.docSourceDir;
  if (!cwd || !existsSync(cwd)) cwd = dirname(app.getPath('userData'));

  const env = buildPtyEnv(reviewer);
  const cols = Math.max(20, params.cols ?? 80);
  const rows = Math.max(5, params.rows ?? 24);

  // AJB ask: default to --dangerously-skip-permissions so a fresh source dir
  // doesn't stall the pane on the trust prompt. Toggle in Settings to opt
  // back into per-directory prompts (params.dangerouslySkipPermissions = false).
  const skipPerms = params.dangerouslySkipPermissions !== false;
  const claudeArgs: string[] = skipPerms ? ['--dangerously-skip-permissions'] : [];

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

  // Skill priming (§9.2.3). The slash-command is the activation path.
  // primingExtra carries the Fresh-Start handoff line when present.
  //
  // Delay bumped 500 → 1500ms (rev-gkl): claude-code 2.1.146 prints a banner +
  // clears the screen before presenting its prompt; firing at 500ms races that
  // clear and the slash-command line disappears from visible scrollback (the
  // skill itself still activates, just no audit trail). 1500ms lands after
  // claude's startup-render is done on a modern Mac. If verification still
  // shows the line missing, the next fix is a visible-marker write from the
  // renderer (display-only, not via the pty).
  setTimeout(() => {
    if (convHandle !== handle) return;
    console.log('[claude-pty] firing slash-command priming /review-pdf-to-latex (rev-gkl diagnostic)');
    try { p.write('/review-pdf-to-latex\r'); } catch { /* pty closed */ }
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
  }, 1500);

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

/** Build the handoff priming line. Bracketed so it reads as a system-style
 *  message in scrollback (same shape as §9.2.4's `[Now viewing: ...]`). */
function buildFreshStartPriming(handoff: string): string {
  const trimmed = handoff.trim();
  if (!trimmed) return '[Fresh start — clean session.]';
  // Multi-line handoffs: collapse to a single bracketed line. Claude reads
  // stdin as line-buffered, and a multi-line paste would interleave with
  // the slash-command's own ack frames.
  const single = trimmed.replace(/\s+/g, ' ');
  return `[Fresh start — handoff from prior session: ${single}]`;
}

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

/** Serialize a context bundle into the worker's first-line priming. The shape
 *  is deliberately human-readable rather than JSON — the user sees this
 *  scrollback and should be able to grok what was sent. */
function bundleToPrimingText(bundle: ToolbarContextBundle): string {
  const lines: string[] = [];
  lines.push('# Context bundle');
  lines.push(`doc: ${bundle.docPath}`);
  if (bundle.currentPage !== null) {
    lines.push(`page: ${bundle.currentPage}${bundle.pageCount !== null ? ` of ${bundle.pageCount}` : ''}`);
  }
  if (bundle.sectionHeading) {
    lines.push(`section: ${bundle.sectionHeading}`);
  }
  if (bundle.selection) {
    const s = bundle.selection;
    const text = s.highlightedText.replace(/\s+/g, ' ').trim();
    const snippet = text.length > 280 ? `${text.slice(0, 277)}…` : text;
    lines.push(`selection (p.${s.page}): "${snippet}"`);
  } else {
    lines.push('selection: (none — operating on the whole page)');
  }
  if (bundle.nearbyComments.length > 0) {
    lines.push('nearby comments:');
    for (const c of bundle.nearbyComments) {
      const body = (c.body || c.highlightedText).replace(/\s+/g, ' ').trim();
      const snippet = body.length > 160 ? `${body.slice(0, 157)}…` : body;
      lines.push(`  - [${c.engagementLevel}/${c.status}] p.${c.page}: ${snippet}`);
    }
  }
  lines.push('');
  if (bundle.userPrompt.trim().length > 0) {
    lines.push('# User intent');
    lines.push(bundle.userPrompt.trim());
  }
  return lines.join('\n');
}

function buildCreateContextPriming(params: WorkerStartParams): string {
  const head: string[] = [];
  head.push('[Worker spawn — Create Context. Use the /review-pdf-to-latex skill.]');
  const mode = params.mode ?? { kind: 'single-shot' };
  if (mode.kind === 'ralph-loop') {
    head.push(`[Ralph loop mode — iterate this prompt ${mode.iterations} times, ` +
      `reporting progress on each iteration via the §9.2.7 [β] marker grammar ` +
      `(e.g., "[β] kind=progress phase=ralph done=K total=${mode.iterations}").]`);
  } else {
    head.push('[Single-shot mode — answer the user interactively. ' +
      'You MAY emit [β] kind=status text="..." markers to surface progress in the inline strip.]');
  }
  head.push('');
  head.push(bundleToPrimingText(params.bundle));
  return head.join('\n');
}

function buildSlingPriming(params: WorkerStartParams): string {
  const destination = params.destination ?? 'reviewer/';
  const subjectPrefix = params.subjectPrefix ?? 'review-pdf sling';
  const head: string[] = [];
  head.push(`[Worker spawn — Sling. Forward this context bundle to ${destination} ` +
    `via \`gt mail send\`. Use --type task --priority 2 --subject "${subjectPrefix}" ` +
    `and pipe the bundle JSON to --stdin. Report progress via [β] markers ` +
    `(kind=status text="sending..." → kind=done text="sent" on success).]`);
  head.push('');
  head.push(bundleToPrimingText(params.bundle));
  return head.join('\n');
}

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
  let cwd = params.docSourceDir;
  if (!cwd || !existsSync(cwd)) cwd = dirname(app.getPath('userData'));

  const env = buildPtyEnv(reviewer);
  const cols = Math.max(20, params.cols ?? 100);
  const rows = Math.max(5, params.rows ?? 24);

  // AJB ask: default to --dangerously-skip-permissions so a fresh source dir
  // doesn't stall the pane on the trust prompt. Toggle in Settings to opt
  // back into per-directory prompts (params.dangerouslySkipPermissions = false).
  const skipPerms = params.dangerouslySkipPermissions !== false;
  const claudeArgs: string[] = skipPerms ? ['--dangerously-skip-permissions'] : [];

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

  // Priming. Same delay rationale as the conv pty — give claude time to render
  // its initial prompt. Slash-command first, then the bundle as a follow-up
  // message. The bundle goes in as a single (multi-line) message so claude
  // sees it as one user turn.
  const primingText =
    params.kind === 'sling'
      ? buildSlingPriming(params)
      : buildCreateContextPriming(params);

  setTimeout(() => {
    if (!workerHandles.has(workerId)) return;
    try { p.write('/review-pdf-to-latex\r'); } catch { /* pty closed */ }
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
  }, 500);

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
  reviewerProbeCache = null;
}
