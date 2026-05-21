import type {
  AppStateFile,
  CommentPayload,
  DraftsFile,
  EngagementLevel,
  EngineResult,
  PdfHealthResult,
  ReadPdfBytesResult,
} from '@shared/types';
import { PdfViewer, type SelectionPayload } from './pdf-viewer';
import { FileTree } from './tree';
import { QuickOpenPalette } from './palette';

/** Cross-platform path basename — avoids dragging in a node path polyfill
 * just for the title-bar label. Handles both POSIX and Windows separators. */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Renderer entry. Milestone #2 (project-open flow):
//
//   1. Two startup diagnostics — IPC bridge + engine reachability — surface
//      in the top-right strip so AJB can confirm the engine is wired up
//      without having to open a PDF.
//   2. Empty state in the document pane until the user picks a file.
//   3. Open… button → native picker → pdfHealth() + readPdfBytes() run in
//      parallel → render the page + surface the §5.2 banner if the report
//      flags problems.
//
// The §5.2 banner copy mirrors the spec's load-time pre-flight requirement:
// distinct messages for encrypted / all-unreadable / partial / ligature-loss /
// open-error, and no banner at all when the PDF is clean.

interface ViewerHandles {
  viewer: PdfViewer;
  mount: HTMLElement;
  empty: HTMLElement;
  title: HTMLElement;
  banner: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  fitPageBtn: HTMLButtonElement;
  fitWidthBtn: HTMLButtonElement;
  darkBtn: HTMLButtonElement;
}

/** Active comment-tool state (§4.2). Maps 1:1 to `engagement_level` (§11.1). */
type Tool = EngagementLevel;

interface DocState {
  /** Absolute path of the currently loaded PDF. Doubles as `doc_id` for v1
   *  (no project model yet — a doc's identity is its path on disk). */
  path: string;
  /** Content sha256 from main. Used as `doc_version` (§8) and as the drafts
   *  filename so renames/copies of the PDF don't lose the drafts. Empty
   *  string until a PDF is loaded. */
  sha256: string;
  /** Last non-empty selection the viewer reported. Persists across submits
   *  so the user can stack Comment + Redraft against the same highlight. */
  lastSelection: SelectionPayload | null;
  /** In-memory mirror of the drafts file. The render-the-stream code reads
   *  this — main only sees it on debounced writes. */
  comments: CommentPayload[];
}

const docState: DocState = { path: '', sha256: '', lastSelection: null, comments: [] };
let activeTool: Tool = 'comment';
let viewerRef: PdfViewer | null = null;

// ─── Drafts write debounce (§10.3 — 250ms) ─────────────────────────────────
let writeTimer: number | null = null;
const WRITE_DEBOUNCE_MS = 250;

function scheduleDraftsWrite(): void {
  if (!docState.path || !docState.sha256) return;
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    void flushDraftsWrite();
  }, WRITE_DEBOUNCE_MS);
}

async function flushDraftsWrite(): Promise<void> {
  if (!docState.path || !docState.sha256) return;
  const file: DraftsFile = {
    schema_version: 1,
    doc_version: docState.sha256,
    comments: docState.comments,
  };
  const res = await window.electronAPI.writeDrafts(docState.path, docState.sha256, file);
  if (!res.ok) {
    // Surface persistence failures so the user knows their work isn't
    // saved. Non-blocking — the in-memory state is still authoritative
    // until the next successful write.
    flashAnchorMeta(`Drafts save failed (${res.reason}): ${res.error}`);
  }
}

async function init() {
  wireDraftsQuitFlush();
  await mountStartupDiagnostics();
  bootProjectOpenFlow();
  await bootLeftDrawerAndPalette();
  // Verification scripts (and humans poking at devtools) can wait on this
  // to know all async boot work — including state restore — has settled.
  (window as unknown as { __APP_READY?: boolean }).__APP_READY = true;
}

// ─── §3 left drawer + §3.5 palette ────────────────────────────────────────
//
// Owns: a FileTree instance, a QuickOpenPalette instance, the AppState
// snapshot, and the external-file open handler. Glue only — the tree and
// palette modules are presentation; persistence + cross-module wiring lives
// here so the modules stay focused on their UI concerns.

let fileTree: FileTree | null = null;
let palette: QuickOpenPalette | null = null;
let viewerHandlesRef: ViewerHandles | null = null;
let appStateSaveTimer: number | null = null;
const APP_STATE_DEBOUNCE_MS = 250;

