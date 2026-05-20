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
 */
export type ReadPdfBytesResult =
  | { ok: true; bytes: Uint8Array; resolvedPath: string }
  | { ok: false; reason: 'not_found' | 'not_a_file' | 'read_failed'; resolvedPath: string; error?: string };

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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
