import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { engineVersion, pdfHealth } from './engine.js';
import { startWatch as startResultsWatch, stopWatch as stopResultsWatch } from './results-watcher.js';
import { writeBundle as writeBundleImpl } from './bundle.js';
import { registerAgentPaneIpc, rebindMainWindow } from './agent-pane-ipc.js';
import {
  promoteDraft,
  slingViaGtMail,
  abandonRound,
} from './submit.js';
import { typedHandle } from './typed-ipc.js';
import { assertObjectArg, assertPathArg, assertStringArg } from './ipc-validators.js';
import { registerFsIpc } from './fs-ipc.js';
import { registerDocxIpc } from './docx-ipc.js';
import {
  clearPrimaryWindow,
  registerExternalOpenReady,
  setPrimaryWindow,
  setupSingleInstance,
} from './external-open.js';
import { attachDraftsFlushHandshake, installQuitTeardown } from './quit-flush.js';
import type {
  BundleWriteResult,
  ResultsWatchStartResult,
} from '@shared/comments';

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
  setPrimaryWindow(win);
  win.on('closed', () => clearPrimaryWindow(win));
  return win;
}

// §3.4 single-instance lock + reviewpdf:// scheme + launch-routing listeners.
// In a secondary instance this requests quit and returns false; skip the rest
// of bootstrap so the first instance owns the session.
if (setupSingleInstance()) {
  // The single before-quit teardown (flush → agent shutdown → watcher stop).
  // Registered once, before whenReady, so a quit during early boot still
  // drains cleanly.
  installQuitTeardown();

  void app.whenReady().then(async () => {
    // Smoke-test IPC retained from the empty-shell milestone.
    typedHandle('ping', (_event, message) => {
      return `pong: ${message}`;
    }, ([message]) => assertStringArg('ping', message));

    // Renderer readiness for buffered cold-launch external opens.
    registerExternalOpenReady();

    // Engine version probe — walks the §13.1 resolution chain and spawns
    // `review-pdf --version`. Returns a structured EngineResult; the renderer
    // never sees a thrown error, just a discriminated union to branch on.
    typedHandle('engineVersion', async () => engineVersion());

    // PDF pre-flight health check — runs `review-pdf pdf-health --pdf <path>`
    // and parses the JSON report. Drives the §5.2 load-time banner. Exits
    // 0/2/21 all carry a usable report; only true engine failures (binary
    // missing, spawn error, non-JSON stdout) come through as ok:false.
    typedHandle('pdfHealth', async (_event, pdfPath) => pdfHealth(pdfPath),
      ([pdfPath]) => assertPathArg('engine:pdfHealth', pdfPath));

    // §3.x filesystem + document surface (dialogs, bytes, drafts, app state,
    // dir listing, recursive index, text write, file watch).
    registerFsIpc();

    // §5.3 / L5 — native DOCX comments surface (read on open; create/edit/delete
    // route to the comments.xml adapter). Renderer folds the reads in as
    // native-docx cards alongside app drafts.
    registerDocxIpc();

    // §10.1 step 6 + §10.3 — results-file watcher lifecycle. Renderer calls
    // start right after loadPdf resolves a sha256; stop fires on doc switch
    // or app teardown. Main pushes parsed events to the renderer via
    // `results:event`. See results-watcher.ts for the full contract.
    typedHandle(
      'watchResultsStart',
      async (event, pdfPath, sha256): Promise<ResultsWatchStartResult> => {
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
      },
      ([pdfPath, sha256]) => {
        assertPathArg('results:watchStart', pdfPath);
        assertStringArg('results:watchStart sha256', sha256);
      },
    );
    typedHandle('watchResultsStop', () => {
      stopResultsWatch();
    });

    // §10.4 — bundle writer. Renderer calls this from Cmd+S (export) and
    // Cmd+Return (submit, after which rev-1md.4 layers the gt-mail sling).
    // Stateless: every write is a fresh render of the source PDF with the
    // current draft comments as annotations. Filename collisions on the
    // same date overwrite by design (audit trail is per-day).
    typedHandle(
      'writeBundle',
      async (_event, request): Promise<BundleWriteResult> => {
        return writeBundleImpl(request);
      },
      ([request]) => assertObjectArg('bundle:write', request),
    );

    // §10.1 Submit flow (rev-1md.4) — three operations:
    //   submit:promote        write `.review-state/submit-<ts>.json`
    //   submit:sling          spawn `gt mail send` with the rev-2k7 payload
    //   submit:abandonRound   soft-tombstone an in-progress results file
    typedHandle(
      'submitPromote',
      async (_event, request) => promoteDraft(request),
      ([request]) => assertObjectArg('submit:promote', request),
    );
    typedHandle(
      'submitSling',
      async (_event, request) => slingViaGtMail(request),
      ([request]) => assertObjectArg('submit:sling', request),
    );
    typedHandle(
      'submitAbandonRound',
      async (_event, request) => abandonRound(request),
      ([request]) => assertObjectArg('submit:abandonRound', request),
    );

    const mainWin = createWindow();
    // §9.2 embedded Claude pane — the React agent-pane (SDK route) is the only
    // surface as of X8 stage 4 (rev-enext.3); the legacy claude-pty route was
    // retired once the OD-3 parity checklist went green.
    registerAgentPaneIpc(mainWin);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const newWin = createWindow();
        rebindMainWindow(newWin);
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
