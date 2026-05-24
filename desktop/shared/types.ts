// Types shared between Electron main, preload, and renderer.
// Keep this surface minimal — add types here only when both sides genuinely need them.

export type ResolutionStep =
  | 'env_override'
  | 'path'
  | 'repo_venv'
  | 'home_venv';

export interface ResolutionAttempt {
  step: ResolutionStep;
  path: string;
}

/**
 * Result of a single engine subprocess invocation. Discriminated union — callers
 * branch on `ok` first, then on `reason` for failure cases. See spec §13.1.
 */
export type EngineResult =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: 'not_found';
      triedPaths: ResolutionAttempt[];
    }
  | {
      ok: false;
      reason: 'spawn_failed';
      error: string;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: 'failed';
      stdout: string;
      stderr: string;
      exitCode: number | null;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: 'timeout';
      resolvedPath: string;
      timeoutMs: number;
    };

/**
 * Pre-flight health report for a PDF, returned by `review-pdf pdf-health --json`.
 * Schema mirrors the engine's `pdf_health.py` output (schema_version 1).
 * See ux-spec §5.2 + design-spec §8.
 */
export interface PdfHealthReport {
  schema_version: 1;
  pdf_path: string | null;
  total_pages: number | null;
  readable_pages: number[];     // 1-indexed; pages with usable text
  unreadable_pages: number[];   // 1-indexed; zero glyphs, CID-only, or errored
  ligature_loss_detected: boolean;
  encrypted: boolean;
  producer: string | null;
  creator: string | null;
  page_errors: { page: number; error: string }[];
  error: string | null;         // set when the whole document failed to open
}

/**
 * Calling pdfHealth(path) returns either the parsed report (whether or not
 * the PDF is healthy — the report itself describes the state), or a structured
 * failure when the subprocess itself didn't complete (engine not found, spawn
 * error, timeout, etc).
 */
export type PdfHealthResult =
  | { ok: true; report: PdfHealthReport; exitCode: number; resolvedPath: string }
  | { ok: false; reason: 'engine_failed'; engine: EngineResult };

/**
 * Result of reading a PDF file from disk into renderer memory.
 * The renderer is sandboxed and can't access the filesystem directly;
 * main reads the bytes and ships them across the IPC boundary.
 *
 * `sha256` is the hex digest of the bytes — used as `doc_version` for
 * drafts persistence (§10.3) and as the drafts filename. Computed in main
 * because we already have the buffer there.
 */
export type ReadPdfBytesResult =
  | { ok: true; bytes: Uint8Array; resolvedPath: string; sha256: string }
  | { ok: false; reason: 'not_found' | 'not_a_file' | 'read_failed'; resolvedPath: string; error?: string };

/** Result of the native open-file dialog. `path === null` means the user
 * canceled — distinct from any error state. */
export interface OpenPdfDialogResult {
  path: string | null;
}

/**
 * §8 comment payload. Built by the renderer on submit, persisted to
 * `<pdf-dir>/.review-state/drafts/<sha256>.json` by main.
 */
export type EngagementLevel = 'comment' | 'redraft' | 'surface';

/** §8.5 status enum. `open` is the renderer's only writer; everything from
 *  `submitted` onward is written by Submit (rev-1md.4) or by the results-file
 *  watcher (rev-1md.5) reflecting the rig's terminal dispositions. */
export type CommentStatus =
  | 'open'
  | 'submitted'
  | 'applied'
  | 'deferred'
  | 'needs-followup'
  | 'rejected'
  | 'build_failed';

/** Anchor region — shared by `CommentPayload.anchor` and the optional
 *  `new_anchor` written by the rig when a redraft moved text. */
export interface AnchorRegion {
  page: number;
  region: { x: number; y: number; w: number; h: number };
}

