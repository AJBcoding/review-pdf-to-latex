// Embedded Claude pane: conversational pty, toolbar/worker ptys, reviewer
// probe, and progress markers, shared between Electron main, preload, and
// renderer. This is the §9.2 pty concern carved out of the former
// shared/types.ts god-file (roadmap X3). Keep this surface minimal.

import type { EngagementLevel, CommentStatus } from './comments';

// ─── §9.2 pty surface — types ─────────────────────────────────────────────

/** Result of probing for gas-town integration. `enabled: true` means we
 *  found `gt` on PATH and `gt --version` exited 0. The optional `identity`
 *  is the output of `gt whoami` — best-effort; null when the call fails or
 *  hasn't been run. */
export type ReviewerProbe =
  | {
      enabled: true;
      gtPath: string;
      version: string;
      identity: string | null;
    }
  | {
      enabled: false;
      reason: 'no_gt' | 'gt_failed';
      gtPath?: string;
      exitCode?: number | null;
    };

/** Args for `pty:start`. The renderer hands us the cwd to anchor the spawn
 *  in (§9.2.9). Cols/rows come from the renderer's initial xterm.js fit so
 *  the priming output renders without a reflow on first frame. */
export interface PtyStartParams {
  /** Absolute path of the directory the conversational pty should cwd into.
   *  Per §9.2.9 = source dir of the currently-open PDF. */
  docSourceDir: string;
  cols?: number;
  rows?: number;
  /** Pass `--dangerously-skip-permissions` to the claude CLI. Default is
   *  true (matches the user's gas-town workflow — fresh cwd doesn't stall
   *  on the trust prompt). Set false to opt back into per-directory prompts.
   *  Persisted via AppStateFile.claude_dangerous_skip_permissions. */
  dangerouslySkipPermissions?: boolean;
}

export type PtyStartResult =
  | {
      ok: true;
      already_running: boolean;
      cwd: string;
      reviewer: ReviewerProbe;
    }
  | {
      ok: false;
      reason: 'claude_not_found';
    }
  | {
      ok: false;
      reason: 'spawn_failed';
      error: string;
    }
  | {
      ok: false;
      reason: 'no_window';
    };

/** A chunk of stdout/stderr from the pty. `generation` lets the renderer
 *  ignore late data from a previously-killed pty (e.g., if a kill + restart
 *  raced a final write from the doomed process). */
export interface PtyDataEvent {
  generation: number;
  data: string;
}

export interface PtyExitEvent {
  generation: number;
  exitCode: number;
  signal: number | null;
}

// ─── §9.2.6 toolbar / worker ptys (rev-1md.3) ─────────────────────────────
//
// Three toolbar buttons above the conversational pty spawn worker ptys
// (Create Context, Sling) or respawn the conv pty (Fresh Start). The bundle
// shape is consistent across all three — the rig-side priming language
// differs by kind.

/** Context bundle assembled by the renderer at toolbar-invocation time.
 *  Passed to main when spawning the worker; main stringifies it into the
 *  worker's priming message. Section heading detection is best-effort:
 *  null when the PDF doesn't have a parseable text layer. */
export interface ToolbarContextBundle {
  /** Source PDF absolute path. */
  docPath: string;
  /** 1-indexed currently-visible page. Null when no doc loaded. */
  currentPage: number | null;
  pageCount: number | null;
  /** Highlighted selection at the time of invocation. Null when nothing
   *  was selected — the bundle is still useful for whole-page work. */
  selection:
    | {
        page: number;
        region: { x: number; y: number; w: number; h: number };
        highlightedText: string;
      }
    | null;
  /** Best-effort surrounding section heading. Null in v1 (PDF structure
   *  parsing deferred); kept in the schema so the rig-side priming language
   *  can stay stable across versions. */
  sectionHeading: string | null;
  /** Comments on the current page (every status, every level). Capped at
   *  the renderer side so the priming text stays readable. */
  nearbyComments: Array<{
    id: string;
    engagementLevel: EngagementLevel;
    body: string;
    page: number;
    highlightedText: string;
    status: CommentStatus;
  }>;
  /** User-typed prompt from the modal. May be empty for Fresh Start. */
  userPrompt: string;
}

/** Create Context mode: a normal interactive session, or a Ralph loop the
 *  agent runs N times. Iteration management is a priming-instruction
 *  contract — the agent reads "iterate N times" and self-paces. */
