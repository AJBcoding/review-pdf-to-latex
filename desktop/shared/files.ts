// Filesystem surface shared between Electron main, preload, and renderer:
// the §3 file tree (folder picker, directory listing, PDF index), §3.3
// persisted app state, and the M-md-3 file write + watch primitives.

/** Native folder picker (§3.1 — single root the tree is scoped to).
 *  `path === null` means the user canceled. */
export interface OpenFolderDialogResult {
  path: string | null;
}

// `FileKind` and the path→kind classifier live in `./file-kinds` (X7 — single
// source of truth, consumed by the tree, the indexer, and the renderer). Kept
// imported + re-exported here so DirEntry below can name it and the existing
// importers that reach for it via `@shared/files` don't churn.
import type { FileKind } from './file-kinds';
export type { FileKind };

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

/** Existence check used at launch: a remembered root that's been moved/deleted
 *  shouldn't crash the boot path — we just clear it and show the empty state. */
export type PathExistsResult =
  | { ok: true; exists: boolean; isDir: boolean; isFile: boolean; path: string }
  | { ok: false; reason: 'stat_failed'; path: string; error: string };

// ─── M-md-3 file write + watch ───────────────────────────────────────────

export type WriteFileTextResult =
  // sha256 of the bytes just written — lets the renderer refresh docState.sha256
  // without a follow-up readFileBytes round-trip (the content is already in main).
  | { ok: true; filePath: string; sha256: string }
  | { ok: false; reason: 'mkdir_failed' | 'write_failed'; filePath: string; error: string };

export interface FileChangeEvent {
  filePath: string;
  kind: 'change' | 'rename';
}
