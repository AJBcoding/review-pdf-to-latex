import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { basename as pathBasename, dirname, extname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { engineVersion, pdfHealth } from './engine.js';
import { startWatch as startResultsWatch, stopWatch as stopResultsWatch } from './results-watcher.js';
import { writeBundle as writeBundleImpl } from './bundle.js';
import { registerClaudePtyIpc, shutdownClaudePty } from './claude-pty.js';
import { registerAgentPaneIpc, rebindMainWindow, shutdownAgentPane } from './agent-pane-ipc.js';
import { runSidecarMigration, findSidecarByFingerprint, buildFingerprint } from './sidecar-migration.js';
import { migrateDraftsToV2 } from './drafts-migration.js';
import {
  promoteDraft,
  slingViaGtMail,
  abandonRound,
} from './submit.js';
import type { DocFormat } from '@shared/comments';
import type {
  AppStateFile,
  AppStateReadResult,
  AppStateWriteResult,
  BundleWriteRequest,
  BundleWriteResult,
  DirEntry,
  DraftsFile,
  DraftsReadResult,
  DraftsWriteResult,
  FileKind,
  IndexPdfsResult,
  IndexedPdf,
  ListDirResult,
  OpenFolderDialogResult,
  OpenPdfDialogResult,
  PathExistsResult,
  ReadPdfBytesResult,
  ResultsWatchStartResult,
  SubmitAbandonRequest,
  SubmitPromoteRequest,
  SubmitSlingRequest,
  WriteFileTextResult,
} from '@shared/types';

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
  const lower = resolve(docPath).toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.docx')) return 'docx';
  return 'pdf';
}

/** Legacy sha256-based sidecar path — used only during migration to find
 *  old sidecars keyed by content hash. */
export function legacyDraftsPathFor(docPath: string, sha256: string): string {
  return join(dirname(resolve(docPath)), '.review-state', 'drafts', `${sha256}.json`);
}

// ─── §3.2 hidden ignore list ───────────────────────────────────────────────
//
// Names that are hidden by default in the tree (and skipped entirely by the
// recursive PDF index, no "show hidden" override there — the user doesn't
// search Cmd+P for files inside node_modules). Spec calls out exact set; the
// `.reviewignore` file is a future extension.
const HIDDEN_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build',
]);

function classifyFile(name: string): FileKind {
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.docx') return 'docx';
  return 'other';
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

// ─── §3.4 external-open queue ──────────────────────────────────────────────
//
// CLI args / second-instance argv / open-url events can arrive *before* the
// renderer has wired its handler. Buffer them and flush once the renderer
// signals it's ready, so a request never gets dropped on cold launch.
//
// §10.5.1 — `--from <rig-id>` rides alongside the path so the renderer can
// record the originating rig in AppState (per-doc keying) and route Submit
// to it without a destination picker. Null means standalone.
interface ExternalOpen { path: string; from: string | null }
const pendingExternalOpens: ExternalOpen[] = [];
let rendererReadyForExternalOpens = false;
let primaryWindow: BrowserWindow | null = null;

function queueExternalOpen(open: ExternalOpen): void {
  const abs = isAbsolute(open.path) ? open.path : resolve(process.cwd(), open.path);
  pendingExternalOpens.push({ path: abs, from: open.from });
  flushExternalOpens();
}

function flushExternalOpens(): void {
  if (!rendererReadyForExternalOpens) return;
  if (!primaryWindow || primaryWindow.isDestroyed()) return;
  while (pendingExternalOpens.length > 0) {
    const open = pendingExternalOpens.shift()!;
    try { primaryWindow.webContents.send('app:openExternalFile', open); }
    catch { /* webContents may be torn down mid-flush; drop silently */ }
  }
}

/** Parse a `reviewpdf://open?path=/abs/path/to/file.pdf&from=<rig-id>` URL.
 *  v1 honors `path` (required) and `from` (optional, §10.5.1); unrecognized
 *  keys are ignored with a warning per spec §3.4. Returns null if the URL
 *  is missing or malformed. */
function parseReviewpdfUrl(raw: string): { path: string; from: string | null } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'reviewpdf:') return null;
    // Accept both reviewpdf://open?path=... and reviewpdf:open?path=...
    const path = url.searchParams.get('path');
    if (!path) return null;
    const from = url.searchParams.get('from');
    for (const [k] of url.searchParams) {
      if (k !== 'path' && k !== 'from') console.warn(`[reviewpdf://] ignoring unrecognized key: ${k}`);
    }
    return { path, from: from || null };
  } catch {
    return null;
  }
}

