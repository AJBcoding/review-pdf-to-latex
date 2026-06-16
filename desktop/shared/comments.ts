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

/** Legacy v1 anchor region. No longer the live anchor shape (replaced by the
 *  `Anchor` union below) but retained because it is exactly the bare
 *  `{ page, region }` object that still appears on disk in v1 sidecars and on
 *  the wire in v1 `new_anchor` payloads. The migration (§3.3) and the §4.3
 *  tolerant-parse rule both read it; the v2→v1 down-converter writes it. */
export interface AnchorRegion {
  page: number;
  region: { x: number; y: number; w: number; h: number };
}

// ─── §3.1 the discriminated anchor union (M-2) ─────────────────────────────
//
// Replaces the v1 "required PDF AnchorRegion on every comment + optional
// bolted-on md_anchor + the html/docx `as any` smuggle" (C5/C6). Field names
// are normative for the v2 schema (spec §3.1). One kind per comment; each kind
// is named truthfully so the misreporting `anchorKind` getters (C6) become
// impossible by construction.

/** One highlight quad in Acrobat point order (UL, UR, LL, LR), matching the
 *  bundle.ts /QuadPoints precedent. PLURAL on the PDF kind: native annotations
 *  read back with per-line quads even though the shipped writer is single-bbox
 *  (spike S-2, §8) — the model must not be lossier than the data. */
export interface Quad {
  x1: number; y1: number;
  x2: number; y2: number;
  x3: number; y3: number;
  x4: number; y4: number;
}

/** PDF anchor: a page + bounding region, optionally per-line quads. `region`
 *  is verbatim today's v1 `AnchorRegion.region`. */
export interface PdfQuadAnchor {
  kind: 'pdf-quad';
  page: number;
  region: { x: number; y: number; w: number; h: number };
  quads?: Quad[];
}

/** Text-quote anchor: ONE kind shared by MD, HTML, and DOCX body text
 *  (§3.1 rule 3). Field-for-field today's `MdAnchor` (shared/md/anchors.ts).
 *  Originals are immutable (§3.1 rule 2): fuzzy relocations land in
 *  `relocated`; `quoted_text/prefix/suffix/char_*` are write-once. */
export interface TextQuoteAnchor {
  kind: 'text-quote';
  char_start: number;
  char_end: number;
  prefix: string;
  suffix: string;
  quoted_text: string;
  relocated?: { char_start: number; char_end: number } | null;
}

/** HTML selector hint: legitimizes the v1 smuggled selector/charOffset hybrid
 *  as a declared kind. HINT only — resolution truth is meant to be a sibling
 *  text-quote (Pass-4B); the hint gives locality for the iframe viewers. */
export interface HtmlSelectorHint {
  kind: 'html-selector-hint';
  selector: string;
  char_offset: number;
  char_length: number;
  quoted_text: string;
}

/** The per-comment discriminated anchor union (D1). */
export type Anchor = PdfQuadAnchor | TextQuoteAnchor | HtmlSelectorHint;

/** Truthful kind discriminator = the union's own `kind` field. Replaces the
 *  v1 two-value file-level `AnchorKind` ('pdf-glyph-rect' | 'md-fuzzy-snippet').
 *  `FileViewer.anchorKind` now returns one of these per-format, honestly. */
export type AnchorKind = Anchor['kind'];

/** §3.2 comment provenance. REQUIRED on v2 comments (migration writes
 *  `'app-draft'` for all v1 rows). Drives the bundle writer's
 *  duplicate-prevention rule: only `app-draft` comments are emitted as NEW
 *  PDF annotations; native rows round-trip through `native`. */
export type CommentOrigin = 'app-draft' | 'native-pdf' | 'native-docx' | 'engine-extract';

/** §3.2 native-annotation block. Generalizes the v1 `pdf_annotation_id`.
 *  Field set adopted from the rev-cvr spike's readback records. */
export interface NativeAnnotationRef {
  /** PDF /NM or DOCX w:id. */
  comment_id: string;
  subtype?: 'Highlight' | 'StrikeOut' | 'Underline' | 'Squiggly' | 'Text' | string;
  author?: string;
  color?: string;
  created?: string;
  /** Reply parent — populated only once spike S-1's READ half passes (§8). */
  in_reply_to?: string;
  /** Read-time fallback handle for foreign annots lacking /NM (5A rec (i)). */
  page_index?: number;
  annot_index?: number;
}