export interface CommentPayload {
  id: string;
  doc_id: string;
  doc_version: string;
  anchor: AnchorRegion;
  highlighted_text: string;
  comment: string;
  redraft: string | null;
  /** Agent's proposed redraft from live-redraft (§10.2). Distinct from the
   *  user's own `redraft` field. Null until a live-redraft result lands. */
  redraft_suggestion: string | null;
  engagement_level: EngagementLevel;
  author: string;
  kind: 'comment';
  status: CommentStatus;
  created_at: string;
  /** Set when Submit promotes this comment to a submit file (rev-1md.4). */
  submitted_at?: string | null;
  /** Set by the rig in results-<ts>.json: free-text note explaining the
   *  disposition (build error excerpt, why it's a thesis problem, etc.). */
  agent_note?: string | null;
  /** Set by the rig when an `applied` redraft moved the underlying text and
   *  the comment's logical anchor changed. The original `anchor` is kept
   *  alongside this so re-raised v1.1 comments can point to the new location. */
  new_anchor?: AnchorRegion | null;
  /** When a v1.1 comment is seeded from a v1.0 `deferred` / `needs-followup`
   *  result, this is the original comment's id (§8.5 round-trip re-raise). */
  derived_from?: string | null;
  /** PDF-only: links this comment to the corresponding annotation in the
   *  rendered bundle PDF (§10.4). Written by Submit; not used by the watcher. */
  pdf_annotation_id?: string | null;
}

/** Anchor kind discriminator — determines which anchor strategy the sidecar's
 *  comments use. Existing sidecars without `anchor_kind` default to `'pdf-glyph-rect'`. */
export type AnchorKind = 'pdf-glyph-rect' | 'md-fuzzy-snippet';

/** Content fingerprint stored in the sidecar for rename-recovery. When a file
 *  is moved or renamed, the path-based sidecar lookup misses; the migration
 *  code scans for a fingerprint match and offers to relink. */
export interface DocFingerprint {
  title_from_frontmatter: string | null;
  first_500_chars_sha256: string;
  anchor_count: number;
  last_known_path: string;
}

/**
 * On-disk drafts schema. Snapshot (not append-only): main rewrites the full
 * file on every save. Renderer debounces writes 250ms per spec §10.3.
 */
export interface DraftsFile {
  schema_version: 1;
  doc_version: string;
  comments: CommentPayload[];
  anchor_kind?: AnchorKind;
  doc_fingerprint?: DocFingerprint;
}

/** Read result. `not_found` is normal (no drafts yet) — caller treats it as
 *  "start with empty array", not an error. Distinct from `read_failed`. */
export type DraftsReadResult =
  | { ok: true; file: DraftsFile; filePath: string }
  | { ok: true; file: null; filePath: string; reason: 'not_found' }
  | { ok: false; reason: 'read_failed' | 'parse_failed'; filePath: string; error: string };

export type DraftsWriteResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'write_failed' | 'mkdir_failed'; filePath: string; error: string };

// ─── §10.3 submit + results files ─────────────────────────────────────────
//
// Submit file: frozen audit copy of the comments sent to the rig in one round.
// Written by Submit (rev-1md.4); read by the rig and by the watcher (to
// disambiguate which doc a results file belongs to — sha256 lives here, not
// in the results file).
export interface SubmitFile {
  schema_version?: 1;
  submit_id: string;
  doc_id: string;
  /** sha256 of the source-file bytes at submit time. The watcher matches this
   *  against the currently-open doc's sha256 to decide whether a results file
   *  in the same `.review-state/` dir applies to the open doc. */
  doc_version: string;
  source_file_version: string;
  submitted_at: string;
  origin_rig: string | null;
  bundle_pdf?: string;
  bundle_json?: string;
  comments: CommentPayload[];
}

/** Per-comment terminal status the rig writes into `results-<ts>.json`.
 *  Note this is narrower than `CommentStatus` — the rig can't return `open`
 *  or `submitted`; those are app-side states. */
export type ResultEntryStatus =
  | 'applied'
  | 'deferred'
  | 'needs-followup'
  | 'rejected'
  | 'build_failed';

