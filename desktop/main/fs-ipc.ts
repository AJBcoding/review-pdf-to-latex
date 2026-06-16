// ─── Filesystem + document IPC surface ─────────────────────────────────────
//
// All the `fs:` / `dialog:` / `drafts:` / `appState:` invoke handlers, plus the
// hidden-name policy and path helpers they share. Split out of main/index.ts
// (rev-l9) so the entry point only orchestrates wiring. Call registerFsIpc()
// once inside `app.whenReady()`.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from 'electron';
import { basename as pathBasename, dirname, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { findSidecarByFingerprint, buildFingerprint } from './doc-identity.js';
import { migrateDraftsToV2 } from './drafts-migration.js';
import { atomicWrite, atomicWriteJson } from './atomic-write.js';
import { typedHandle } from './typed-ipc.js';
import { assertObjectArg, assertPathArg, assertStringArg } from './ipc-validators.js';
import type { DocFormat } from '@shared/comments';
import type {
  DraftsReadResult,
  DraftsWriteResult,
} from '@shared/comments';
import type {
  AppStateFile,
  AppStateReadResult,
  AppStateWriteResult,
  DirEntry,
  FileKind,
  IndexPdfsResult,
  IndexedPdf,
  ListDirResult,
  OpenFolderDialogResult,
  OpenPdfDialogResult,
  PathExistsResult,
  ReadFileBytesResult,
  WriteFileTextResult,
} from '@shared/types';
import { classifyPath, docFormatForPath } from '@shared/file-kinds';

/** Drafts file location: path-based keying. The sidecar lives next to the
 *  source doc in `.review-state/drafts/<basename>.json`. Path-based keying
 *  means editing the file (changing its sha256) doesn't orphan the sidecar,
 *  which is essential for .md files where every save changes the hash. */
function draftsPathFor(docPath: string): string {
  const base = pathBasename(resolve(docPath));
  return join(dirname(resolve(docPath)), '.review-state', 'drafts', `${base}.json`);
}

/** Path-derived document format for DraftsFile v2 (§3.3). The drafts migration
 *  takes this as a hint so the migrated `format` field is accurate without
 *  inferring from comment shapes. */
function draftFormatForPath(docPath: string): DocFormat {
  return docFormatForPath(resolve(docPath));
}

// ─── §3.2 hidden ignore list ───────────────────────────────────────────────
//
// Names that are hidden by default in the tree (and skipped entirely by the
// recursive index, no "show hidden" override there — the user doesn't search
// Cmd+P for files inside node_modules). Spec calls out exact set; the
// `.reviewignore` file is a future extension.
const HIDDEN_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build',
]);

function classifyFile(name: string): FileKind {
  return classifyPath(name);
}

function isHiddenName(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (isDir && HIDDEN_DIR_NAMES.has(name)) return true;
  return false;
}

// ─── §3.3 app state path ───────────────────────────────────────────────────
//
// `app.getPath('userData')` resolves to ~/Library/Application Support/<name>
// on macOS, %APPDATA%/<name> on Windows, ~/.config/<name> on Linux. We pin a
// single file so the schema is one atomic write.
function appStatePath(): string {
  return join(app.getPath('userData'), 'state.json');
}

/** `dialog.showOpenDialog`'s parented overload wants a non-null BrowserWindow;
 *  the unparented overload takes options only. Branch on the resolved sender
 *  window so a missing window falls through to the unparented form instead of
 *  smuggling `null` past the types with `as any`. */
function showOpenDialog(win: BrowserWindow | null, opts: OpenDialogOptions) {
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}

/** Register every filesystem / document invoke handler. Idempotent only in the
 *  sense that `ipcMain.handle` throws on a duplicate channel — call once. */