/** Scan a process-argv array (initial process.argv OR second-instance argv)
 *  for an openable file path. Recognizes:
 *    review-pdf-app open <path>     (shim form)
 *    review-pdf-app <path.pdf>      (any positional .pdf, for drag-and-drop
 *                                    or direct file association)
 *    reviewpdf://open?path=...      (URL handed in via argv on Windows/Linux)
 *
 *  §10.5.1 `--from <rig-id>` may appear anywhere in argv. We extract it
 *  whether or not a path was found, but only return it when paired with
 *  a path (the rig context is meaningless without a doc to open). Bare
 *  `--from=<rig-id>` is also accepted for shell convenience. */
function extractPathFromArgv(argv: readonly string[]): { path: string; from: string | null } | null {
  // First pass: find the `--from <rig-id>` (or `--from=<rig-id>`) flag.
  let from: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--from' && argv[i + 1]) {
      from = argv[i + 1];
      break;
    }
    if (a.startsWith('--from=')) {
      from = a.slice('--from='.length);
      break;
    }
  }
  // Second pass: find the doc path. Skip --from values so they don't get
  // picked up as positional .pdf candidates if someone passes them in an
  // unusual order.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--from') { i += 1; continue; }
    if (a.startsWith('--from=')) continue;
    if (a === 'open' && argv[i + 1]) return { path: argv[i + 1], from };
    if (a.startsWith('reviewpdf://')) {
      const p = parseReviewpdfUrl(a);
      if (p) return { path: p.path, from: p.from ?? from };
    }
    if (a.toLowerCase().endsWith('.pdf') && !a.startsWith('-')) return { path: a, from };
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'review-pdf — empty shell',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // electron-vite injects ELECTRON_RENDERER_URL during dev (Vite server URL).
  // In production it isn't set, and we load the built renderer HTML.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  attachDraftsFlushHandshake(win);
  primaryWindow = win;
  win.on('closed', () => {
    if (primaryWindow === win) primaryWindow = null;
  });
  return win;
}

// ─── Drafts flush handshake (rev-cm6) ─────────────────────────────────────
//
// The renderer debounces draft writes 250ms (spec §10.3). Without a flush
// handshake, a Cmd+Q within 250ms of submitting a comment loses it: the
// debounce hasn't fired, the renderer is torn down, the comment never reaches
// disk. To close that gap, on app-quit and window-close we (a) cancel the
// default action, (b) ask the renderer to drain its pending write, (c) wait
// for an ack with a generous timeout, (d) then re-issue the close/quit.
//
// Timeout chosen at 2000ms: 250ms debounce + worst-case mkdir+rename on a
// cold filesystem is well under that; we'd rather quit a little late than
// lose work, but we also can't hang the app forever if the renderer is wedged.
const FLUSH_TIMEOUT_MS = 2000;
let appQuitFlushComplete = false;
let appQuitFlushInProgress = false;
const winsAwaitingFlush = new WeakSet<BrowserWindow>();

function requestFlushAndAwait(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) { resolve(); return; }
    const id = randomBytes(8).toString('hex');
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      ipcMain.off('drafts:flushAck', onAck);
      resolve();
    };
    const onAck = (_event: Electron.IpcMainEvent, replyId: string) => {
      if (replyId === id) finish();
    };
    ipcMain.on('drafts:flushAck', onAck);
    try {
      win.webContents.send('drafts:flushRequest', id);
    } catch {
      // webContents destroyed between guard and send — nothing to flush.
      finish();
      return;
    }
    setTimeout(finish, FLUSH_TIMEOUT_MS);
  });
}