export interface ResultEntry {
  id: string;
  status: ResultEntryStatus;
  /** Required when `status === 'rejected'`; explains why the rig declined to
   *  apply. Spec §10.3. */
  reason?: string;
  /** Set when an `applied` redraft moved text and the comment's anchor
   *  position changed. Carried into the comment via `new_anchor`. */
  new_anchor?: AnchorRegion | null;
  /** Free-text agent commentary: build-error excerpt for `build_failed`,
   *  redirect-to-L3 advice for `needs-followup`, terse confirmation for
   *  `applied`, etc. */
  agent_note?: string | null;
}

export type RoundStatus = 'in_progress' | 'complete' | 'failed';

/** Results file written by the rig in `.review-state/results-<ts>.json`.
 *  Mutates as the rig processes (per-comment atomic append); `round_status`
 *  flips `in_progress` → `complete` / `failed` at round end. */
export interface ResultsFile {
  schema_version?: 1;
  submit_id: string;
  results_id: string;
  round_status: RoundStatus;
  started_at: string;
  completed_at: string | null;
  /** Path of the new versioned source file the rig wrote at round end (§10.6).
   *  Null until `round_status: complete`. Drives the "open new version" CTA. */
  new_source_path: string | null;
  /** Human-facing version label (e.g., `"1.1"`). Informational. */
  version_chosen: string | null;
  results: ResultEntry[];
}

/** Event main pushes to renderer when a results file is created / modified.
 *  `submit` is the matched submit file (needed to verify doc_version) — null
 *  if the submit file couldn't be found / parsed; in that case `matchesDoc`
 *  is false and the renderer should ignore this event. */
export interface ResultsEvent {
  /** Absolute path of the results-*.json file. */
  filePath: string;
  results: ResultsFile;
  submit: SubmitFile | null;
  /** True when the matched submit file's doc_version equals the currently
   *  watched doc's sha256 — i.e., this results file applies to this doc. */
  matchesDoc: boolean;
  /** `initial`: discovered during the scan that happens on watchStart.
   *  `change`: detected after watchStart via fs.watch. The renderer uses
   *  this to distinguish "previous round was interrupted — resume?" (initial
   *  scan finding round_status:in_progress) from a live update of the round
   *  currently being processed. */
  source: 'initial' | 'change';
}

export interface ResultsWatchStartResult {
  ok: boolean;
  /** Resolved `.review-state/` directory. Returned even when ok:false so the
   *  renderer can surface a useful diagnostic. */
  reviewStateDir: string;
  reason?: 'enoent' | 'watch_failed';
  error?: string;
}

/** Native folder picker (§3.1 — single root the tree is scoped to).
 *  `path === null` means the user canceled. */
export interface OpenFolderDialogResult {
  path: string | null;
}

/** Kinds the tree distinguishes. `pdf` opens in the middle pane; `md`/`docx`
 *  are reserved for later milestones (currently fall under `other`); `other`
 *  renders dimmed and inert (§3.2). */
export type FileKind = 'pdf' | 'md' | 'docx' | 'other';

/** One entry returned by `fs:listDir`. The tree never auto-recurses — folders
 *  are listed on expand to keep large repos snappy. */
export interface DirEntry {
  name: string;
  path: string;       // absolute
  isDir: boolean;
  /** True when the entry is a dotfile OR matches the §3.2 hardcoded ignore
   *  list (`.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`).
   *  The renderer filters these out unless "show hidden" is on. */
  isHidden: boolean;
  kind: FileKind;
}

export type ListDirResult =
  | { ok: true; entries: DirEntry[]; path: string }
  | { ok: false; reason: 'not_a_dir' | 'not_found' | 'read_failed'; path: string; error: string };

/** Recursive PDF index for the §3.5 quick-open palette. Eagerly built when a
 *  root is opened; refreshed on demand (no filesystem watching in v1). Skips
 *  the same hidden-by-default dirs the tree skips, with no override — Cmd+P
 *  is for the user's documents, not their dependency tarballs. */
export interface IndexedPdf {
  path: string;       // absolute
  name: string;       // basename
  /** Path relative to the root, including the basename. Drives the palette's
   *  "src/docs/foo.pdf" display + the fuzzy match. */
  relPath: string;
}

export type IndexPdfsResult =
  | { ok: true; root: string; pdfs: IndexedPdf[] }
  | { ok: false; reason: 'not_a_dir' | 'not_found' | 'read_failed'; root: string; error: string };