async function bootLeftDrawerAndPalette(): Promise<void> {
  const body = document.getElementById('treeBody');
  const title = document.getElementById('treeTitle');
  const empty = document.getElementById('treeEmpty');
  const openBtn = document.getElementById('treeOpenFolder') as HTMLButtonElement | null;
  const hiddenBtn = document.getElementById('treeToggleHidden') as HTMLButtonElement | null;
  const emptyOpenLink = document.getElementById('treeEmptyOpen');
  const paletteRoot = document.getElementById('palette');
  const paletteInput = document.getElementById('paletteInput') as HTMLInputElement | null;
  const paletteList = document.getElementById('paletteList');
  const paletteEmpty = document.getElementById('paletteEmpty');
  if (!body || !title || !empty || !openBtn || !hiddenBtn || !emptyOpenLink ||
      !paletteRoot || !paletteInput || !paletteList || !paletteEmpty) return;

  fileTree = new FileTree({
    body, title, empty, toggleHiddenBtn: hiddenBtn,
    onOpenFile: (path) => { void openFileFromTreeOrPalette(path); },
    onStateChange: () => { scheduleAppStateSave(); },
  });

  palette = new QuickOpenPalette({
    root: paletteRoot, input: paletteInput, list: paletteList, empty: paletteEmpty,
    onPick: (path) => { void openFileFromTreeOrPalette(path); },
  });

  openBtn.addEventListener('click', () => { void openFolderPicker(); });
  emptyOpenLink.addEventListener('click', (e) => { e.preventDefault(); void openFolderPicker(); });

  // §3.4 — main pushes external-open requests through this channel. We wire
  // it here (after the tree is alive) so loadPdf is always callable when
  // a buffered cold-launch request flushes.
  window.electronAPI.onOpenExternalFile((path) => { void openFileFromTreeOrPalette(path); });

  // §3.5 — Cmd+P opens the palette. Spec §15's focus discipline doesn't
  // gate this; a global accelerator is the expected affordance.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      palette?.open();
    }
  });

  // §3.3 — restore last session.
  await restoreFromAppState();
}

async function openFolderPicker(): Promise<void> {
  const picked = await window.electronAPI.openFolderDialog();
  if (!picked.path) return;
  await setRootAndIndex(picked.path);
  scheduleAppStateSave();
}

async function setRootAndIndex(root: string): Promise<void> {
  if (!fileTree) return;
  await fileTree.setRoot(root);
  // Fan out PDF indexing without blocking the tree from showing. Failures
  // are surfaced through the diagnostic strip rather than as a modal — the
  // tree itself is still useful even if Cmd+P doesn't work.
  void refreshPdfIndex(root);
}

async function refreshPdfIndex(root: string): Promise<void> {
  if (!palette) return;
  const res = await window.electronAPI.indexPdfs(root);
  if (!res.ok) {
    flashAnchorMeta(`Quick-open index failed (${res.reason}): ${res.error}`);
    palette.setIndex([]);
    return;
  }
  palette.setIndex(res.pdfs);
}

/** One canonical "open this PDF" entry point shared by the tree, the palette,
 *  and external handoff. loadPdf already handles the active-row + state-save
 *  side effects, so this is just a guarded passthrough. */
async function openFileFromTreeOrPalette(path: string): Promise<void> {
  if (!viewerHandlesRef) return;
  await loadPdf(viewerHandlesRef, path);
}

function scheduleAppStateSave(): void {
  if (appStateSaveTimer !== null) window.clearTimeout(appStateSaveTimer);
  appStateSaveTimer = window.setTimeout(() => {
    appStateSaveTimer = null;
    void flushAppStateSave();
  }, APP_STATE_DEBOUNCE_MS);
}

async function flushAppStateSave(): Promise<void> {
  if (!fileTree) return;
  const snap = fileTree.snapshot();
  const state: AppStateFile = {
    schema_version: 1,
    root: snap.root,
    last_opened_doc: docState.path || null,
    expanded_dirs: snap.expanded,
    show_hidden: snap.showHidden,
  };
  const res = await window.electronAPI.writeAppState(state);
  if (!res.ok) {
    flashAnchorMeta(`App-state save failed (${res.reason}): ${res.error}`);
  }
}

async function restoreFromAppState(): Promise<void> {
  if (!fileTree) return;
  const res = await window.electronAPI.readAppState();
  if (!res.ok) {
    flashAnchorMeta(`App-state load failed (${res.reason}): ${res.error}`);
    return;
  }
  if (!res.state) return; // fresh install / corrupted-and-reset — start clean
  const state = res.state;
  // Verify the remembered root still exists. If it was moved or deleted, we
  // silently fall back to the empty tree rather than throwing a modal — the
  // user's choices weren't wrong, the filesystem changed underneath.
  if (state.root) {
    const exists = await window.electronAPI.pathExists(state.root);
    if (exists.ok && exists.exists && exists.isDir) {
      await fileTree.restoreState({
        root: state.root,
        expanded: state.expanded_dirs,
        showHidden: state.show_hidden,
      });
      void refreshPdfIndex(state.root);
    } else {
      await fileTree.restoreState({ root: null, expanded: [], showHidden: state.show_hidden });
    }
  } else {
    await fileTree.restoreState({ root: null, expanded: [], showHidden: state.show_hidden });
  }
  // Re-open the last doc if it still exists and (when a root is set) lives
  // under that root. We don't enforce containment for the doc — external
  // handoff or pre-tree usage may have opened something outside the tree.
  if (state.last_opened_doc && viewerHandlesRef) {
    const exists = await window.electronAPI.pathExists(state.last_opened_doc);
    if (exists.ok && exists.exists && exists.isFile) {
      await loadPdf(viewerHandlesRef, state.last_opened_doc);
      fileTree.setActiveFile(state.last_opened_doc);
    }
  }
}