function attachDraftsFlushHandshake(win: BrowserWindow): void {
  // BrowserWindow close — covers macOS Cmd+W (which destroys the renderer
  // without firing app `before-quit`). On non-darwin, window-close also
  // fires `before-quit` via `window-all-closed`; the app-level handler
  // skips its own flush when one is already in flight (see below).
  win.on('close', (event) => {
    if (appQuitFlushInProgress || appQuitFlushComplete) return;
    if (winsAwaitingFlush.has(win)) return;
    event.preventDefault();
    winsAwaitingFlush.add(win);
    void requestFlushAndAwait(win).finally(() => {
      if (!win.isDestroyed()) win.destroy();
    });
  });
}

app.on('before-quit', (event) => {
  if (appQuitFlushComplete || appQuitFlushInProgress) return;
  appQuitFlushInProgress = true;
  event.preventDefault();
  const wins = BrowserWindow.getAllWindows();
  void Promise.all(wins.map((w) => requestFlushAndAwait(w))).finally(() => {
    appQuitFlushComplete = true;
    appQuitFlushInProgress = false;
    app.quit();
  });
});

// ─── §3.4 single-instance + URL scheme ────────────────────────────────────
//
// `requestSingleInstanceLock` returns false in any secondary process; we exit
// immediately so the first instance can claim focus and pivot to the new doc.
// macOS handles file/URL handoff via `open-file`/`open-url`; Windows + Linux
// hand it through `second-instance` argv.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const open = extractPathFromArgv(argv);
    if (primaryWindow) {
      if (primaryWindow.isMinimized()) primaryWindow.restore();
      primaryWindow.focus();
    }
    if (open) queueExternalOpen(open);
  });
  // `open-url` (macOS) fires for reviewpdf:// invocations. Listener must be
  // registered before whenReady() so a cold-launch URL isn't missed.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const parsed = parseReviewpdfUrl(url);
    if (parsed) queueExternalOpen(parsed);
  });
  // `open-file` (macOS) fires when a file is dragged onto the dock icon /
  // double-clicked while we're the default handler. Same buffering path —
  // drag-from-Finder has no rig context, so `from: null`.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    queueExternalOpen({ path, from: null });
  });
  // Register reviewpdf:// scheme. In dev (electron-vite spawns electron with
  // an argv chain) we have to pass our entry point so the OS can re-launch us.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('reviewpdf', process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('reviewpdf');
  }
  // Initial argv: skip the electron exe at [0] and (in dev) the script path
  // at [1]; everything from there is user-supplied.
  const userArgv = process.defaultApp ? process.argv.slice(2) : process.argv.slice(1);
  const initialOpen = extractPathFromArgv(userArgv);
  if (initialOpen) queueExternalOpen(initialOpen);
}

