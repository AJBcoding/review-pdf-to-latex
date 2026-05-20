import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { engineVersion, pdfHealth } from './engine.js';
import type { ReadPdfBytesResult } from '@shared/types';

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
      return { ok: true, bytes: new Uint8Array(buf), resolvedPath };
    } catch (err) {
      return {
        ok: false,
        reason: 'read_failed',
        resolvedPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
