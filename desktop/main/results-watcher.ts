// §10.1 step 6 + §10.3 — watch `.review-state/` for results-*.json files
// the rig writes as it processes a round, and push parsed events to the
// renderer so the right-drawer cards can re-bucket and the round-status
// banner can update.
//
// Why this lives in main rather than the renderer: `fs.watch` requires
// node-fs access, which the sandboxed renderer doesn't have. Same reason
// drafts read/write is brokered here.
//
// Watcher lifecycle:
//   1. Renderer calls watchResultsStart(pdfPath, sha256) right after loadPdf
//      resolves a sha256.
//   2. Main resolves `.review-state/` next to the PDF and does an *initial
//      scan* (existing results files) before installing fs.watch. Each
//      matching file emits a `source:'initial'` event so the renderer can
//      apply pre-existing statuses on first paint (the "previous round was
//      interrupted — resume?" affordance from §10.1 step 6 falls out of
//      this scan).
//   3. fs.watch fires on subsequent create/modify of results-*.json (and
//      submit-*.json — we re-read when those land so a delayed submit file
//      can still match an earlier results file). Each emit is debounced
//      per filename to coalesce the burst fs.watch tends to produce.
//   4. Renderer switches docs → watchResultsStop() → existing watcher closes;
//      a fresh watchResultsStart fires for the new doc.
//
// Doc matching: results-*.json carries only `submit_id`, no sha256. We pair
// it with the matching submit-*.json (same dir, same submit_id) and compare
// `submit.doc_version` against the renderer-supplied sha256. Mismatched
// files are still emitted but with `matchesDoc:false` so the renderer can
// ignore them; we surface them deliberately for diagnostics rather than
// silently dropping.

import { BrowserWindow } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ResultsEvent,
  ResultsFile,
  ResultsWatchStartResult,
  SubmitFile,
} from '@shared/types';
import { normalizeResultsFile, normalizeSubmitFile } from '@shared/comments';

const RESULTS_RE = /^results-.+\.json$/;
const SUBMIT_RE = /^submit-.+\.json$/;
const DEBOUNCE_MS = 120;

interface ActiveWatch {
  pdfPath: string;
  sha256: string;
  reviewStateDir: string;
  watcher: FSWatcher;
  /** Pending debounce timers keyed on basename. fs.watch typically fires
   *  multiple events per real change (rename + change) — debouncing per
   *  filename collapses those into a single re-read. */
  pending: Map<string, NodeJS.Timeout>;
  /** Cached submit file contents keyed on `submit_id`. Avoids re-parsing
   *  submits every time a results file referencing them changes. Cleared
   *  per-watch (so doc-switch starts fresh). */
  submitCache: Map<string, SubmitFile>;
  /** Cached `submit_id` per submit file path. Lets us invalidate `submitCache`
   *  entries when the underlying submit file changes. */
  submitPathToId: Map<string, string>;
}

let active: ActiveWatch | null = null;

export function isResultsName(name: string): boolean {
  return RESULTS_RE.test(name) && !name.endsWith('.abandoned.json');
}
function isSubmitName(name: string): boolean {
  return SUBMIT_RE.test(name);
}

/** Best-effort JSON read. Returns null on any failure (ENOENT, parse error,
 *  permission denied). All callers treat null as "not yet readable" — the
 *  watcher fires again when the file is finished writing. */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadSubmit(
  state: ActiveWatch,
  submitId: string,
): Promise<SubmitFile | null> {
  const cached = state.submitCache.get(submitId);
  if (cached) return cached;
  // Scan the dir for `submit-*.json` whose contents match this submit_id.
  // Submit files name themselves with a timestamp, not the submit_id, so we
  // can't construct the path directly.
  let dirents;
  try {
    dirents = await readdir(state.reviewStateDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirents) {
    if (!d.isFile() || !isSubmitName(d.name)) continue;
    const submitPath = join(state.reviewStateDir, d.name);
    const raw = await readJsonFile<SubmitFile>(submitPath);
    if (!raw) continue;
    // v2-results tolerance: a v1 submit file read off disk presents as
    // union-shaped (bare anchors → pdf-quad; pdf_annotation_id → native).
    const parsed = normalizeSubmitFile(raw);
    state.submitCache.set(parsed.submit_id, parsed);
    state.submitPathToId.set(submitPath, parsed.submit_id);
    if (parsed.submit_id === submitId) return parsed;
  }
  return null;
}

async function emitResultsFile(
  state: ActiveWatch,
  win: BrowserWindow,
  resultsPath: string,
  source: 'initial' | 'change',
): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  const parsed = await readJsonFile<ResultsFile>(resultsPath);
  if (!parsed) return;
  // v2-results tolerance (§4.4 step 1): normalize so every new_anchor is the
  // union shape regardless of whether the rig wrote v1 (bare {page,region}) or
  // v2 ({kind:...}). The renderer only ever sees union anchors.
  const results = normalizeResultsFile(parsed);
  const submit = await loadSubmit(state, results.submit_id);
  const matchesDoc = submit !== null && submit.doc_version === state.sha256;
  const event: ResultsEvent = {
    filePath: resultsPath,
    results,
    submit,
    matchesDoc,
    source,
  };
  try {
    win.webContents.send('results:event', event);
  } catch {
    // webContents torn down between guard and send — drop silently.
  }
}

/** Re-emit every existing results-*.json in the watched dir. Runs once at
 *  watchStart so "resume?" / pre-existing terminal statuses get reflected
 *  even when the rig finished a round while the app was closed. */