void app.whenReady().then(async () => {
  // M-md-0: migrate sha256-keyed sidecars to path-based before any doc opens.
  await runSidecarMigration(app.getPath('userData'));

  // Smoke-test IPC retained from the empty-shell milestone.
  ipcMain.handle('ping', (_event, message: string) => {
    return `pong: ${message}`;
  });

  // Renderer signals readiness for external-open events once it has wired
  // its handler. Anything we queued during cold launch flushes here.
  ipcMain.on('app:externalOpenReady', (event) => {
    if (primaryWindow && event.sender === primaryWindow.webContents) {
      rendererReadyForExternalOpens = true;
      flushExternalOpens();
    }
  });

  // Engine version probe — walks the §13.1 resolution chain and spawns
  // `review-pdf --version`. Returns a structured EngineResult; the renderer
  // never sees a thrown error, just a discriminated union to branch on.
  ipcMain.handle('engine:version', async () => engineVersion());

  // PDF pre-flight health check — runs `review-pdf pdf-health --pdf <path>`
  // and parses the JSON report. Drives the §5.2 load-time banner. Exits 0/2/21
  // all carry a usable report; only true engine failures (binary missing,
  // spawn error, non-JSON stdout) come through as ok:false.
  ipcMain.handle('engine:pdfHealth', async (_event, pdfPath: string) => pdfHealth(pdfPath));

  // Native open-file dialog for picking a PDF. Returns the picked path,
  // or `path: null` if the user canceled. The renderer follows up with
  // pdfHealth() + readPdfBytes() to actually load the document.
  ipcMain.handle('dialog:openPdf', async (event): Promise<OpenPdfDialogResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined as any, {
      title: 'Open PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0] };
  });

  // Read a PDF off disk for the renderer. Sandboxed renderer can't open
  // file:// URLs; we ship bytes across the IPC boundary instead. Path is
  // resolved relative to main's cwd (desktop/ during dev).
  ipcMain.handle('fs:readPdfBytes', async (_event, pdfPath: string): Promise<ReadPdfBytesResult> => {
    const resolvedPath = resolve(pdfPath);
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
  });

  // Read the drafts snapshot for this PDF. Missing file is the common
  // first-open case — surfaced as ok:true with file:null so the renderer
  // can `?? []` cleanly. Parse errors are a different story (corrupted
  // file) and come through as ok:false.
  ipcMain.handle('drafts:read', async (_event, pdfPath: string, _sha256: string): Promise<DraftsReadResult> => {
    const filePath = draftsPathFor(pdfPath);
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
          const fp = await buildFingerprint(resolve(pdfPath));
          const match = await findSidecarByFingerprint(draftsDir, fp);
          if (match) {
            // Relink: move the sidecar to the new path and update its
            // fingerprint. Migrate v1 → v2 lazily (§3.3) before writing so the
            // relinked file lands as v2.
            const migrated = migrateDraftsToV2(match.drafts, draftFormatForPath(pdfPath));
            migrated.doc_fingerprint = {
              ...fp,
              last_known_path: resolve(pdfPath),
            };
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, JSON.stringify(migrated, null, 2), 'utf8');
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
      const file = migrateDraftsToV2(parsed, draftFormatForPath(pdfPath));
      return { ok: true, file, filePath };
    } catch (err) {
      return {
        ok: false,
        reason: 'parse_failed',
        filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Snapshot write — atomic via tmp + rename so a crash mid-write can't
  // leave a half-written drafts file. Renderer debounces, so we don't
  // also debounce here.
  ipcMain.handle(
    'drafts:write',
    async (_event, pdfPath: string, _sha256: string, file: DraftsFile): Promise<DraftsWriteResult> => {
      const filePath = draftsPathFor(pdfPath);
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
      const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf8');
        await rename(tmpPath, filePath);
        return { ok: true, filePath };
      } catch (err) {
        // Best-effort cleanup of the orphan tmp file; don't surface its error.
        await unlink(tmpPath).catch(() => {});
        return {
          ok: false,
          reason: 'write_failed',
          filePath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  // §3.1 — native folder picker for the left-drawer root.
  ipcMain.handle('dialog:openFolder', async (event): Promise<OpenFolderDialogResult> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win ?? undefined as any, {
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
  ipcMain.handle('fs:listDir', async (_event, path: string): Promise<ListDirResult> => {
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
  });

  // §3.3 launch boot — check the remembered root still exists before we try
  // to list it. Renderer falls back to the empty state if not.
  ipcMain.handle('fs:pathExists', async (_event, path: string): Promise<PathExistsResult> => {
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
  });

  // M-md-3 — write text to disk (for .md save). Atomic via tmp+rename.
  ipcMain.handle(
    'fs:writeFileText',
    async (_event, filePath: string, content: string): Promise<WriteFileTextResult> => {
      const resolvedPath = resolve(filePath);
      try {
        await mkdir(dirname(resolvedPath), { recursive: true });
      } catch (err) {
        return {
          ok: false, reason: 'mkdir_failed', filePath: resolvedPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const tmpPath = `${resolvedPath}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmpPath, content, 'utf8');
        await rename(tmpPath, resolvedPath);
        return { ok: true, filePath: resolvedPath };
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        return {
          ok: false, reason: 'write_failed', filePath: resolvedPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  // M-md-3 — file watcher for external modification detection.
  let fileWatcher: FSWatcher | null = null;
  let fileWatchPath: string | null = null;
  let fileWatchSuppressUntil = 0;

  ipcMain.handle('fs:watchFile', async (event, filePath: string) => {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    const resolvedPath = resolve(filePath);
    fileWatchPath = resolvedPath;
    try {
      fileWatcher = watch(resolvedPath, (eventType) => {
        if (Date.now() < fileWatchSuppressUntil) return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send('file:change', { filePath: resolvedPath, kind: eventType });
        }
      });
    } catch { /* file may not exist yet — non-fatal */ }
  });

  ipcMain.handle('fs:unwatchFile', async () => {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    fileWatchPath = null;
  });

  // Suppress file-change events for 1s after we write — avoids triggering
  // the external-modification modal from our own save.
  ipcMain.on('fs:suppressFileWatch', () => {
    fileWatchSuppressUntil = Date.now() + 1000;
  });

  // §3.3 persisted state. Same atomic-write pattern as drafts (temp + rename)
  // so a crash mid-write can't corrupt the boot record.
  ipcMain.handle('appState:read', async (): Promise<AppStateReadResult> => {
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

  ipcMain.handle('appState:write', async (_event, state: AppStateFile): Promise<AppStateWriteResult> => {
    const filePath = appStatePath();
    try {
      await mkdir(dirname(filePath), { recursive: true });
    } catch (err) {
      return {
        ok: false, reason: 'mkdir_failed', filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmpPath, filePath);
      return { ok: true, filePath };
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      return {
        ok: false, reason: 'write_failed', filePath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // §3.5 — recursive PDF index for the Cmd+P palette. Walks under `root`,
  // skipping the hidden-by-default dir list (no override; the user doesn't
  // Cmd+P search for files inside node_modules). Soft cap at 20 000 hits to
  // bound the walk on accidentally-pointed-at home dirs.
  ipcMain.handle('fs:indexPdfs', async (_event, root: string): Promise<IndexPdfsResult> => {
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
          if (classifyFile(d.name) !== 'pdf') continue;
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
  });

  // §10.1 step 6 + §10.3 — results-file watcher lifecycle. Renderer calls
  // start right after loadPdf resolves a sha256; stop fires on doc switch
  // or app teardown. Main pushes parsed events to the renderer via
  // `results:event`. See results-watcher.ts for the full contract.
  ipcMain.handle(
    'results:watchStart',
    async (event, pdfPath: string, sha256: string): Promise<ResultsWatchStartResult> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        return {
          ok: false,
          reviewStateDir: dirname(resolve(pdfPath)),
          reason: 'watch_failed',
          error: 'no window for sender',
        };
      }
      return startResultsWatch(win, resolve(pdfPath), sha256);
    }
  );
  ipcMain.handle('results:watchStop', () => {
    stopResultsWatch();
  });

  // §10.4 — bundle writer. Renderer calls this from Cmd+S (export) and
  // Cmd+Return (submit, after which rev-1md.4 layers the gt-mail sling).
  // Stateless: every write is a fresh render of the source PDF with the
  // current draft comments as annotations. Filename collisions on the
  // same date overwrite by design (audit trail is per-day).
  ipcMain.handle(
    'bundle:write',
    async (_event, request: BundleWriteRequest): Promise<BundleWriteResult> => {
      return writeBundleImpl(request);
    }
  );

  // §10.1 Submit flow (rev-1md.4) — three operations:
  //   submit:promote        write `.review-state/submit-<ts>.json`
  //   submit:sling          spawn `gt mail send` with the rev-2k7 payload
  //   submit:abandonRound   soft-tombstone an in-progress results file
  ipcMain.handle(
    'submit:promote',
    async (_event, request: SubmitPromoteRequest) => promoteDraft(request),
  );
  ipcMain.handle(
    'submit:sling',
    async (_event, request: SubmitSlingRequest) => slingViaGtMail(request),
  );
  ipcMain.handle(
    'submit:abandonRound',
    async (_event, request: SubmitAbandonRequest) => abandonRound(request),
  );

  // §9.2 embedded Claude pane — pty manager (rev-1md.2).
  registerClaudePtyIpc();

  const mainWin = createWindow();
  // Project 4 / M-int-2: React agent-pane IPC handlers. Coexists with the
  // legacy claude-pty above; the renderer chooses which path via the
  // localStorage feature flag (see desktop/renderer/index.ts).
  registerAgentPaneIpc(mainWin);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow();
      rebindMainWindow(newWin);
    }
  });
});

// Tear the watcher down on quit so the underlying fs.watch handle releases
// cleanly. before-quit fires before window close on Cmd+Q; window-all-closed
// covers the non-darwin path.
app.on('before-quit', async () => {
  stopResultsWatch();
  shutdownClaudePty();
  await shutdownAgentPane();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