/** rev-cm6: drain the debounced drafts write before the window/app goes away.
 *
 *  Two paths:
 *    1. Main-side handshake — main sends `drafts:flushRequest` from its
 *       `before-quit` / `window.close` handlers and awaits our ack. This is
 *       the reliable path for Cmd+Q / Cmd+W.
 *    2. `beforeunload` fallback — covers paths the main-side hook can't
 *       intercept (devtools reload, navigation). Best-effort: async writes
 *       may not complete before the page is torn down, so this isn't a
 *       substitute for the handshake — just defense in depth.
 */
function wireDraftsQuitFlush(): void {
  window.electronAPI.onDraftsFlushRequest(async (id) => {
    // Only write if a debounced write was actually pending — otherwise the
    // ack is a no-op. Avoids writing an empty drafts file for documents the
    // user opens and closes without commenting (would litter the .review-state
    // dir next to every PDF the user even peeks at).
    if (writeTimer === null) {
      window.electronAPI.sendDraftsFlushAck(id);
      return;
    }
    window.clearTimeout(writeTimer);
    writeTimer = null;
    try { await flushDraftsWrite(); }
    finally { window.electronAPI.sendDraftsFlushAck(id); }
  });
  window.addEventListener('beforeunload', () => {
    if (writeTimer === null) return;
    window.clearTimeout(writeTimer);
    writeTimer = null;
    void flushDraftsWrite();
  });
}

