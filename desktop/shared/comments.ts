// §8 review domain — comments, drafts, submit/results round-trip, and bundle
// artifacts. Shared between Electron main, preload, and renderer. This is the
// concern that the discriminated anchor-union work (X5) lands in.

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
  /** M-md-4: fuzzy-snippet anchor for .md comments. Present when
   *  `anchor_kind === 'md-fuzzy-snippet'` on the parent DraftsFile. */
  md_anchor?: {
    char_start: number;
    char_end: number;
    prefix: string;
    suffix: string;
    quoted_text: string;
  } | null;
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
    }
  | {
      ok: false;
      reason: 'stdin_error';
      error: string;
    }
  | {
      ok: false;
      reason: 'stdin_write_failed';
      error: string;
    };

export interface SubmitAbandonRequest {
  /** Absolute path of `results-<ts>.json` to soft-tombstone. */
  resultsFilePath: string;
}

export type SubmitAbandonResult =
  | { ok: true; renamedTo: string }
  | { ok: false; reason: 'not_found' | 'rename_failed'; error: string };