export function registerFsIpc(): void {
  // Native open-file dialog for picking a PDF. Returns the picked path,
  // or `path: null` if the user canceled. The renderer follows up with
  // pdfHealth() + readFileBytes() to actually load the document.
  typedHandle('openPdfDialog', async (event): Promise<OpenPdfDialogResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await showOpenDialog(win, {
      title: 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0] };
  });

  // Read a document off disk for the renderer. Sandboxed renderer can't open
  // file:// URLs; we ship bytes across the IPC boundary instead. Path is
  // resolved relative to main's cwd (desktop/ during dev). Format-agnostic —
  // serves pdf/md/html/docx alike (the loader is named for bytes, not PDFs).
  typedHandle('readFileBytes', async (_event, docPath): Promise<ReadFileBytesResult> => {
    const resolvedPath = resolve(docPath);
    try {
      const s = await stat(resolvedPath);
      if (!s.isFile()) {
        return { ok: false, reason: 'not_a_file', resolvedPath };
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'not_found',
        resolvedPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      const buf = await readFile(resolvedPath);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      return { ok: true, bytes: new Uint8Array(buf), resolvedPath, sha256 };
    } catch (err) {
      return {
        ok: false,
        reason: 'read_failed',
        resolvedPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, ([docPath]) => assertPathArg('fs:readFileBytes', docPath));

  // Read the drafts snapshot for this doc. Missing file is the common
  // first-open case — surfaced as ok:true with file:null so the renderer
  // can `?? []` cleanly. Parse errors are a different story (corrupted
  // file) and come through as ok:false. Sidecars are path-keyed, so the
  // doc's content hash isn't needed to locate them.
  typedHandle('readDrafts', async (_event, docPath): Promise<DraftsReadResult> => {
    const filePath = draftsPathFor(docPath);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        // Rename-recovery: check if there's a sidecar matching this doc's
        // content fingerprint under a different name (the doc was renamed).
        const draftsDir = dirname(filePath);
        try {
          // buildFingerprint reads the file; acceptable here — this is a cold
          // path (no sidecar found at the expected path, i.e. doc was renamed).
          const fp = await buildFingerprint(resolve(docPath));
          const match = await findSidecarByFingerprint(draftsDir, fp);
          if (match) {
            // Relink: move the sidecar to the new path and update its
            // fingerprint. Migrate v1 → v2 lazily (§3.3) before writing so the
            // relinked file lands as v2.
            const migrated = migrateDraftsToV2(match.drafts, draftFormatForPath(docPath));
            migrated.doc_fingerprint = {
              ...fp,
              last_known_path: resolve(docPath),
            };
            await atomicWriteJson(filePath, migrated);
            try { await rename(match.sidecarPath, `${match.sidecarPath}.relinked`); } catch { /* best-effort */ }
            return { ok: true, file: migrated, filePath };
          }
        } catch { /* fingerprint scan failure is non-fatal */ }
        return { ok: true, file: null, filePath, reason: 'not_found' };
      }
      return { ok: false, reason: 'read_failed', filePath, error: e.message };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      // §3.3 LAZY read-time migration: v1 sidecars are migrated to v2 in
      // memory here; the file is rewritten as v2 only on the next drafts:write
      // (no startup sweep). Already-v2 files pass through normalized.
      const file = migrateDraftsToV2(parsed, draftFormatForPath(docPath));
      return { ok: true, file, filePath };
    } catch (err) {
      return {
        ok: false,
        reason: 'parse_failed',
        filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, ([docPath]) => assertPathArg('drafts:read', docPath));

  // Snapshot write — atomic via tmp + rename so a crash mid-write can't
  // leave a half-written drafts file. Renderer debounces, so we don't
  // also debounce here.
  typedHandle(
    'writeDrafts',
    async (_event, docPath, file): Promise<DraftsWriteResult> => {
      const filePath = draftsPathFor(docPath);
      // mkdir up front so a missing parent dir surfaces as the distinct
      // `mkdir_failed` reason; atomicWriteJson re-runs mkdir (idempotent) and
      // owns the crash-safe tmp + rename.
      try {
        await mkdir(dirname(filePath), { recursive: true });
      } catch (err) {
        return {
          ok: false,
          reason: 'mkdir_failed',
          filePath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        await atomicWriteJson(filePath, file);
        return { ok: true, filePath };
      } catch (err) {
        return {
          ok: false,
          reason: 'write_failed',
          filePath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    ([docPath, file]) => {
      assertPathArg('drafts:write', docPath);
      assertObjectArg('drafts:write file', file);
    },
  );

  // §3.1 — native folder picker for the left-drawer root.
  typedHandle('openFolderDialog', async (event): Promise<OpenFolderDialogResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await showOpenDialog(win, {
      title: 'Open Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  // §3.2 — non-recursive directory listing. Entries are sorted folders-first
  // then alphabetic (stable, matches what users expect from finders/IDEs).
  // The `isHidden` flag rides along so the renderer can filter without a
  // second pass over the list.
  typedHandle('listDir', async (_event, path): Promise<ListDirResult> => {
    const resolvedPath = resolve(path);
    try {
      const s = await stat(resolvedPath);
      if (!s.isDirectory()) {
        return { ok: false, reason: 'not_a_dir', path: resolvedPath, error: 'not a directory' };
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, reason: 'not_found', path: resolvedPath, error: e.message };
      }
      return { ok: false, reason: 'read_failed', path: resolvedPath, error: e.message };
    }
    let dirents;
    try {
      dirents = await readdir(resolvedPath, { withFileTypes: true });
    } catch (err) {
      return {
        ok: false, reason: 'read_failed', path: resolvedPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const entries: DirEntry[] = dirents.map((d) => {
      // Treat symlinks pessimistically — readdir doesn't follow, and we
      // can't classify the target without an extra stat. Reporting them
      // as files is fine for v1; the tree just won't expand them.
      const isDir = d.isDirectory();
      return {
        name: d.name,
        path: join(resolvedPath, d.name),
        isDir,
        isHidden: isHiddenName(d.name, isDir),
        kind: isDir ? 'other' : classifyFile(d.name),
      };
    });
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return { ok: true, entries, path: resolvedPath };
  }, ([path]) => assertPathArg('fs:listDir', path));

  // §3.3 launch boot — check the remembered root still exists before we try
  // to list it. Renderer falls back to the empty state if not.
  typedHandle('pathExists', async (_event, path): Promise<PathExistsResult> => {
    const resolvedPath = resolve(path);
    try {
      const s = await stat(resolvedPath);
      return {
        ok: true, exists: true,
        isDir: s.isDirectory(), isFile: s.isFile(),
        path: resolvedPath,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: true, exists: false, isDir: false, isFile: false, path: resolvedPath };
      }
      return { ok: false, reason: 'stat_failed', path: resolvedPath, error: e.message };
    }
  }, ([path]) => assertPathArg('fs:pathExists', path));

  // M-md-3 — write text to disk (for .md save). Atomic via tmp+rename.
  typedHandle(
    'writeFileText',
    async (_event, filePath, content): Promise<WriteFileTextResult> => {
      const resolvedPath = resolve(filePath);
      // Explicit mkdir keeps the distinct `mkdir_failed` reason; atomicWrite
      // (text, not JSON) owns the crash-safe tmp + rename.
      try {
        await mkdir(dirname(resolvedPath), { recursive: true });
      } catch (err) {
        return {
          ok: false, reason: 'mkdir_failed', filePath: resolvedPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        await atomicWrite(resolvedPath, content);
        // Same digest readFileBytes would compute on a re-read: atomicWrite
        // persists the string as UTF-8, so hashing the UTF-8 bytes here matches
        // the on-disk content and lets the renderer skip the rehash read.
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        return { ok: true, filePath: resolvedPath, sha256 };
      } catch (err) {
        return {
          ok: false, reason: 'write_failed', filePath: resolvedPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    ([filePath, content]) => {
      assertPathArg('fs:writeFileText', filePath);
      assertStringArg('fs:writeFileText content', content);
    },
  );

  // M-md-3 — file watcher for external modification detection.
  let fileWatcher: FSWatcher | null = null;
  let fileWatchSuppressUntil = 0;

  typedHandle('watchFile', async (event, filePath) => {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    const resolvedPath = resolve(filePath);
    try {
      fileWatcher = watch(resolvedPath, (eventType) => {
        if (Date.now() < fileWatchSuppressUntil) return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send('file:change', { filePath: resolvedPath, kind: eventType });
        }
      });
    } catch { /* file may not exist yet — non-fatal */ }
  }, ([filePath]) => assertPathArg('fs:watchFile', filePath));

  typedHandle('unwatchFile', async () => {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
  });

  // Suppress file-change events for 1s after we write — avoids triggering
  // the external-modification modal from our own save.
  ipcMain.on('fs:suppressFileWatch', () => {
    fileWatchSuppressUntil = Date.now() + 1000;
  });

  // §3.3 persisted state. Same atomic-write pattern as drafts (temp + rename)
  // so a crash mid-write can't corrupt the boot record.
  typedHandle('readAppState', async (): Promise<AppStateReadResult> => {
    const filePath = appStatePath();
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: true, state: null, filePath, reason: 'not_found' };
      }
      return { ok: false, reason: 'read_failed', filePath, error: e.message };
    }
    try {
      const parsed = JSON.parse(raw) as AppStateFile;
      // Defensive: future schema_version means we don't know the layout, so
      // treat as not-found rather than crash. v1 has only one version.
      if (parsed.schema_version !== 1) {
        return { ok: true, state: null, filePath, reason: 'not_found' };
      }
      return { ok: true, state: parsed, filePath };
    } catch (err) {
      return {
        ok: false, reason: 'parse_failed', filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  typedHandle('writeAppState', async (_event, state): Promise<AppStateWriteResult> => {
    const filePath = appStatePath();
    // Explicit mkdir keeps the distinct `mkdir_failed` reason; atomicWriteJson
    // owns the crash-safe tmp + rename.
    try {
      await mkdir(dirname(filePath), { recursive: true });
    } catch (err) {
      return {
        ok: false, reason: 'mkdir_failed', filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      await atomicWriteJson(filePath, state);
      return { ok: true, filePath };
    } catch (err) {
      return {
        ok: false, reason: 'write_failed', filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, ([state]) => assertObjectArg('appState:write', state));

  // §3.5 — recursive index for the Cmd+P palette. Walks under `root`, skipping
  // the hidden-by-default dir list (no override; the user doesn't Cmd+P search
  // for files inside node_modules). Indexes every openable FileKind (pdf, md,
  // html, docx) — not just PDFs — so the palette surfaces all reviewable docs.
  // Soft cap at 20 000 hits to bound the walk on accidentally-pointed-at home
  // dirs.
  typedHandle('indexPdfs', async (_event, root): Promise<IndexPdfsResult> => {
    const resolvedRoot = resolve(root);
    try {
      const s = await stat(resolvedRoot);
      if (!s.isDirectory()) {
        return { ok: false, reason: 'not_a_dir', root: resolvedRoot, error: 'not a directory' };
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, reason: 'not_found', root: resolvedRoot, error: e.message };
      }
      return { ok: false, reason: 'read_failed', root: resolvedRoot, error: e.message };
    }
    const MAX_HITS = 20000;
    const pdfs: IndexedPdf[] = [];
    const stack: string[] = [resolvedRoot];
    while (stack.length > 0) {
      if (pdfs.length >= MAX_HITS) break;
      const dir = stack.pop()!;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        // Single unreadable dir shouldn't fail the whole index. Skip silently.
        continue;
      }
      for (const d of dirents) {
        if (d.isDirectory()) {
          if (isHiddenName(d.name, true)) continue;
          stack.push(join(dir, d.name));
        } else if (d.isFile()) {
          if (classifyPath(d.name) === 'other') continue;
          const path = join(dir, d.name);
          // Normalize relPath to forward slashes for stable display + match
          // ranking, regardless of platform.
          const relPath = relative(resolvedRoot, path).split(sep).join('/');
          pdfs.push({ path, name: d.name, relPath });
        }
      }
    }
    pdfs.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { sensitivity: 'base' }));
    return { ok: true, root: resolvedRoot, pdfs };
  }, ([root]) => assertPathArg('fs:indexPdfs', root));
}