async function mountStartupDiagnostics(): Promise<void> {
  const diag = document.getElementById('diag');
  if (!diag) return;

  const ipcLine = document.createElement('div');
  const engineLine = document.createElement('div');
  diag.append(ipcLine, engineLine);

  // 1. IPC bridge smoke-test
  try {
    const reply = await window.electronAPI.ping('hello from renderer');
    ipcLine.textContent = `electronAPI ✓  ${reply}`;
  } catch (err) {
    ipcLine.textContent = `electronAPI ✗  ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. Engine reachability probe (no longer blocks PDF-open; pdf-health is
  //    exercised per-document now, not at startup).
  try {
    const result = await window.electronAPI.engineVersion();
    engineLine.textContent = formatEngineResult(result);
  } catch (err) {
    engineLine.textContent = `engine ✗  IPC error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** rev-680: ID of the card the user last focused. Tracked at module scope
 *  so renderAllCards (which replaces the DOM nodes) can restore focus to
 *  the same logical comment if it still exists after a submit. */
let focusedCommentId: string | null = null;

/** rev-b8t: when set, the next submit replaces the named comment's body
 *  instead of creating a new one. Cleared on submit, Esc, or doc switch. */
let editingCommentId: string | null = null;

function bootProjectOpenFlow(): void {
  const mount = document.getElementById('pdfMount');
  const empty = document.getElementById('pdfEmpty');
  const title = document.getElementById('pdfTitle');
  const banner = document.getElementById('pdfBanner');
  const openBtn = document.getElementById('pdfOpen') as HTMLButtonElement | null;
  const prevBtn = document.getElementById('pdfPrev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('pdfNext') as HTMLButtonElement | null;
  const darkBtn = document.getElementById('pdfDarkToggle') as HTMLButtonElement | null;
  const fitPageBtn = document.getElementById('pdfFitPage') as HTMLButtonElement | null;
  const fitWidthBtn = document.getElementById('pdfFitWidth') as HTMLButtonElement | null;
  const pageLabel = document.getElementById('pdfPageLabel');
  if (
    !mount || !empty || !title || !banner ||
    !openBtn || !prevBtn || !nextBtn || !darkBtn ||
    !fitPageBtn || !fitWidthBtn || !pageLabel
  ) return;

  // The viewer takes over `mount`'s children, so we keep the empty state
  // as a sibling element and toggle visibility between them.
  const viewer = new PdfViewer({
    container: mount,
    onSelection: handleSelection,
    onPageInfo: ({ page, totalPages }) => {
      pageLabel.textContent = `${page} / ${totalPages}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= totalPages;
    },
  });
  viewerRef = viewer;

  const handles: ViewerHandles = {
    viewer, mount, empty, title, banner,
    prevBtn, nextBtn, fitPageBtn, fitWidthBtn, darkBtn,
  };
  // Exposed to bootLeftDrawerAndPalette so file-tree / palette / external
  // handoff all open through the same loadPdf path the Open… button uses.
  viewerHandlesRef = handles;

  bootToolPaletteAndInput();

  prevBtn.addEventListener('click', () => { void viewer.prevPage(); });
  nextBtn.addEventListener('click', () => { void viewer.nextPage(); });
  fitPageBtn.addEventListener('click', () => { void viewer.fitPage(); });
  fitWidthBtn.addEventListener('click', () => { void viewer.fitWidth(); });
  darkBtn.addEventListener('click', () => {
    viewer.setDarkMode(!viewer.isDarkMode());
    darkBtn.setAttribute('aria-pressed', String(viewer.isDarkMode()));
  });

  openBtn.addEventListener('click', () => { void handleOpenClick(handles, openBtn); });

  bindCommentStreamKeyboard();

  // ⌘O / Ctrl+O as a convenience accelerator. Spec doesn't mandate it for
  // this milestone, but it's expected on macOS and one event listener.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void handleOpenClick(handles, openBtn);
    }
  });
}

async function handleOpenClick(h: ViewerHandles, openBtn: HTMLButtonElement): Promise<void> {
  openBtn.disabled = true;
  try {
    const picked = await window.electronAPI.openPdfDialog();
    if (!picked.path) return; // user canceled — leave current state untouched
    await loadPdf(h, picked.path);
  } finally {
    openBtn.disabled = false;
  }
}

async function loadPdf(h: ViewerHandles, path: string): Promise<void> {
  h.title.textContent = `Loading ${basename(path)}…`;
  hideBanner(h.banner);
  // Flush any pending write for the previous doc before its sha256 is gone.
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
    await flushDraftsWrite();
  }
  // Reset per-doc state. selection cache and in-memory drafts belong to the
  // previous document.
  docState.path = path;
  docState.sha256 = '';
  docState.lastSelection = null;
  docState.comments = [];
  focusedCommentId = null;
  editingCommentId = null;
  clearInput();
  renderAllCards();
  updateAnchorMeta();

  // Kick off bytes + health in parallel. Both round-trip through main; running
  // them concurrently shaves ~engine-startup-time off the visible load latency.
  const [bytesResult, healthResult] = await Promise.all([
    window.electronAPI.readPdfBytes(path),
    window.electronAPI.pdfHealth(path),
  ]);

  // Render the health banner first so a render failure below still has the
  // diagnostic context visible. The banner is non-blocking either way.
  renderHealthBanner(h.banner, healthResult);

  if (!bytesResult.ok) {
    h.title.textContent = basename(path);
    showLoadError(h, bytesResult);
    setViewerControlsEnabled(h, false);
    return;
  }

  docState.sha256 = bytesResult.sha256;

  // Drafts load races bytes-render — both are independent of each other,
  // and rendering the cards before the canvas is ready is fine.
  void loadDraftsForCurrentDoc();

  try {
    showViewer(h);
    await h.viewer.loadBytes(bytesResult.bytes);
    h.title.textContent = basename(path);
    setViewerControlsEnabled(h, true);
  } catch (err) {
    h.title.textContent = basename(path);
    showLoadError(h, null, err);
    setViewerControlsEnabled(h, false);
  }
  // §3.3 — persist last-opened-doc and reflect the active row in the tree.
  // Safe to no-op when boot ordering hasn't wired them up yet.
  fileTree?.setActiveFile(path);
  scheduleAppStateSave();
}

async function loadDraftsForCurrentDoc(): Promise<void> {
  if (!docState.path || !docState.sha256) return;
  const path = docState.path;
  const sha256 = docState.sha256;
  const res = await window.electronAPI.readDrafts(path, sha256);
  // Bail if the user opened a different doc while we were waiting.
  if (docState.path !== path || docState.sha256 !== sha256) return;
  if (!res.ok) {
    flashAnchorMeta(`Drafts load failed (${res.reason}): ${res.error}`);
    return;
  }
  docState.comments = res.file?.comments ?? [];
  renderAllCards();
}

function showViewer(h: ViewerHandles): void {
  h.empty.hidden = true;
  h.mount.hidden = false;
}

function showLoadError(h: ViewerHandles, r: ReadPdfBytesResult | null, err?: unknown): void {
  h.empty.replaceChildren();
  const t = document.createElement('div');
  t.className = 'pdf-empty-title';
  t.textContent = 'Couldn’t open this file';
  const detail = document.createElement('div');
  detail.className = 'pdf-empty-hint';
  if (r && !r.ok) {
    detail.textContent = `${r.reason}: ${r.resolvedPath}${r.error ? ` — ${r.error}` : ''}`;
  } else if (err) {
    detail.textContent = `pdf load failed: ${err instanceof Error ? err.message : String(err)}`;
  } else {
    detail.textContent = 'no bytes returned';
  }
  h.empty.append(t, detail);
  h.empty.hidden = false;
  h.mount.hidden = true;
}

function setViewerControlsEnabled(h: ViewerHandles, enabled: boolean): void {
  h.fitPageBtn.disabled = !enabled;
  h.fitWidthBtn.disabled = !enabled;
  h.darkBtn.disabled = !enabled;
  // prev/next/pageLabel are managed by onPageInfo — when no doc is loaded
  // they retain their last-known state, which is fine because the empty
  // state replaces the viewer surface entirely.
}

// ─── §5.2 banner ──────────────────────────────────────────────────────────

function hideBanner(banner: HTMLElement): void {
  banner.hidden = true;
  banner.removeAttribute('data-severity');
  banner.replaceChildren();
}

function renderHealthBanner(banner: HTMLElement, r: PdfHealthResult): void {
  // Engine call itself failed — surface as an error so the user knows the
  // banner isn't silently absent because the PDF is clean.
  if (!r.ok) {
    const reason = r.engine.ok ? 'unknown' : r.engine.reason;
    fillBanner(banner, 'error',
      'Couldn’t check this PDF’s health.',
      `Engine call failed (${reason}). The viewer will still try to render.`);
    return;
  }

  const { report } = r;

  // 1. Document-level open failure
  if (report.error) {
    fillBanner(banner, 'error',
      'This PDF couldn’t be opened by the engine.',
      report.error);
    return;
  }

  // 2. Encrypted
  if (report.encrypted) {
    fillBanner(banner, 'error',
      'This PDF is encrypted.',
      'Text extraction and highlight capture aren’t available. Save an unencrypted copy and re-open.');
    return;
  }

  const total = report.total_pages ?? 0;
  const readable = report.readable_pages.length;
  const unreadable = report.unreadable_pages.length;

  // 3. All pages flagged as unreadable by the engine. Note: PDF.js's own text
  // layer can still extract glyphs from some pages the engine considers
  // "unreadable" (e.g. CID-only pages with missing ToUnicode maps), so we
  // frame this as "captured text will be unreliable", not "no text at all".
  if (total > 0 && readable === 0) {
    fillBanner(banner, 'error',
      'This PDF has corrupted text encoding.',
      'Highlights may capture empty, garbled, or ligature-corrupted text (e.g. “veri ed” for “verified”). The viewer still works — but for clean text capture, rebuild the PDF from source.');
    return;
  }

  // 4. Partial damage
  if (unreadable > 0) {
    fillBanner(banner, 'warn',
      `This PDF is partially damaged: text extraction is unreliable on ${formatPageList(report.unreadable_pages)}.`,
      `${formatPageList(report.readable_pages)} extract cleanly. Highlights on damaged pages may capture empty or garbled text.`);
    return;
  }

  // 5. Ligature loss (otherwise clean)
  if (report.ligature_loss_detected) {
    fillBanner(banner, 'warn',
      'Captured text on this PDF may be missing ligatures (e.g. “veri ed” for “verified”).',
      'Highlights will still capture text; expect occasional gaps in the extracted strings.');
    return;
  }

  // 6. Clean → banner stays hidden.
  hideBanner(banner);
}

function fillBanner(
  banner: HTMLElement,
  severity: 'warn' | 'error',
  primary: string,
  detail: string,
): void {
  banner.hidden = false;
  banner.setAttribute('data-severity', severity);
  const icon = severity === 'error' ? '⚠ ' : '⚠ ';
  const head = document.createElement('strong');
  head.textContent = `${icon}${primary}`;
  const sub = document.createElement('span');
  sub.className = 'pdf-banner-detail';
  sub.textContent = detail;
  banner.replaceChildren(head, sub);
}

/**
 * Render a 1-indexed page list as a compact human-readable string:
 *   [1,2,3,5,7,8,9] → "pages 1–3, 5, 7–9"
 * Empty → "no pages". Single → "page N".
 */
function formatPageList(pages: number[]): string {
  if (pages.length === 0) return 'no pages';
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
  const label = pages.length === 1 ? 'page' : 'pages';
  return `${label} ${ranges.join(', ')}`;
}

// ─── §4.2 tool palette + §4.3 bottom input ───────────────────────────────

function bootToolPaletteAndInput(): void {
  const palette = document.getElementById('toolPalette');
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  const clearBtn = document.getElementById('commentClear') as HTMLButtonElement | null;
  if (!palette || !input || !clearBtn) return;

  // Tool selection (click + ⌘1/⌘2/⌘3 accelerators per spec §16 keyboard table).
  palette.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tool]');
    if (!btn) return;
    const next = btn.dataset.tool as Tool | undefined;
    if (next) setActiveTool(next);
  });
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === '1') { e.preventDefault(); setActiveTool('comment'); }
    else if (e.key === '2') { e.preventDefault(); setActiveTool('redraft'); }
    else if (e.key === '3') { e.preventDefault(); setActiveTool('surface'); }
  });

  // §4.3 friction reductions: plain Enter submits, Shift+Enter is a soft
  // return. Esc clears the in-memory buffer (the buffer is the only thing
  // lost — no persisted state to invalidate).
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // rev-b8t: Esc cancels an in-progress edit (restoring the original
      // body to the card) before falling through to the standard "just
      // clear the buffer" behavior.
      if (editingCommentId) cancelEdit();
      else clearInput();
    }
  });
  clearBtn.addEventListener('click', () => { clearInput(); input.focus(); });

  updateAnchorMeta();
}

function setActiveTool(next: Tool): void {
  if (next === activeTool) return;
  const previous = activeTool;
  activeTool = next;
  // Reflect active state in the palette buttons.
  document.querySelectorAll<HTMLButtonElement>('#toolPalette .tool-btn').forEach((b) => {
    const on = b.dataset.tool === next;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  // Switching INTO Redraft with a live selection → populate the input with
  // highlighted_text as the editing starter (§4.3). Switching OUT of Redraft
  // leaves whatever is in the input alone — the user owns the buffer.
  if (next === 'redraft' && previous !== 'redraft' && docState.lastSelection) {
    const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
    if (input) {
      input.value = docState.lastSelection.highlighted_text;
      input.focus();
      input.select();
    }
  }
}

/** Selection callback wired into PdfViewer. Caches the payload so it's
 *  available at submit time and updates the anchor-status meta line. */
function handleSelection(payload: SelectionPayload): void {
  docState.lastSelection = payload;
  updateAnchorMeta();
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  if (!input) return;
  // §4.3: a fresh selection while Redraft is active populates the input as
  // the editing starter. Comment / Surface tools leave the buffer alone.
  if (activeTool === 'redraft') {
    input.value = payload.highlighted_text;
    input.focus();
    input.select();
    return;
  }
  // §4.3 for Comment/Surface: "input gets focus; user types comment; Enter
  // submits." Without this, keystrokes after a highlight land in the PDF
  // text layer and never reach the textarea, so Enter does nothing.
  input.focus();
}

function updateAnchorMeta(): void {
  const meta = document.getElementById('commentAnchor');
  if (!meta) return;
  // rev-b8t: in edit mode the meta line tells the user what they're doing
  // (and how to bail) instead of showing the live-selection breadcrumb.
  if (editingCommentId) {
    const c = docState.comments.find((x) => x.id === editingCommentId);
    if (c) {
      meta.textContent = `Editing ${labelFor(c.engagement_level)} · Enter to save · Esc to cancel`;
      meta.classList.add('has-selection');
      return;
    }
    editingCommentId = null;
  }
  const sel = docState.lastSelection;
  if (!sel) {
    meta.textContent = docState.path
      ? 'No selection — highlight text in the PDF to anchor a comment.'
      : 'No PDF loaded.';
    meta.classList.remove('has-selection');
    return;
  }
  const r = sel.region;
  const snippet = truncate(sel.highlighted_text, 60);
  meta.textContent = `p.${sel.page} · ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)} · “${snippet}”`;
  meta.classList.add('has-selection');
}

function clearInput(): void {
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  if (input) input.value = '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function handleSubmit(): Promise<void> {
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  if (!input) return;
  const buf = input.value.trim();
  if (!buf) return; // nothing to submit — silent no-op

  // rev-b8t: in edit mode, update the body field of the existing comment
  // and don't touch its anchor / engagement_level / id. Bail without
  // surfacing the no-anchor flash even if the user has cleared selection
  // since they started editing — the anchor was captured at create time.
  if (editingCommentId) {
    const c = docState.comments.find((x) => x.id === editingCommentId);
    if (c) {
      if (c.engagement_level === 'redraft') c.redraft = buf;
      else c.comment = buf;
      renderAllCards();
      scheduleDraftsWrite();
    }
    editingCommentId = null;
    clearInput();
    updateAnchorMeta();
    input.focus();
    return;
  }

  if (!docState.lastSelection) {
    // milestone #3 requires an anchor; standalone point-comments (§5.1) land
    // in a later milestone alongside the click-to-anchor affordance.
    flashAnchorMeta('Select text in the PDF first to anchor this comment.');
    return;
  }
  const payload = buildCommentPayload(buf, docState.lastSelection);
  docState.comments.unshift(payload);
  renderAllCards();
  scheduleDraftsWrite();
  // §4.3: keep the active tool, keep the cached selection (the user may want
  // to stack Comment + Redraft on the same highlight). Just clear the buffer.
  clearInput();
  input.focus();
}

function buildCommentPayload(buf: string, sel: SelectionPayload): CommentPayload {
  // Tool ↔ engagement_level / field mapping (§11.1):
  //   Comment / Surface → buffer is the comment text; redraft is null.
  //   Redraft           → buffer is the edited replacement text; comment is "".
  const isRedraft = activeTool === 'redraft';
  return {
    id: crypto.randomUUID(),
    doc_id: docState.path,
    doc_version: docState.sha256,
    anchor: { page: sel.page, region: sel.region },
    highlighted_text: sel.highlighted_text,
    comment: isRedraft ? '' : buf,
    redraft: isRedraft ? buf : null,
    redraft_suggestion: null,
    engagement_level: activeTool,
    author: 'AJB',
    kind: 'comment',
    status: 'open',
    created_at: new Date().toISOString(),
  };
}

/** Rebuild the comment stream from `docState.comments`. Cheap enough for
 *  the v1 scale (10s-100s of cards per doc) — if this ever shows up in a
 *  flame graph, switch to incremental DOM updates keyed by `c.id`.
 *
 *  rev-6vc: cards are grouped by engagement level (spec §9.1), in L1→L3
 *  order with chronological (newest-first) ordering preserved within each
 *  bucket. Empty buckets are omitted so an all-Comment session doesn't
 *  show two stub headers below.
 */
function renderAllCards(): void {
  const stream = document.getElementById('commentStream');
  if (!stream) return;
  if (docState.comments.length === 0) {
    stream.replaceChildren(buildEmptyPlaceholder());
    return;
  }
  const sections: HTMLElement[] = [];
  for (const level of LEVEL_ORDER) {
    const bucket = docState.comments.filter((c) => c.engagement_level === level);
    if (bucket.length === 0) continue;
    sections.push(buildLevelSection(level, bucket));
  }
  stream.replaceChildren(...sections);
  // rev-680: a card we'd previously focused may no longer exist after a
  // doc switch or delete; restore focus only if it survived the rebuild.
  if (focusedCommentId) {
    const restore = stream.querySelector<HTMLElement>(
      `.comment-card[data-id="${CSS.escape(focusedCommentId)}"]`
    );
    if (restore) restore.focus({ preventScroll: true });
    else focusedCommentId = null;
  }
}

const LEVEL_ORDER: readonly EngagementLevel[] = ['comment', 'redraft', 'surface'];

function buildLevelSection(level: EngagementLevel, cards: CommentPayload[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'comment-section';
  section.dataset.level = level;
  const head = document.createElement('div');
  head.className = 'comment-section-head';
  const label = document.createElement('span');
  label.className = 'comment-section-label';
  label.textContent = labelFor(level);
  const count = document.createElement('span');
  count.className = 'comment-section-count';
  count.textContent = String(cards.length);
  head.append(label, count);
  section.append(head);
  for (const c of cards) section.append(buildCommentCard(c));
  return section;
}

/** rev-680: stream-level keyboard handler. j/k + ↓/↑ move between cards;
 *  Enter on a focused card reveals its anchor. Spec §15 gates these on
 *  "right-drawer comment stream focused" — we get that for free because
 *  the listener is scoped to #commentStream and only fires when a card
 *  (or the stream itself) is the keydown target. While the user types in
 *  the bottom textarea, keystrokes land there and never reach this
 *  listener, so the spec's focus discipline is enforced structurally. */
function bindCommentStreamKeyboard(): void {
  const stream = document.getElementById('commentStream');
  if (!stream) return;
  stream.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't shadow Cmd+J etc.
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveCardFocus(stream, +1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCardFocus(stream, -1);
    } else if (e.key === 'Enter') {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement)) return;
      if (!focused.classList.contains('comment-card')) return;
      const id = focused.dataset.id;
      const c = id ? docState.comments.find((x) => x.id === id) : null;
      if (!c || !viewerRef) return;
      e.preventDefault();
      void viewerRef.revealAnchor(c.anchor.page, c.anchor.region);
    }
  });
}

function moveCardFocus(stream: HTMLElement, dir: 1 | -1): void {
  const cards = Array.from(stream.querySelectorAll<HTMLElement>('.comment-card'));
  if (cards.length === 0) return;
  const current = document.activeElement instanceof HTMLElement
    ? cards.indexOf(document.activeElement)
    : -1;
  // First j/k with nothing focused: enter the list from the natural end —
  // j → first card, k → last card. After that, clamp at the edges (no
  // wrap; wrap is surprising in lists this small).
  const next = current === -1
    ? (dir === 1 ? 0 : cards.length - 1)
    : Math.max(0, Math.min(cards.length - 1, current + dir));
  cards[next].focus();
}

function buildEmptyPlaceholder(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'placeholder';
  el.id = 'commentStreamEmpty';
  el.textContent = 'No comments yet…';
  return el;
}

function buildCommentCard(c: CommentPayload): HTMLElement {
  const card = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.level = c.engagement_level;
  card.dataset.id = c.id;
  // rev-680: cards are individually focusable so Tab walks them and the
  // spec's `j`/`k`/`Enter` bindings have a clear "currently focused card"
  // to operate on. role=button so AT users hear "button" semantics — click
  // and Enter both reveal the anchor.
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${labelFor(c.engagement_level)} on page ${c.anchor.page}`);
  card.addEventListener('focus', () => { focusedCommentId = c.id; });
  // Click to reveal: jumps to the anchor's page and repaints the persistent
  // highlight at the captured PDF-space region. Stable across zoom because
  // the region was stored in PDF points.
  card.addEventListener('click', () => {
    if (!viewerRef) return;
    void viewerRef.revealAnchor(c.anchor.page, c.anchor.region);
  });

  const head = document.createElement('div');
  head.className = 'comment-card-head';
  const level = document.createElement('span');
  level.className = 'comment-card-level';
  level.textContent = labelFor(c.engagement_level);
  const anchor = document.createElement('span');
  anchor.className = 'comment-card-anchor';
  const r = c.anchor.region;
  anchor.textContent = `· p.${c.anchor.page} · ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
  head.append(level, anchor, buildCardActions(c));

  const quote = document.createElement('div');
  quote.className = 'comment-card-quote';
  quote.textContent = `“${c.highlighted_text}”`;

  card.append(head, quote);

  if (c.comment) {
    const body = document.createElement('div');
    body.className = 'comment-card-body';
    body.textContent = c.comment;
    card.append(body);
  }
  if (c.redraft) {
    const redraft = document.createElement('div');
    redraft.className = 'comment-card-redraft';
    redraft.textContent = c.redraft;
    card.append(redraft);
  }

  return card;
}

/** rev-b8t: per-card edit + delete controls. Both stop propagation so
 *  they don't trigger the card-level click (revealAnchor) underneath. */
function buildCardActions(c: CommentPayload): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'comment-card-actions';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'comment-card-action';
  edit.dataset.action = 'edit';
  edit.title = 'Edit this comment';
  edit.setAttribute('aria-label', 'Edit comment');
  edit.textContent = '✎';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    beginEditComment(c.id);
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'comment-card-action';
  del.dataset.action = 'delete';
  del.title = 'Delete this comment';
  del.setAttribute('aria-label', 'Delete comment');
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    void deleteComment(c.id);
  });

  actions.append(edit, del);
  return actions;
}

function beginEditComment(id: string): void {
  const c = docState.comments.find((x) => x.id === id);
  if (!c) return;
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  if (!input) return;
  editingCommentId = id;
  // Body lives in `redraft` for Redraft cards, `comment` otherwise. Load
  // whichever field the original engagement_level wrote into so the user
  // edits exactly what's in the card.
  input.value = c.engagement_level === 'redraft' ? (c.redraft ?? '') : c.comment;
  // Match the active tool to the comment's level so a follow-on Submit
  // routes the buffer to the same field (and Cmd+1/2/3 reads consistent).
  setActiveTool(c.engagement_level);
  updateAnchorMeta();
  input.focus();
  input.select();
}

function cancelEdit(): void {
  if (!editingCommentId) return;
  editingCommentId = null;
  clearInput();
  updateAnchorMeta();
}

async function deleteComment(id: string): Promise<void> {
  const c = docState.comments.find((x) => x.id === id);
  if (!c) return;
  // No undo yet, so confirm to prevent accidental loss of work. Inline
  // body preview helps the user recognize which card they're about to nuke.
  const preview = (c.engagement_level === 'redraft' ? (c.redraft ?? '') : c.comment).trim();
  const snippet = preview ? `\n\n"${truncate(preview, 80)}"` : '';
  const ok = window.confirm(`Delete this ${labelFor(c.engagement_level)}?${snippet}`);
  if (!ok) return;
  docState.comments = docState.comments.filter((x) => x.id !== id);
  if (focusedCommentId === id) focusedCommentId = null;
  if (editingCommentId === id) cancelEdit();
  renderAllCards();
  scheduleDraftsWrite();
}

function labelFor(level: Tool): string {
  switch (level) {
    case 'comment': return 'L1 Comment';
    case 'redraft': return 'L2 Redraft';
    case 'surface': return 'L3 Surface';
  }
}

function flashAnchorMeta(msg: string): void {
  const meta = document.getElementById('commentAnchor');
  if (!meta) return;
  const previous = meta.textContent;
  meta.textContent = msg;
  meta.classList.remove('has-selection');
  setTimeout(() => {
    if (meta.textContent === msg) {
      meta.textContent = previous;
      updateAnchorMeta();
    }
  }, 2000);
}

// ─── Diagnostic formatters (unchanged from milestone #1) ──────────────────

function formatEngineResult(r: EngineResult): string {
  if (r.ok) {
    return `engine ✓  ${r.stdout.trim()}  (${shortenPath(r.resolvedPath)})`;
  }
  switch (r.reason) {
    case 'not_found': {
      const stepsTried = r.triedPaths.map((a) => `${a.step}:${shortenPath(a.path)}`).join(' → ');
      return `engine ✗  not found.  Tried: ${stepsTried}`;
    }
    case 'spawn_failed':
      return `engine ✗  spawn failed: ${r.error}  (${shortenPath(r.resolvedPath)})`;
    case 'failed':
      return `engine ✗  exit ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}  (${shortenPath(r.resolvedPath)})`;
    case 'timeout':
      return `engine ✗  timed out after ${r.timeoutMs}ms  (${shortenPath(r.resolvedPath)})`;
  }
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

void init();