/** §3.2 unified comment record (v2). The `anchor` union replaces the v1
 *  `AnchorRegion` + bolted-on `md_anchor` + the `as any` smuggle; `origin` and
 *  `native` are new; `md_anchor` / `pdf_annotation_id` are deleted (folded into
 *  the union and `native` respectively — migration-shimmed, never breaking
 *  read, §3.3). The interface keeps its historical name `CommentPayload` so the
 *  ~14 importers don't churn; the SHAPE is v2. */
export interface CommentPayload {
  id: string;
  doc_id: string;
  doc_version: string;
  /** REQUIRED discriminated union (§3.1) — replaces AnchorRegion + md_anchor. */
  anchor: Anchor;
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
   *  the comment's logical anchor changed (§4.3). Re-typed from AnchorRegion
   *  to the union: the rig echoes the kind it received. The original `anchor`
   *  is kept alongside so re-raised v1.1 comments can point to the new place. */
  new_anchor?: Anchor | null;
  /** When a v1.1 comment is seeded from a v1.0 `deferred` / `needs-followup`
   *  result, this is the original comment's id (§8.5 round-trip re-raise). */
  derived_from?: string | null;
  /** §3.2 REQUIRED provenance. Migration writes `'app-draft'` for all v1 rows. */
  origin: CommentOrigin;
  /** §3.2 native-annotation block. Present for `native-*` / `engine-extract`
   *  origins and for app-written PDF annotations once a bundle stamps the /NM
   *  (folds in the v1 `pdf_annotation_id`). Null/absent otherwise. */
  native?: NativeAnnotationRef | null;
}

/** v1 comment shape — the on-disk / on-the-wire record BEFORE the union.
 *  Read by the migration (§3.3) and written by the v2→v1 down-converter during
 *  the rollout window (§4.4 step 1). Not used by live code paths. */
export interface CommentPayloadV1 {
  id: string;
  doc_id: string;
  doc_version: string;
  anchor: AnchorRegion;
  highlighted_text: string;
  comment: string;
  redraft: string | null;
  redraft_suggestion: string | null;
  engagement_level: EngagementLevel;
  author: string;
  kind: 'comment';
  status: CommentStatus;
  created_at: string;
  submitted_at?: string | null;
  agent_note?: string | null;
  new_anchor?: AnchorRegion | null;
  derived_from?: string | null;
  pdf_annotation_id?: string | null;
  md_anchor?: {
    char_start: number;
    char_end: number;
    prefix: string;
    suffix: string;
    quoted_text: string;
  } | null;
}

/** Tolerantly coerce an on-disk / on-the-wire anchor value into the union
 *  (§4.3). A value already carrying a `kind` is trusted as-is. A bare
 *  `{ page, region }` (v1 — no `kind`) is structurally unambiguous and reads
 *  as `pdf-quad`. Anything else (incl. null/undefined) yields `null`. This
 *  single rule lets v1 sidecars, v1 results files, and a not-yet-updated rig
 *  emitting v1-shaped relocations all keep working without a flag day. */
export function normalizeAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind === 'string') {
    // Already discriminated — trust the producer (first-party); inner-shape
    // validation is intentionally light.
    return o as unknown as Anchor;
  }
  // Bare v1 AnchorRegion: { page, region: { x, y, w, h } }.
  if (typeof o.page === 'number' && o.region && typeof o.region === 'object') {
    const r = o.region as Record<string, unknown>;
    return {
      kind: 'pdf-quad',
      page: o.page,
      region: {
        x: Number(r.x) || 0,
        y: Number(r.y) || 0,
        w: Number(r.w) || 0,
        h: Number(r.h) || 0,
      },
    };
  }
  return null;
}

/** v2→v1 down-convert one anchor for the rollout window (§4.4 step 1):
 *  `pdf-quad` → required `{ page, region }`, quads dropped. Non-PDF kinds have
 *  no PDF region so they collapse to the v1 placeholder (`page:1, 0×0`) — moot
 *  in practice because only PDF rounds promote during the window. */
