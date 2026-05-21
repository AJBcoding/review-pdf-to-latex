// §9.2 — embedded Claude pane: pty manager.
//
// Owns the conversational pty (one global per app instance, persistent across
// doc switches) and worker ptys (ephemeral, per-task). Workers' spawn UI is
// in rev-1md.3 (toolbar); this module exposes the plumbing.
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

import { BrowserWindow, ipcMain, app } from 'electron';
import { spawn as spawnSync, spawnSync as spawnSyncBlocking } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type {
  PtyExitEvent,
  PtyStartParams,
  PtyStartResult,
  ReviewerProbe,
} from '@shared/types';

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

function spawnConversational(
  webContents: Electron.WebContents,
  params: PtyStartParams,
): PtyStartResult {
  // Idempotent: if a pty is already alive for this webContents, return its
  // shape. Renderer should call start once on first PDF open; later calls
  // (e.g., after a Restart click) get a fresh pty via killAll + start.
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
  // back to userData if the source path doesn't resolve (e.g., the PDF was
  // already deleted by the time we get here).
  let cwd = params.docSourceDir;
  if (!cwd || !existsSync(cwd)) cwd = dirname(app.getPath('userData'));

  // Build argv. Plain claude in the standalone/no-gt case. When gt is enabled,
  // we still run claude directly — wrapping in `gt rig run` would block on
  // gt-town infrastructure and the spec only requires the pty have a Reviewer
  // *identity*, not be a subordinate rig process. We inject the identity via
  // env vars that gas-town reads (GT_RIG); skills emit results into the
  // Reviewer rig's namespace.
  const file = claudeBin;
  const args: string[] = [];

  const env: Record<string, string> = {
    // Inherit current env. Avoids breaking PATH-dependent tooling Claude
    // invokes for tool-calls (uv, python, etc.). Use a string-typed clone
    // to satisfy node-pty's IBasePtyForkOptions['env'] shape.
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    // node-pty needs TERM to be sane; xterm-256color is what xterm.js
    // advertises and what most CLI tools handle correctly.
    TERM: 'xterm-256color',
  };
  if (reviewer.enabled) {
    // Tag the session as the global Reviewer rig (§9.2.5). The skill side
    // reads GT_RIG to gate destructive ops to its own rig namespace.
    env.GT_RIG = 'reviewer';
  }

  // Conservative initial size; xterm.js sends a resize on first fit.
  const cols = Math.max(20, params.cols ?? 80);
  const rows = Math.max(5, params.rows ?? 24);

  let p: IPty;
  try {
    p = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      // utf8 default — Claude renders unicode, file paths, etc.
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

  // Skill priming (§9.2.3). Inject the slash-command after a short delay so
  // claude has rendered its initial prompt and is ready to accept input. The
  // priming line is visible in scrollback for auditing.
  // Why 500ms: empirically, claude shows its first prompt within ~200-400ms
  // on a warm system; 500ms keeps the priming reliably *after* the prompt
  // banner without being noticeably slow on the user side.
  setTimeout(() => {
    if (convHandle !== handle) return;
    try { p.write('/review-pdf-to-latex\r'); } catch { /* pty closed */ }
  }, 500);

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

// ─── IPC wiring ───────────────────────────────────────────────────────────

export function registerClaudePtyIpc(): void {
  ipcMain.handle('pty:probeReviewer', (): ReviewerProbe => probeReviewer());

  ipcMain.handle('pty:start', (event, params: PtyStartParams): PtyStartResult => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: 'no_window' };
    return spawnConversational(event.sender, params);
  });

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

  ipcMain.handle('pty:kill', () => {
    killConversational();
    return { ok: true } as const;
  });
}

/** Tear down on app quit. Safe to call repeatedly. */
export function shutdownClaudePty(): void {
  killConversational();
}

/** Test seam — clear the binary + reviewer caches. Used by future integration
 *  tests; no production caller. */
export function _resetCachesForTests(): void {
  claudeBinaryCache = undefined;
  reviewerProbeCache = null;
}

// Silence linter for the unused spawnSync alias (kept for future worker pty
// non-blocking probes).
export const _unusedSpawn = spawnSync;