/** §3.3 persisted state — root + last-opened doc + tree-expansion state +
 *  the "show hidden" toggle so it survives restart. Stored at
 *  `~/Library/Application Support/<app>/state.json` on macOS via
 *  `app.getPath('userData')`. */
export interface AppStateFile {
  schema_version: 1;
  root: string | null;
  last_opened_doc: string | null;
  /** Absolute paths of folders the user has expanded in the tree. Set
   *  semantics; main writes deduped + sorted. */
  expanded_dirs: string[];
  show_hidden: boolean;
  /** Whether the left drawer (file tree) is collapsed to a thin strip.
   *  Persisted so the user's preference survives restart. */
  left_drawer_collapsed?: boolean;
  /** Whether to pass `--dangerously-skip-permissions` when spawning the
   *  embedded claude pty. Defaults to true (no per-directory trust prompts);
   *  set false in Settings to opt back in. */
  claude_dangerous_skip_permissions?: boolean;
  /** Persisted pane widths from the splitter gutters. All fields optional;
   *  defaults (240 / 440 / 50%) apply when missing. Clamped on apply.
   *  Sizes are CSS pixels. */
  layout_widths?: {
    col_left?: number;
    col_right?: number;
    rd_comments_h?: number;
  };
  /** §10.5.1 — originating rig per source-doc path. Populated when the app
   *  is launched via `review-pdf-app open <path> --from <rig-id>`; survives
   *  app restart so re-opening the same doc still routes Submit to the same
   *  rig. Per-doc keying matches the spec's "per doc" picker memory. */
  origin_rig_per_doc?: Record<string, string>;
  /** §10.5 — most-recently-used rig destinations for the picker, newest
   *  first. Capped at MAX_RECENT_RIGS in the renderer; main writes verbatim. */
  recent_rigs?: string[];
  /** §10.5 — last picked destination per source-doc path. Drives the
   *  picker's "same doc, same default" behavior. Stores the destination
   *  rig-id literal (e.g., `"reviewer-local"`, `"report-engine/anthony"`). */
  last_destination_per_doc?: Record<string, string>;
}

export type AppStateReadResult =
  | { ok: true; state: AppStateFile; filePath: string }
  /** First launch (or state.json was deleted) — caller starts fresh. */
  | { ok: true; state: null; filePath: string; reason: 'not_found' }
  | { ok: false; reason: 'read_failed' | 'parse_failed'; filePath: string; error: string };

export type AppStateWriteResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'write_failed' | 'mkdir_failed'; filePath: string; error: string };

// ─── §10.4 bundle artifact ────────────────────────────────────────────────
//
// Bundle = PDF (annotations on a copy of source) + JSON sidecar, dated,
// in the source directory. Renderer asks main to write both on Cmd+S and
// Cmd+Return; rev-1md.4 layers the gt-mail sling on top of the same write.

/** §10.4 JSON sidecar — frozen snapshot of the draft as written to disk
 *  alongside the rendered PDF. The PDF is a one-way derivative; the JSON
 *  is the source of truth for round-trip restore. */
export interface BundleJsonFile {
  schema_version: 1;
  bundle_id: string;
  created_at: string;     // ISO 8601 UTC
  app_version: string;
  author: string;
  source: {
    filename: string;
    absolute_path: string;
    sha256: string;
    source_file_version: string | null;  // null when filename has no version
    page_count: number;
  };
  rendered_pdf: {
    filename: string;
    sha256: string;
  };
  comments: CommentPayload[];
}

/** What the renderer hands main to write a bundle. Main computes the
 *  filenames, mints bundle_id, lays down annotations, computes the
 *  rendered PDF sha256, and writes both files atomically. */