export function downConvertAnchorToV1(a: Anchor): AnchorRegion {
  if (a.kind === 'pdf-quad') return { page: a.page, region: { ...a.region } };
  return { page: 1, region: { x: 0, y: 0, w: 0, h: 0 } };
}

/** Content fingerprint stored in the sidecar for rename-recovery. When a file
 *  is moved or renamed, the path-based sidecar lookup misses; the migration
 *  code scans for a fingerprint match and offers to relink. */
export interface DocFingerprint {
  title_from_frontmatter: string | null;
  first_500_chars_sha256: string;
  anchor_count: number;
  last_known_path: string;
}

/** Document format — the genuinely file-level fact (§3.3) that replaces the
 *  v1 file-level `anchor_kind` discriminator (which lied for html/docx and is
 *  derivable per-comment under the union). Drives adapter selection. */
export type DocFormat = 'pdf' | 'md' | 'docx' | 'html';

/**
 * On-disk drafts schema (v2). Snapshot (not append-only): main rewrites the
 * full file on every save. Renderer debounces writes 250ms per spec §10.3.
 *
 * v2 (§3.3): `schema_version` bumps to 2; `anchor_kind` is dropped in favor of
 * the file-level `format`; comments carry the anchor union. v1 sidecars are
 * read tolerantly and migrated LAZILY at read time (main/drafts-migration.ts).
 */
export interface DraftsFile {
  schema_version: 2;
  doc_version: string;
  format: DocFormat;
  comments: CommentPayload[];
  doc_fingerprint?: DocFingerprint;
}

/** v1 drafts schema — read-only legacy shape consumed by the migration. */
export interface DraftsFileV1 {
  schema_version: 1;
  doc_version: string;
  comments: CommentPayloadV1[];
  /** v1 file-level discriminator: 'pdf-glyph-rect' | 'md-fuzzy-snippet'.
   *  Absent → defaults to 'pdf-glyph-rect' (the documented v1 default). */
  anchor_kind?: 'pdf-glyph-rect' | 'md-fuzzy-snippet';
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
  /** Additive bump (§4.2): both v1 and v2 are valid on disk. The desktop
   *  WRITER stays on v1 (down-converted) until the §4.4 step-3 flip, gated on
   *  an OBSERVED rig-written `schema_version: 2` results file. Readers tolerate
   *  both. */
  schema_version?: 1 | 2;
  submit_id: string;
  doc_id: string;
  /** sha256 of the source-file bytes at submit time. The watcher matches this
   *  against the currently-open doc's sha256 to decide whether a results file
   *  in the same `.review-state/` dir applies to the open doc. */
  doc_version: string;
  source_file_version: string;
  submitted_at: string;
  origin_rig: string | null;
  /** v2 bundle generalization (§4.2): the round's native artifact + sidecar
   *  paths and the document format, replacing the PDF-shaped `bundle_pdf` /
   *  `bundle_json` pair. For PDF rounds `native_artifact_path` equals
   *  `bundle_pdf` and `sidecar_json_path` equals `bundle_json`; non-PDF rounds
   *  (md/docx/html) populate only the generalized fields. `format` is absent on
   *  v1 files read off disk — `normalizeSubmitFile` defaults it to `'pdf'` and
   *  back-fills the generalized paths from the deprecated aliases. */
  native_artifact_path?: string;
  sidecar_json_path?: string;
  format?: DocFormat;
  /** Deprecated PDF-round aliases (§4.2, OWNER-CONFIRMED D11), kept populated
   *  for PDF rounds through the transition window, dropped at v3. Superseded by
   *  `native_artifact_path` / `sidecar_json_path` + `format`. */
  bundle_pdf?: string;
  bundle_json?: string;
  comments: CommentPayload[];
}

/** Frozen v1 SubmitFile shape — what the desktop WRITES to disk during the
 *  rollout window (the writer flip to v2 is gated, §4.4 step 3). Built from a
 *  v2 SubmitFile by `downConvertSubmitFileToV1`. */
export interface SubmitFileV1 {
  schema_version?: 1;
  submit_id: string;
  doc_id: string;
  doc_version: string;
  source_file_version: string;
  submitted_at: string;
  origin_rig: string | null;
  bundle_pdf?: string;
  bundle_json?: string;
  comments: CommentPayloadV1[];
}