export type CreateContextMode =
  | { kind: 'single-shot' }
  | { kind: 'ralph-loop'; iterations: number };

/** Worker-pty kinds. The kind drives the priming message shape; otherwise
 *  workers are uniform (one claude subprocess each, IPC parity with the
 *  conversational pty modulo addressing by workerId). */
export type WorkerKind = 'create-context' | 'sling';

export interface WorkerStartParams {
  kind: WorkerKind;
  /** Unique id minted by main (uuid). Renderer uses it for input/resize/kill
   *  and to match data/exit events. */
  workerId?: string;
  /** Working dir at spawn time — same source-dir rule as the conv pty. */
  docSourceDir: string;
  cols?: number;
  rows?: number;
  /** Same flag as conversational pty — defaults true; set false to opt back
   *  into per-directory permission prompts. */
  dangerouslySkipPermissions?: boolean;
  /** §9.2.6 bundle. */
  bundle: ToolbarContextBundle;
  /** Create Context only. Ignored for sling workers. */
  mode?: CreateContextMode;
  /** Sling only. Destination rig-id (`reviewer/`, a rig like
   *  `report-engine/anthony`, a crew, or `mayor`). Required for sling. */
  destination?: string;
  /** Sling only. Subject prefix for the gt-mail send the worker will run.
   *  Defaults to a `review-pdf sling · <doc>` line. */
  subjectPrefix?: string;
}

export type WorkerStartResult =
  | {
      ok: true;
      workerId: string;
      cwd: string;
      reviewer: ReviewerProbe;
    }
  | {
      ok: false;
      reason:
        | 'claude_not_found'
        | 'spawn_failed'
        | 'no_window'
        | 'limit_exceeded'
        | 'no_gt';
      error?: string;
    };

/** Limit on simultaneous worker ptys. Each holds an open claude subprocess +
 *  pty file descriptor; the cap protects against accidental fan-out (a stuck
 *  Ralph loop user spamming Create Context). γ panel surfaces newer spawns
 *  beyond MAX_WORKER_TABS without tabs; main rejects past this absolute cap. */
export const MAX_WORKER_PTYS = 16;
/** Tab strip cap (§9.2.7). Spawns beyond this are γ-only. */
export const MAX_WORKER_TABS = 3;

export interface WorkerDataEvent {
  workerId: string;
  data: string;
}

export interface WorkerExitEvent {
  workerId: string;
  exitCode: number;
  signal: number | null;
}

/** §9.2.7 inline progress markers — the rig-side skill emits these on its
 *  own line as the agent moves through structured work; main parses them out
 *  of the worker's stdout stream and surfaces them to the renderer so the β
 *  strip can show "applied 4 of 12 (§3.1)" without showing the raw bytes.
 *
 *  Wire format (one per line, prefix `[β]`):
 *    [β] kind=progress phase=apply done=4 total=12 label="§3.1"
 *    [β] kind=status   text="awaiting build"
 *    [β] kind=done     text="redraft applied"
 *    [β] kind=error    text="build failed: missing reference"
 *
 *  Parsing degrades gracefully — unparsed `[β]` lines are dropped (not
 *  forwarded to the terminal data stream OR the progress channel). */
export interface WorkerProgressEvent {
  workerId: string;
  marker: WorkerProgressMarker;
}

export type WorkerProgressMarker =
  | {
      kind: 'progress';
      phase: string;
      done: number;
      total: number;
      label: string | null;
    }
  | { kind: 'status'; text: string }
  | { kind: 'done'; text: string | null }
  | { kind: 'error'; text: string };

/** §9.2.6 Fresh Start — kill conv pty + respawn with a handoff priming. */
export interface FreshStartParams {
  /** Handoff summary the user typed in the modal. Wrapped in a bracketed
   *  priming line right after the standard slash-command activation. */
  handoffNotes: string;
  docSourceDir: string;
  cols?: number;
  rows?: number;
  /** Same flag as conversational pty — defaults true; set false to opt back
   *  into per-directory permission prompts. */
  dangerouslySkipPermissions?: boolean;
}

export type FreshStartResult =
  | { ok: true; cwd: string; reviewer: ReviewerProbe }
  | { ok: false; reason: 'claude_not_found' | 'spawn_failed' | 'no_window'; error?: string };