export interface BundleWriteRequest {
  /** Absolute path to the source PDF. The bundle goes next to it. */
  sourcePath: string;
  /** sha256 of the source bytes — already on hand in the renderer. */
  sourceSha256: string;
  /** Page count of the source — already known by the renderer (PDF.js). */
  pageCount: number;
  /** Live comments to embed in the JSON sidecar + render as PDF annotations.
   *  Cmd+S writes comments with their current status (typically `open`);
   *  Submit (rev-1md.4) will pass the same comments after promoting them
   *  to `submitted`. The writer doesn't mutate statuses — that's the
   *  caller's contract. */
  comments: CommentPayload[];
  /** App version for the JSON sidecar's `app_version` field. */
  appVersion: string;
  /** Author for `(AJB edits)` is fixed in v1; we still pipe it through so
   *  the schema is honest about who wrote the bundle. */
  author: string;
}

export type BundleWriteResult =
  | {
      ok: true;
      bundleId: string;
      bundlePdfPath: string;
      bundleJsonPath: string;
      bundlePdfSha256: string;
      /** Per-comment `pdf_annotation_id` assignments. Renderer applies these
       *  back to the live drafts so the next bundle write keeps the same
       *  annotation IDs for comments that haven't changed. */
      annotationIds: { commentId: string; pdfAnnotationId: string }[];
    }
  | {
      ok: false;
      reason: 'source_not_found' | 'source_read_failed' | 'render_failed'
            | 'mkdir_failed' | 'write_failed';
      error: string;
      // Surfaced even on failure so the renderer can show "tried to write
      // <path>" in the error toast.
      bundlePdfPath: string | null;
      bundleJsonPath: string | null;
    };

// ─── §10.1 Submit flow — promote draft, sling via gt mail, abandon ──────
//
// Three IPC surfaces:
//   submit:promote    → write `.review-state/submit-<ts>.json` from current
//                       draft, flip its open entries to `submitted`.
//   submit:sling      → spawn `gt mail send` with the rev-2k7 payload.
//   submit:abandonRound → rename results-<ts>.json → results-<ts>.abandoned.json
//                         (§10.1 step 6 soft tombstone semantics).

/** Reviewer-local is a virtual destination ID; the picker shows it as
 *  "Reviewer (local) — talk only, no source edits". When the rig case is
 *  off (no `--from` + no rigs picked yet), this is the only option. */
export const REVIEWER_LOCAL_ID = 'reviewer-local';

export interface SubmitPromoteRequest {
  /** Absolute path of the open source PDF. Determines `.review-state/` dir. */
  sourcePath: string;
  /** sha256 of the source bytes — pinned into the submit file as
   *  `doc_version` so the results-file watcher can pair them. */
  sourceSha256: string;
  /** Source-version parsed from the filename per §10.6 (e.g., "1.0"). Null
   *  for filenames that don't conform. */
  sourceFileVersion: string | null;
  /** Bundle metadata to embed in the submit file. The bundle should already
   *  be on disk by the time promote is called (writeBundle ran first). */
  bundlePdfPath: string;
  bundleJsonPath: string;
  /** Origin rig recorded at launch via `--from`. Null for standalone. */
  originRig: string | null;
  /** The current in-memory drafts. Entries with status:'open' (or missing)
   *  get promoted to 'submitted'; all entries are written to the submit
   *  file frozen. */
  comments: CommentPayload[];
  /** Author for the submit file's metadata. AJB in v1. */
  author: string;
}

export type SubmitPromoteResult =
  | {
      ok: true;
      submitId: string;
      submitFilePath: string;
      submitFile: SubmitFile;
      /** Per-comment status mutation the renderer mirrors back onto its
       *  in-memory drafts (so the right-drawer immediately shows
       *  "submitted" badges). Only entries that flipped are listed. */
      statusUpdates: { commentId: string; submittedAt: string }[];
    }
  | {
      ok: false;
      reason: 'mkdir_failed' | 'write_failed';
      error: string;
      submitFilePath: string | null;
    };