async function initialScan(state: ActiveWatch, win: BrowserWindow): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(state.reviewStateDir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort by name (timestamp-prefixed) so the renderer sees rounds in
  // chronological order — §10.3 "Multiple results files for same doc
  // (rounds 1, 2, 3): apply in timestamp order".
  const names = dirents
    .filter((d) => d.isFile() && isResultsName(d.name))
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    await emitResultsFile(state, win, join(state.reviewStateDir, name), 'initial');
  }
}

function handleFsEvent(
  state: ActiveWatch,
  win: BrowserWindow,
  filename: string | null,
): void {
  if (!filename) return;
  // fs.watch fires for every direntry change in the watched dir; ignore
  // anything that isn't a results or submit file. (e.g., drafts/ subdir
  // mutations from the renderer's debounced drafts writes.)
  const isResults = isResultsName(filename);
  const isSubmit = isSubmitName(filename);
  if (!isResults && !isSubmit) return;

  // Debounce per filename: fs.watch typically fires a `rename` *and* a
  // `change` (sometimes multiple `change`s) for a single atomic write.
  const existing = state.pending.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.pending.delete(filename);
    void processFsEvent(state, win, filename, isResults, isSubmit);
  }, DEBOUNCE_MS);
  state.pending.set(filename, timer);
}

async function processFsEvent(
  state: ActiveWatch,
  win: BrowserWindow,
  filename: string,
  isResults: boolean,
  isSubmit: boolean,
): Promise<void> {
  const fullPath = join(state.reviewStateDir, filename);
  // Confirm the file actually exists; a `rename` event also fires on delete.
  let exists = true;
  try { await stat(fullPath); } catch { exists = false; }

  if (isSubmit) {
    // Invalidate the submit cache for this path (the file may have been
    // overwritten with new contents) so the next results->submit lookup
    // re-reads it. Then re-emit any results files that reference its
    // submit_id, in case they were earlier deemed `matchesDoc:false` on
    // account of the submit file being missing.
    const cachedId = state.submitPathToId.get(fullPath);
    if (cachedId !== undefined) {
      state.submitCache.delete(cachedId);
      state.submitPathToId.delete(fullPath);
    }
    if (!exists) return;
    // Pre-warm the cache so the subsequent results re-emit doesn't have to
    // re-scan the whole dir.
    const raw = await readJsonFile<SubmitFile>(fullPath);
    if (raw) {
      const parsed = normalizeSubmitFile(raw);
      state.submitCache.set(parsed.submit_id, parsed);
      state.submitPathToId.set(fullPath, parsed.submit_id);
      // Re-emit any results files that reference this submit_id. The
      // re-emit is cheap (single readFile) and lets a late-arriving submit
      // file unblock results that landed first.
      let dirents;
      try {
        dirents = await readdir(state.reviewStateDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (!d.isFile() || !isResultsName(d.name)) continue;
        const candidate = await readJsonFile<ResultsFile>(
          join(state.reviewStateDir, d.name)
        );
        if (candidate && candidate.submit_id === parsed.submit_id) {
          await emitResultsFile(
            state, win, join(state.reviewStateDir, d.name), 'change'
          );
        }
      }
    }
    return;
  }

  if (isResults) {
    if (!exists) return;
    await emitResultsFile(state, win, fullPath, 'change');
  }
}

export async function startWatch(
  win: BrowserWindow,
  pdfPath: string,
  sha256: string,
): Promise<ResultsWatchStartResult> {
  // Always tear down any previous watch first — switching docs / re-opening
  // the same doc both call watchStart fresh and we don't want stacked
  // watchers fighting for the same dir.
  stopWatch();

  const reviewStateDir = resolve(join(dirname(pdfPath), '.review-state'));
  try {
    const s = await stat(reviewStateDir);
    if (!s.isDirectory()) {
      return { ok: false, reviewStateDir, reason: 'enoent', error: 'not a directory' };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      // No `.review-state/` yet — nothing to watch, nothing to scan. Not an
      // error per se: the dir gets created on first draft write. Return ok
      // so the renderer doesn't show a diagnostic. Callers can re-invoke
      // watchStart later if needed (we don't currently, since drafts write
      // happens through the same dir and the renderer can re-start the
      // watcher on the next doc-load if a results file ever lands).
      return { ok: true, reviewStateDir };
    }
    return { ok: false, reviewStateDir, reason: 'enoent', error: e.message };
  }

  let watcher: FSWatcher;
  try {
    watcher = watch(reviewStateDir, { persistent: false });
  } catch (err) {
    return {
      ok: false,
      reviewStateDir,
      reason: 'watch_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const state: ActiveWatch = {
    pdfPath,
    sha256,
    reviewStateDir,
    watcher,
    pending: new Map(),
    submitCache: new Map(),
    submitPathToId: new Map(),
  };
  active = state;

  watcher.on('change', (_evtType, filename) => {
    if (active !== state) return; // stale watcher firing after stopWatch
    const name = typeof filename === 'string' ? filename : filename?.toString() ?? null;
    handleFsEvent(state, win, name);
  });
  watcher.on('error', () => {
    // fs.watch error events are advisory — the underlying handle may still
    // be live. We don't try to surface this to the renderer beyond what the
    // (eventual) downstream emit failures already do.
  });

  await initialScan(state, win);
  return { ok: true, reviewStateDir };
}

export function stopWatch(): void {
  if (!active) return;
  try { active.watcher.close(); } catch { /* already closed */ }
  for (const t of active.pending.values()) clearTimeout(t);
  active = null;
}