/** v2→v1 down-convert one comment (§4.4 step 1). Anchor → bare `{page,region}`;
 *  `native.comment_id` → `pdf_annotation_id`; union/origin/native dropped.
 *  Sufficient for the window because only PDF rounds promote (anchors are all
 *  `pdf-quad`). */
export function downConvertCommentToV1(c: CommentPayload): CommentPayloadV1 {
  return {
    id: c.id,
    doc_id: c.doc_id,
    doc_version: c.doc_version,
    anchor: downConvertAnchorToV1(c.anchor),
    highlighted_text: c.highlighted_text,
    comment: c.comment,
    redraft: c.redraft,
    redraft_suggestion: c.redraft_suggestion,
    engagement_level: c.engagement_level,
    author: c.author,
    kind: 'comment',
    status: c.status,
    created_at: c.created_at,
    submitted_at: c.submitted_at ?? null,
    agent_note: c.agent_note ?? null,
    new_anchor: c.new_anchor ? downConvertAnchorToV1(c.new_anchor) : null,
    derived_from: c.derived_from ?? null,
    pdf_annotation_id: c.native?.comment_id ?? null,
  };
}

/** v2→v1 down-convert a whole SubmitFile for the rollout window (§4.4 step 1,
 *  acceptance criterion 6). Emits `schema_version: 1` with v1-shaped comments. */
export function downConvertSubmitFileToV1(sf: SubmitFile): SubmitFileV1 {
  return {
    schema_version: 1,
    submit_id: sf.submit_id,
    doc_id: sf.doc_id,
    doc_version: sf.doc_version,
    source_file_version: sf.source_file_version,
    submitted_at: sf.submitted_at,
    origin_rig: sf.origin_rig,
    // Only PDF rounds promote during the transition window, so the v1 shape
    // carries the PDF aliases. Fall back to the generalized paths when a v2
    // submit file populated only those (§4.2): the format is PDF (or absent,
    // which the v1 reader treats as PDF).
    bundle_pdf: sf.bundle_pdf ?? (sf.format === undefined || sf.format === 'pdf' ? sf.native_artifact_path : undefined),
    bundle_json: sf.bundle_json ?? (sf.format === undefined || sf.format === 'pdf' ? sf.sidecar_json_path : undefined),
    comments: sf.comments.map(downConvertCommentToV1),
  };
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
   *  position changed. Carried into the comment via `new_anchor`. Union-typed
   *  (§4.3): the rig echoes the kind it received. A bare `{page,region}` from a
   *  not-yet-updated rig is read as `pdf-quad` (the §4.3 tolerant-parse rule —
   *  see `normalizeResultsFile`). */
  new_anchor?: Anchor | null;
  /** Free-text agent commentary: build-error excerpt for `build_failed`,
   *  redirect-to-L3 advice for `needs-followup`, terse confirmation for
   *  `applied`, etc. */
  agent_note?: string | null;
}

export type RoundStatus = 'in_progress' | 'complete' | 'failed';

/** Results file written by the rig in `.review-state/results-<ts>.json`.
 *  Mutates as the rig processes (per-comment atomic append); `round_status`
 *  flips `in_progress` → `complete` / `failed` at round end. Additive bump
 *  (§4.2): the reader tolerates BOTH v1 and v2 from rollout step 1 onward. */