export interface SubmitSlingRequest {
  /** Destination rig-id. Reviewer-local routes to a `reviewer/<you>/` mailbox
   *  per §10.5; full rigs go to `<rig>/` per §10.1 step 3. */
  destinationRig: string;
  /** Origin rig recorded at launch — null for standalone. Echoed into the
   *  payload's `origin_rig` field; not used for addressing. */
  originRig: string | null;
  /** Pinned submit_id from the promote step. */
  submitId: string;
  /** Same `bundle_id` the bundle JSON sidecar carries. Lets the rig pair
   *  submit + bundle without re-parsing the JSON. */
  bundleId: string;
  /** Source-doc absolute path — frozen into the payload for the rig. */
  sourcePath: string;
  /** Submit file written by the promote step. */
  submitFilePath: string;
  /** Bundle artifacts written by writeBundle(). */
  bundlePdfPath: string;
  bundleJsonPath: string;
  /** App version frozen into the payload for the rig. */
  appVersion: string;
  /** Subject prefix the rig matches on. Defaults are wired in main; the
   *  field is exposed so tests / future versions can override. */
  subjectPrefix?: string;
}

/** Returned by the sling. The pending-send / sent-unconfirmed split lives
 *  in the renderer's state machine; main reports the raw process result. */
export type SubmitSlingResult =
  | {
      ok: true;
      /** Exit code from `gt mail send` — always 0 here (non-zero comes
       *  through `ok:false, reason:'gt_failed'`). */
      exitCode: 0;
      stdout: string;
      stderr: string;
      /** The exact JSON body main piped to gt mail's stdin — surfaced so
       *  the renderer can stash it for a "Show gt mail status" diagnostic
       *  drawer if the user needs to debug delivery. */
      payload: string;
      /** Resolved subject so it shows up in the user's gt-mail history. */
      subject: string;
    }
  | {
      ok: false;
      reason: 'no_gt';
      message: string;
    }
  | {
      ok: false;
      reason: 'spawn_failed';
      error: string;
    }
  | {
      ok: false;
      reason: 'gt_failed';
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      reason: 'timeout';
      timeoutMs: number;
    };

export interface SubmitAbandonRequest {
  /** Absolute path of `results-<ts>.json` to soft-tombstone. */
  resultsFilePath: string;
}

export type SubmitAbandonResult =
  | { ok: true; renamedTo: string }
  | { ok: false; reason: 'not_found' | 'rename_failed'; error: string };

/** Existence check used at launch: a remembered root that's been moved/deleted
 *  shouldn't crash the boot path — we just clear it and show the empty state. */
export type PathExistsResult =
  | { ok: true; exists: boolean; isDir: boolean; isFile: boolean; path: string }
  | { ok: false; reason: 'stat_failed'; path: string; error: string };

// ─── M-md-3 file write + watch ───────────────────────────────────────────

export type WriteFileTextResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'mkdir_failed' | 'write_failed'; filePath: string; error: string };

export interface FileChangeEvent {
  filePath: string;
  kind: 'change' | 'rename';
}

export interface ElectronAPI {
  // Smoke-test echo, retained from the empty-shell milestone.
  ping(message: string): Promise<string>;
  // Spawns `review-pdf --version` and returns a structured result.
  // Used by the renderer at startup to confirm the engine is reachable.
  engineVersion(): Promise<EngineResult>;
  // Spawns `review-pdf pdf-health --pdf <path> --json` and parses stdout
  // into a typed PdfHealthReport. The renderer calls this at PDF-load time
  // to drive the §5.2 load-time banner.
  pdfHealth(pdfPath: string): Promise<PdfHealthResult>;
  // Reads a PDF file from disk and returns its bytes. The renderer feeds
  // these to `pdfjsLib.getDocument({data})`. Paths are resolved relative
  // to the main process's cwd (the desktop/ dir during dev).
  readPdfBytes(pdfPath: string): Promise<ReadPdfBytesResult>;
  // Shows the native open-file dialog filtered to PDFs. Returns the picked
  // path, or null if the user canceled.
  openPdfDialog(): Promise<OpenPdfDialogResult>;
  // Reads `<dir-of-pdfPath>/.review-state/drafts/<sha256>.json`. A missing
  // file is the normal first-open case, not an error.
  readDrafts(pdfPath: string, sha256: string): Promise<DraftsReadResult>;
  // Writes the snapshot atomically (temp file + rename). Mkdir -p the
  // drafts dir first. Renderer debounces calls 250ms per spec §10.3.
  writeDrafts(pdfPath: string, sha256: string, file: DraftsFile): Promise<DraftsWriteResult>;
  // Flush handshake: main asks the renderer to drain its pending drafts
  // debounce before window close / app quit; renderer flushes, then acks
  // with the same id. Without this, a Cmd+Q within 250ms of a submit
  // loses the comment (debounce hasn't fired yet — see rev-cm6).
  // Returns an unsubscribe fn so callers can detach (the renderer wires
  // this once at boot and leaves it attached for the process lifetime).
  onDraftsFlushRequest(cb: (id: string) => void): () => void;
  sendDraftsFlushAck(id: string): void;

