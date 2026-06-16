// ─── §3.4 external-open: launch routing + cold-start queue ─────────────────
//
// CLI args / second-instance argv / open-url / open-file events can arrive
// *before* the renderer has wired its handler. We buffer them and flush once
// the renderer signals it's ready, so a request never gets dropped on cold
// launch. This module owns the single-instance lock, the reviewpdf:// scheme
// registration, and the primary-window reference the flush targets.
//
// §10.5.1 — `--from <rig-id>` rides alongside the path so the renderer can
// record the originating rig in AppState (per-doc keying) and route Submit to
// it without a destination picker. Null means standalone.

import { app, BrowserWindow, ipcMain } from 'electron';
import { isAbsolute, resolve } from 'node:path';
import { classifyPath } from '@shared/file-kinds';

interface ExternalOpen { path: string; from: string | null }

const pendingExternalOpens: ExternalOpen[] = [];
let rendererReadyForExternalOpens = false;
let primaryWindow: BrowserWindow | null = null;

/** Register the window the cold-launch queue flushes to. Called by
 *  createWindow once the BrowserWindow exists. Flushing anything already
 *  queued is deferred until the renderer signals readiness. */
export function setPrimaryWindow(win: BrowserWindow): void {
  primaryWindow = win;
}

/** Drop the primary-window reference when that window closes, so a stale
 *  handle can't be sent to. */
export function clearPrimaryWindow(win: BrowserWindow): void {
  if (primaryWindow === win) primaryWindow = null;
}

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
export function parseReviewpdfUrl(raw: string): { path: string; from: string | null } | null {
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
 *    review-pdf-app <path>          (any positional openable doc — pdf, md,
 *                                    html, docx — for drag-and-drop or direct
 *                                    file association)
 *    reviewpdf://open?path=...      (URL handed in via argv on Windows/Linux)
 *
 *  The bare-positional case admits any path the §X7 FileKind classifier
 *  recognizes (not just `.pdf`), so opening a `.md`/`.html`/`.docx` from the
 *  shell routes the same way a PDF does.
 *
 *  §10.5.1 `--from <rig-id>` may appear anywhere in argv. We extract it
 *  whether or not a path was found, but only return it when paired with
 *  a path (the rig context is meaningless without a doc to open). Bare
 *  `--from=<rig-id>` is also accepted for shell convenience. */
export function extractPathFromArgv(argv: readonly string[]): { path: string; from: string | null } | null {
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
  // picked up as positional candidates if someone passes them in an
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
    if (!a.startsWith('-') && classifyPath(a) !== 'other') return { path: a, from };
  }
  return null;
}

// ─── §3.4 single-instance + URL scheme ────────────────────────────────────
//
// `requestSingleInstanceLock` returns false in any secondary process; we exit
// immediately so the first instance can claim focus and pivot to the new doc.
// macOS handles file/URL handoff via `open-file`/`open-url`; Windows + Linux
// hand it through `second-instance` argv.
//
// Returns false when this is a secondary instance (caller should bail out of
// the rest of bootstrap — `app.quit()` has already been requested). Returns
// true in the primary instance after wiring all launch-routing listeners.
export function setupSingleInstance(): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
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
  return true;
}

/** whenReady hook: the renderer signals it has wired its external-open handler.
 *  Anything queued during cold launch flushes the moment it's ready. */
export function registerExternalOpenReady(): void {
  ipcMain.on('app:externalOpenReady', (event) => {
    if (primaryWindow && event.sender === primaryWindow.webContents) {
      rendererReadyForExternalOpens = true;
      flushExternalOpens();
    }
  });
}
