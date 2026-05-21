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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