  // §3.1 — native folder picker. Sets the tree's root; previous root is
  // discarded (Obsidian model; not a multi-root workspace).
  openFolderDialog(): Promise<OpenFolderDialogResult>;
  // §3.2 — non-recursive directory listing. Folders are listed on-expand
  // so opening a large repo doesn't read the whole tree up front.
  listDir(path: string): Promise<ListDirResult>;
  // §3.3 — boot-time existence check for the remembered root. We don't
  // surface filesystem errors as crashes here; a missing root just falls
  // back to the empty-tree + "Open Folder…" prompt.
  pathExists(path: string): Promise<PathExistsResult>;
  // §3.3 — persisted app state (root + last doc + expansion set + show-hidden).
  // Snapshot semantics: main rewrites the whole file on each save, atomically.
  readAppState(): Promise<AppStateReadResult>;
  writeAppState(state: AppStateFile): Promise<AppStateWriteResult>;
  // §3.5 — recursive PDF index for Cmd+P. Eagerly walked under the current
  // root, honoring the hidden-by-default ignore list. No live filesystem
  // watching in v1; renderer can call this again on demand.
  indexPdfs(root: string): Promise<IndexPdfsResult>;

  // M-md-3 — write text content to disk (for .md save). Atomic via tmp+rename.
  writeFileText(filePath: string, content: string): Promise<WriteFileTextResult>;
  // M-md-3 — watch a file for external changes. Renderer calls this when
  // opening an editable .md; main pushes `file:change` events. Call
  // unwatchFile to stop (or it stops automatically on next watchFile call).
  watchFile(filePath: string): Promise<void>;
  unwatchFile(): Promise<void>;
  onFileChange(cb: (event: FileChangeEvent) => void): () => void;
  suppressFileWatch(): void;

  // §3.4 — main pushes the renderer a request to open a specific document
  // (from a CLI shim arg, second-instance argv, or reviewpdf:// URL).
  // Renderer pivots the middle pane to the doc; per §10.3 the prior doc's
  // draft state is preserved by the existing loadPdf flow.
  //
  // `from` carries the originating rig recorded via `review-pdf-app open
  // <path> --from <rig-id>` (§10.5.1). Null when invoked without the flag
  // (standalone case). The renderer persists this into AppState so subsequent
  // doc opens recover the origin even after restart.
  onOpenExternalFile(cb: (event: { path: string; from: string | null }) => void): () => void;

  // §10.1 step 6 + §10.3 — start watching `.review-state/` next to the
  // currently-open doc for new/changed results-*.json files. Renderer calls
  // this immediately after loadPdf completes (sha256 in hand). Switching
  // docs calls watchStop first, then watchStart against the new doc. Main
  // does an initial scan of pre-existing results files (the "resume?"
  // banner) before returning, so events for in-progress rounds will already
  // be flowing by the time this resolves.
  watchResultsStart(pdfPath: string, sha256: string): Promise<ResultsWatchStartResult>;
  watchResultsStop(): Promise<void>;
  onResultsEvent(cb: (event: ResultsEvent) => void): () => void;

  // §10.4 — write the dated bundle artifact (PDF + JSON sidecar) next to
  // the source PDF. Used by Cmd+S (Export Bundle) and as the first step of
  // Cmd+Return (Submit, rev-1md.4). Multiple writes on the same date
  // overwrite the same files; a new date produces a new dated bundle and
  // leaves yesterday's as audit trail.
  writeBundle(request: BundleWriteRequest): Promise<BundleWriteResult>;

