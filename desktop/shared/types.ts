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

export interface CommentPayload {
  id: string;
  doc_id: string;
  doc_version: string;
  anchor: { page: number; region: { x: number; y: number; w: number; h: number } };
  highlighted_text: string;
  comment: string;
  redraft: string | null;
  redraft_suggestion: null;
  engagement_level: EngagementLevel;
  author: string;
  kind: 'comment';
  status: 'open';
  created_at: string;
}

/**
 * On-disk drafts schema. Snapshot (not append-only): main rewrites the full
 * file on every save. Renderer debounces writes 250ms per spec §10.3.
 */
export interface DraftsFile {
  schema_version: 1;
  doc_version: string;
  comments: CommentPayload[];
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
}

export type AppStateReadResult =
  | { ok: true; state: AppStateFile; filePath: string }
  /** First launch (or state.json was deleted) — caller starts fresh. */
  | { ok: true; state: null; filePath: string; reason: 'not_found' }
  | { ok: false; reason: 'read_failed' | 'parse_failed'; filePath: string; error: string };

export type AppStateWriteResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: 'write_failed' | 'mkdir_failed'; filePath: string; error: string };

/** Existence check used at launch: a remembered root that's been moved/deleted
 *  shouldn't crash the boot path — we just clear it and show the empty state. */
export type PathExistsResult =
  | { ok: true; exists: boolean; isDir: boolean; isFile: boolean; path: string }
  | { ok: false; reason: 'stat_failed'; path: string; error: string };

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
  // §3.4 — main pushes the renderer a request to open a specific document
  // (from a CLI shim arg, second-instance argv, or reviewpdf:// URL).
  // Renderer pivots the middle pane to the doc; per §10.3 the prior doc's
  // draft state is preserved by the existing loadPdf flow.
  onOpenExternalFile(cb: (path: string) => void): () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
