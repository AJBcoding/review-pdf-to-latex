// ─── Drafts flush handshake + single quit teardown (rev-cm6, rev-l9) ───────
//
// The renderer debounces draft writes 250ms (spec §10.3). Without a flush
// handshake, a Cmd+Q within 250ms of submitting a comment loses it: the
// debounce hasn't fired, the renderer is torn down, the comment never reaches
// disk. To close that gap, on app-quit and window-close we (a) cancel the
// default action, (b) ask the renderer to drain its pending write, (c) wait
// for an ack with a generous timeout, (d) then re-issue the close/quit.
//
// rev-l9: this module also owns the *single* `before-quit` teardown. There was
// previously a second, independent `before-quit` handler running engine
// teardown — and because the flush handler calls `app.quit()` again after
// draining, that second handler double-ran. Teardown now lives in one place,
// sequenced after the flush completes: flush → agent shutdown → watcher stop.

import { app, BrowserWindow, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { shutdownAgentPane } from './agent-pane-ipc.js';
import { stopWatch as stopResultsWatch } from './results-watcher.js';

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

/** Attach the per-window close-flush. Called by createWindow for each window. */
export function attachDraftsFlushHandshake(win: BrowserWindow): void {
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

/** Install the single `before-quit` teardown. Call once at startup.
 *
 *  On the first quit we cancel the default, drain every window's pending
 *  drafts write, then run engine teardown in the spec order (agent shutdown
 *  before watcher stop) and re-issue the quit. The completion guard makes the
 *  re-issued quit a no-op, so teardown runs exactly once — no double-run. */
export function installQuitTeardown(): void {
  app.on('before-quit', (event) => {
    if (appQuitFlushComplete || appQuitFlushInProgress) return;
    appQuitFlushInProgress = true;
    event.preventDefault();
    const wins = BrowserWindow.getAllWindows();
    void Promise.all(wins.map((w) => requestFlushAndAwait(w)))
      .then(async () => {
        // Teardown after the flush has landed: agent SDK sessions first, then
        // the results-file watcher so its fs.watch handle releases cleanly.
        await shutdownAgentPane();
        stopResultsWatch();
      })
      .finally(() => {
        appQuitFlushComplete = true;
        appQuitFlushInProgress = false;
        app.quit();
      });
  });
}