  // ─── §10.1 Submit flow (rev-1md.4) ──────────────────────────────────────
  // Promote the live draft to a frozen submit-<ts>.json under .review-state/.
  // Returns the submit_id and per-comment status updates so the renderer can
  // mirror them onto its in-memory drafts (right-drawer flips to "submitted").
  submitPromote(request: SubmitPromoteRequest): Promise<SubmitPromoteResult>;
  // Spawn `gt mail send` with the rev-2k7 contract payload. Stdout/stderr
  // surface in the failure case so the renderer can show verbatim gt
  // diagnostics in the persistent error banner.
  submitSling(request: SubmitSlingRequest): Promise<SubmitSlingResult>;
  // §10.1 step 6 abandon: rename results-<ts>.json → results-<ts>.abandoned.json.
  // Soft tombstone — partial results are preserved, the rig's resume guard
  // ignores the .abandoned suffix, and the app's in-memory state flips to
  // idle so Submit re-enables.
  submitAbandonRound(request: SubmitAbandonRequest): Promise<SubmitAbandonResult>;

  // ─── §9.2 embedded Claude pane (rev-1md.2) ──────────────────────────────
  // Probe gas-town presence + identity. Cached on the main side; safe to call
  // freely. Drives the Sling button's enabled/disabled state (§9.2.5).
  probeReviewer(): Promise<ReviewerProbe>;
  // Spawn the conversational pty (lazy, on first PDF open). Idempotent — a
  // second call with a pty already alive returns `already_running: true`.
  // The renderer wires onPtyData / onPtyExit BEFORE calling start so no
  // initial bytes are dropped.
  startPty(params: PtyStartParams): Promise<PtyStartResult>;
  // Write to the pty's stdin (user keystrokes from xterm.js + app-injected
  // doc-switch lines). The newline character is the caller's responsibility.
  sendPtyInput(data: string): void;
  // Propagate xterm.js's geometry to the pty. Called on every fit().
  resizePty(cols: number, rows: number): void;
  // SIGTERM the pty (SIGKILL fallback after 1.5s). Used by Fresh Start
  // (rev-1md.3) and on app quit.
  killPty(): Promise<{ ok: true }>;
  // Data stream from main → renderer. Subscribe before calling startPty.
  // Returns an unsubscribe fn.
  onPtyData(cb: (event: PtyDataEvent) => void): () => void;
  // Exit notification — fires once per spawn generation. The renderer shows
  // "Claude session ended. [Restart]" per §9.2.2.
  onPtyExit(cb: (event: PtyExitEvent) => void): () => void;

  // ─── §9.2.6 toolbar / worker ptys (rev-1md.3) ──────────────────────────
  // Spawn a worker pty (Create Context or Sling). Each has its own claude
  // subprocess pre-primed with the context bundle. Main mints a workerId
  // the renderer uses for input/resize/kill. Subscribe to onWorker* BEFORE
  // calling so the priming output isn't dropped.
  startWorkerPty(params: WorkerStartParams): Promise<WorkerStartResult>;
  workerPtyInput(workerId: string, data: string): void;
  resizeWorkerPty(workerId: string, cols: number, rows: number): void;
  killWorkerPty(workerId: string): Promise<{ ok: true }>;
  onWorkerPtyData(cb: (event: WorkerDataEvent) => void): () => void;
  onWorkerPtyExit(cb: (event: WorkerExitEvent) => void): () => void;
  // §9.2.7 β/γ progress markers — main parses `[β]` lines out of worker
  // stdout before forwarding the rest. Channel is purely additive; absence
  // of markers degrades the strip to `⟳ <task> running [log]`.
  onWorkerPtyProgress(cb: (event: WorkerProgressEvent) => void): () => void;

  // §9.2.6 Fresh Start — kill the conversational pty and respawn with a
  // handoff summary as additional priming after the standard slash-command
  // activation. The renderer re-attaches its xterm.js terminal in place.
  freshStartPty(params: FreshStartParams): Promise<FreshStartResult>;
}

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

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
