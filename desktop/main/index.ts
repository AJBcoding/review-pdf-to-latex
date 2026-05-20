import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { engineVersion, pdfHealth } from './engine.js';
import type {
  DraftsFile,
  DraftsReadResult,
  DraftsWriteResult,
  OpenPdfDialogResult,
  ReadPdfBytesResult,
} from '@shared/types';

/** Drafts file location per the user's decision: next to the PDF in a
 *  hidden `.review-state/drafts/` dotfile dir. Hash-based filename means
 *  copying or renaming the PDF doesn't lose the drafts. */
function draftsPathFor(pdfPath: string, sha256: string): string {
  return join(dirname(resolve(pdfPath)), '.review-state', 'drafts', `${sha256}.json`);
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

  return win;
}

void app.whenReady().then(() => {
  // Smoke-test IPC retained from the empty-shell milestone.
  ipcMain.handle('ping', (_event, message: string) => {
    return `pong: ${message}`;
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
  ipcMain.handle('drafts:read', async (_event, pdfPath: string, sha256: string): Promise<DraftsReadResult> => {
    const filePath = draftsPathFor(pdfPath, sha256);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: true, file: null, filePath, reason: 'not_found' };
      }
      return { ok: false, reason: 'read_failed', filePath, error: e.message };
    }
    try {
      const parsed = JSON.parse(raw) as DraftsFile;
      return { ok: true, file: parsed, filePath };
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
    async (_event, pdfPath: string, sha256: string, file: DraftsFile): Promise<DraftsWriteResult> => {
      const filePath = draftsPathFor(pdfPath, sha256);
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