export interface ResultsFile {
  schema_version?: 1 | 2;
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

/** v2-results tolerance (§4.4 step 1): normalize a just-parsed results file so
 *  every `new_anchor` is the union shape regardless of whether it came from a
 *  v1 rig (bare `{page,region}`) or a v2 rig (`{kind:...}`). Idempotent. The
 *  results watcher runs this before emitting to the renderer so downstream code
 *  only ever sees union anchors. */
export function normalizeResultsFile(rf: ResultsFile): ResultsFile {
  return {
    ...rf,
    results: rf.results.map((r) =>
      r.new_anchor == null ? r : { ...r, new_anchor: normalizeAnchor(r.new_anchor) }
    ),
  };
}

/** v2-results tolerance companion: normalize a submit file's comment anchors so
 *  a v1 submit file (bare anchors) read back off disk presents as union-shaped.
 *  Idempotent. */
export function normalizeSubmitFile(sf: SubmitFile): SubmitFile {
  return {
    ...sf,
    // v2 bundle generalization (§4.2): a v1 file read off disk carries only the
    // PDF aliases and no `format`. Present the generalized shape so downstream
    // only ever sees `native_artifact_path`/`sidecar_json_path` + `format`
    // (mirrors the v1-default `'pdf-glyph-rect'` sidecar convention). Idempotent.
    format: sf.format ?? 'pdf',
    native_artifact_path: sf.native_artifact_path ?? sf.bundle_pdf,
    sidecar_json_path: sf.sidecar_json_path ?? sf.bundle_json,
    comments: sf.comments.map((c) => {
      const anchor = normalizeAnchor(c.anchor);
      const newAnchor = c.new_anchor == null ? c.new_anchor : normalizeAnchor(c.new_anchor);
      // A v1 comment read off disk may also carry `pdf_annotation_id` instead
      // of `native`; fold it so downstream sees the v2 shape.
      const v1 = c as unknown as CommentPayloadV1;
      const native = c.native ?? (v1.pdf_annotation_id ? { comment_id: v1.pdf_annotation_id } : c.native);
      return {
        ...c,
        anchor: anchor ?? c.anchor,
        new_anchor: newAnchor,
        origin: c.origin ?? 'app-draft',
        native: native ?? null,
      };
    }),
  };
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
   *  be on disk by the time promote is called (writeBundle ran first). These
   *  carry the round's native artifact and sidecar paths — for PDF rounds the
   *  fields keep their legacy names but feed both the generalized
   *  `native_artifact_path`/`sidecar_json_path` and the deprecated
   *  `bundle_pdf`/`bundle_json` aliases (§4.2). */
  bundlePdfPath: string;
  bundleJsonPath: string;
  /** Document format for this round (§4.2). Defaults to `'pdf'` — the only
   *  format that promotes during the transition window — when omitted. Drives
   *  whether the deprecated `bundle_pdf`/`bundle_json` aliases are populated. */
  format?: DocFormat;
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

// ─── §5.3 / L5 native DOCX comments IPC ────────────────────────────────────
//
// The renderer can't read a .docx's comments.xml itself (sandboxed, no fs), so
// the L5 `docx-comments.ts` adapter runs in main behind these channels. Like
// native-pdf annotations, native-docx comments are a READ PROJECTION of the
// source file — re-derived on every open, never frozen into the drafts sidecar.
// Create/edit/delete mutate the .docx in place (atomic write); the renderer
// re-opens the doc to pick up the new bytes (and the fresh `w:id`s).

/** Read result for `docx:readComments`. The comments are mapped straight to
 *  unified CommentPayloads with `origin: 'native-docx'`. An empty array is the
 *  normal no-comments case, not an error; `read_failed` is a true I/O / zip
 *  failure (missing file, corrupt zip). */
export type DocxCommentsReadResult =
  | { ok: true; comments: CommentPayload[] }
  | { ok: false; reason: 'read_failed'; error: string };

/** Create a native comment over a resolved text-quote span in the .docx. */
export interface DocxCommentCreateRequest {
  docPath: string;
  /** The text-quote anchor captured over the iframe's linear text. The adapter
   *  re-resolves it against the document's run text before inserting markers. */
  anchor: TextQuoteAnchor;
  commentText: string;
  author: string;
}

/** Edit a native comment's body text. `commentId` is the OOXML `w:id` (carried
 *  on the payload as `native.comment_id`). */
export interface DocxCommentEditRequest {
  docPath: string;
  commentId: string;
  newText: string;
}

/** Delete a native comment (and its document markers). */
export interface DocxCommentDeleteRequest {
  docPath: string;
  commentId: string;
}

/** Write result shared by create/edit/delete. `commentId` echoes the affected
 *  `w:id` (the freshly-minted one for create). The reasons mirror the adapter's
 *  own failure modes plus the I/O-layer `write_failed`. */
export type DocxCommentWriteResult =
  | { ok: true; commentId: string }
  | {
      ok: false;
      reason: 'anchor_unresolved' | 'no_text' | 'no_document' | 'not_found' | 'write_failed';
      error: string;
    };
