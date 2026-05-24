import type {
  AppStateFile,
  CommentPayload,
  CommentStatus,
  DraftsFile,
  EngagementLevel,
  EngineResult,
  PdfHealthResult,
  ReadPdfBytesResult,
  ResultEntry,
  ResultsEvent,
  ResultsFile,
} from '@shared/types';
import { REVIEWER_LOCAL_ID } from '@shared/types';
import { parseSourceName } from '@shared/bundle';
import { PdfViewer, type SelectionPayload } from './pdf-viewer';
import { MarkdownViewer, type MdSelection } from './md-viewer';
import { createMdAnchor, fuzzyMatchAnchor } from '@shared/md/anchors';
import { FileTree } from './tree';
import { QuickOpenPalette } from './palette';
import {
  mount as mountClaudePane,
  ensureSpawned as ensureClaudePaneSpawned,
  notifyDocSwitch as notifyClaudeDocSwitch,
} from './claude-pane';
import { mountAgentPane } from './agent-pane/main';

/**
 * Project 4 / M-int-1 feature flag: when localStorage.pdf-latex-new-agent-pane
 * is "1", the lower-right pane mounts the React agent-viewer port instead of
 * the xterm-based Claude pane. Flip via DevTools console:
 *   localStorage.setItem('pdf-latex-new-agent-pane', '1'); location.reload()
 * To revert:
 *   localStorage.removeItem('pdf-latex-new-agent-pane'); location.reload()
 */
function useNewAgentPane(): boolean {
  try {
    return localStorage.getItem('pdf-latex-new-agent-pane') === '1';
  } catch {
    return false;
  }
}
import { mountToolbar } from './toolbar';
import { bootSplitters, applyLayoutWidths, type LayoutWidths } from './splitter';
import {
  mount as mountSubmit,
  executeSubmit,
  reset as resetSubmit,
  markAcknowledged as markSubmitAcknowledged,
  markRoundComplete as markSubmitRoundComplete,
  isInFlight as submitIsInFlight,
  canFire as submitCanFire,
  type SubmitContext,
} from './submit';

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
  /** rev-1md.5: per-submit_id tracking of the latest results file we've seen
   *  for this doc. Drives the round-status banner (showing the freshest
   *  state) and lets us recognize "we already seeded a v1.1 draft for this
   *  results_id" so re-opening the doc doesn't double-seed. */
  rounds: Map<string, ResultsRoundState>;
  /** rev-1md.4 §10.5.1 — originating rig recorded at launch via --from.
   *  Null for standalone. Loaded from AppState on doc switch (per-doc
   *  keying). When set, Submit goes straight to this rig — no picker. */
  originRig: string | null;
}

interface ResultsRoundState {
  submit_id: string;
  results_id: string;
  filePath: string;
  results: ResultsFile;
  /** True once we've written the seeded v1.1 draft for this completed round.
   *  Prevents double-seeding when the same results file re-emits (e.g., the
   *  user re-opens the doc later). */
  seeded: boolean;
}

const docState: DocState = {
  path: '', sha256: '', lastSelection: null, comments: [],
  rounds: new Map(), originRig: null,
};

// ─── §10.1 / §10.5 — origin + recent-rigs persistence ─────────────────────
//
// AppState (rev-1md.4 additions):
//   origin_rig_per_doc[path]       — pinned at --from launch; survives restart
//   recent_rigs                    — picker MRU list, capped at 8
//   last_destination_per_doc[path] — picker "remember per doc" memory
//
// Maintained in module-scope mirrors so we don't re-read AppState on every
// Submit. flushAppStateSave() (the existing debounced writer) picks the
// values up via the snapshot helper below.
const MAX_RECENT_RIGS = 8;
const originRigPerDoc = new Map<string, string>();
const recentRigsList: string[] = [];
const lastDestinationPerDoc = new Map<string, string>();

function rememberOriginRig(path: string, from: string | null): void {
  if (!from) { originRigPerDoc.delete(path); return; }
  originRigPerDoc.set(path, from);
}

function rememberDestination(path: string, destination: string): void {
  lastDestinationPerDoc.set(path, destination);
  // Reviewer-local is not a "recent rig" — it's the always-present default.
  if (destination !== REVIEWER_LOCAL_ID) {
    const existing = recentRigsList.indexOf(destination);
    if (existing !== -1) recentRigsList.splice(existing, 1);
    recentRigsList.unshift(destination);
    if (recentRigsList.length > MAX_RECENT_RIGS) recentRigsList.length = MAX_RECENT_RIGS;
  }
  scheduleAppStateSave();
}
let activeTool: Tool = 'comment';
let viewerRef: PdfViewer | null = null;
let mdViewerRef: MarkdownViewer | null = null;
let lastMdSelection: MdSelection | null = null;

// ─── M-md-3: .md source save debounce (500ms) ────────────────────────────
let mdSaveTimer: number | null = null;
const MD_SAVE_DEBOUNCE_MS = 500;
let mdSourceModified = false;
let mdFileChangeUnsub: (() => void) | null = null;

function scheduleMdSave(): void {
  if (!docState.path || classifyPath(docState.path) !== 'md') return;
  mdSourceModified = true;
  fileTree?.setModifiedFile(docState.path, true);
  if (mdSaveTimer !== null) window.clearTimeout(mdSaveTimer);
  mdSaveTimer = window.setTimeout(() => {
    mdSaveTimer = null;
    void flushMdSave();
  }, MD_SAVE_DEBOUNCE_MS);
}

async function flushMdSave(): Promise<void> {
  if (!docState.path || !mdViewerRef) return;
  const content = mdViewerRef.getContent();
  if (!content && content !== '') return;
  window.electronAPI.suppressFileWatch();
  const res = await window.electronAPI.writeFileText(docState.path, content);
  if (!res.ok) {
    flashAnchorMeta(`Save failed (${res.reason}): ${res.error}`);
    return;
  }
  mdSourceModified = false;
  fileTree?.setModifiedFile(docState.path, false);
  const newHash = await rehashCurrentDoc();
  if (newHash) docState.sha256 = newHash;
}

async function rehashCurrentDoc(): Promise<string | null> {
  if (!docState.path) return null;
  const res = await window.electronAPI.readPdfBytes(docState.path);
  return res.ok ? res.sha256 : null;
}

// ─── Drafts write debounce (§10.3 — 250ms) ─────────────────────────────────
let writeTimer: number | null = null;
const WRITE_DEBOUNCE_MS = 250;
const draftsCache = new Map<string, DraftsFile>();

function scheduleDraftsWrite(): void {
  if (!docState.path || !docState.sha256) return;
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  setSavedIndicator({ kind: 'saving' });
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    void flushDraftsWrite();
  }, WRITE_DEBOUNCE_MS);
}

async function flushDraftsWrite(): Promise<void> {
  if (!docState.path || !docState.sha256) return;
  const isMd = classifyPath(docState.path) === 'md';
  const file: DraftsFile = {
    schema_version: 1,
    doc_version: docState.sha256,
    comments: docState.comments,
    anchor_kind: isMd ? 'md-fuzzy-snippet' : 'pdf-glyph-rect',
  };
  draftsCache.set(docState.path, file);
  const res = await window.electronAPI.writeDrafts(docState.path, docState.sha256, file);
  if (!res.ok) {
    // Surface persistence failures so the user knows their work isn't
    // saved. Non-blocking — the in-memory state is still authoritative
    // until the next successful write.
    flashAnchorMeta(`Drafts save failed (${res.reason}): ${res.error}`);
    setSavedIndicator({ kind: 'error', detail: `${res.reason}: ${res.error}` });
    return;
  }
  // After a successful drafts flush, the indicator either confirms "Saved"
  // (no bundle yet this session) or keeps showing the last-bundle stamp
  // (Cmd+S sets that; the bundle stamp is the more useful signal — drafts
  // are an implementation detail of "your edits won't disappear", but the
  // bundle is the deliverable). Bundle state wins over saved.
  if (savedIndicatorState.kind !== 'bundle') {
    setSavedIndicator({ kind: 'saved' });
  }
}

// ─── §10.4 title-bar Saved / Last bundle indicator ─────────────────────────
//
// The indicator persists per the spec's "mirrors Google Docs / Notion"
// guidance. We track a small union so each rendering pass can pull the
// freshest signal: bundle writes win over saved-drafts updates (a bundle
// stamp is a more meaningful "you have an artifact" cue).

type SavedIndicatorState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'bundle'; at: Date; pdfPath: string }
  | { kind: 'error'; detail: string };

let savedIndicatorState: SavedIndicatorState = { kind: 'idle' };

function setSavedIndicator(next: SavedIndicatorState): void {
  savedIndicatorState = next;
  renderSavedIndicator();
}

function renderSavedIndicator(): void {
  const el = document.getElementById('pdfSaved');
  if (!el) return;
  const s = savedIndicatorState;
  el.dataset.state = s.kind;
  switch (s.kind) {
    case 'idle':
      el.textContent = '';
      el.removeAttribute('title');
      return;
    case 'saving':
      el.textContent = 'Saving…';
      el.removeAttribute('title');
      return;
    case 'saved':
      el.textContent = 'Saved';
      el.removeAttribute('title');
      return;
    case 'bundle': {
      const hh = String(s.at.getHours()).padStart(2, '0');
      const mm = String(s.at.getMinutes()).padStart(2, '0');
      el.textContent = `Bundle saved ${hh}:${mm}`;
      el.setAttribute('title', s.pdfPath);
      return;
    }
    case 'error':
      el.textContent = 'Save failed';
      el.setAttribute('title', s.detail);
      return;
  }
}

async function init() {
  wireDraftsQuitFlush();
  wireResultsEvents();
  await mountStartupDiagnostics();
  bootProjectOpenFlow();
  bootClaudePane();
  bootSubmitFlow();
  await bootLeftDrawerAndPalette();
  // Verification scripts (and humans poking at devtools) can wait on this
  // to know all async boot work — including state restore — has settled.
  (window as unknown as { __APP_READY?: boolean }).__APP_READY = true;
}

// §10.1 — wire the Submit pill + banner + destination picker. Lazy mount:
// the picker is not opened until first Submit, so we just hand over refs.
function bootSubmitFlow(): void {
  const pill = document.getElementById('pdfSubmit');
  const banner = document.getElementById('submitBanner');
  const pickerRoot = document.getElementById('destinationPicker');
  const pickerList = document.getElementById('destPickerList');
  const pickerCustom = document.getElementById('destPickerCustom') as HTMLInputElement | null;
  const pickerSubmitBtn = document.getElementById('destPickerSubmit') as HTMLButtonElement | null;
  const pickerCloseBtn = document.getElementById('destPickerClose') as HTMLButtonElement | null;
  const pickerHint = document.getElementById('destPickerHint');
  if (!pill || !banner || !pickerRoot || !pickerList || !pickerCustom ||
      !pickerSubmitBtn || !pickerCloseBtn || !pickerHint) return;
  mountSubmit({
    pill,
    banner,
    picker: {
      root: pickerRoot,
      list: pickerList,
      custom: pickerCustom,
      submitBtn: pickerSubmitBtn,
      closeBtn: pickerCloseBtn,
      hint: pickerHint,
    },
    onDestinationChosen: (rig) => {
      if (docState.path) rememberDestination(docState.path, rig);
    },
    onPendingRound: (_p) => {
      // No additional persistence in v1 — the on-disk submit-<ts>.json is
      // the source of truth. If the app restarts mid-round, the results
      // watcher's initial-scan reads the resulting results file (if the
      // rig finished one) or shows nothing (if the rig hasn't started
      // yet). The "Resume round in progress" banner in §10.1 step 6 is
      // driven entirely from the disk artifacts.
    },
  });
  // Retry handler — Submit module dispatches this when the user clicks
  // Retry in the failure banner. Re-derives ctx from current docState.
  window.addEventListener('submit:retry-requested', () => {
    void handleSubmitBundle();
  });
  // Mirror Submit's per-comment status flips back onto the live draft.
  window.addEventListener('submit:comments-promoted', (evt) => {
    const detail = (evt as CustomEvent).detail as
      | { updates: { commentId: string; submittedAt: string }[] }
      | undefined;
    if (!detail) return;
    const byId = new Map(docState.comments.map((c) => [c.id, c]));
    let changed = false;
    for (const u of detail.updates) {
      const c = byId.get(u.commentId);
      if (!c) continue;
      if ((c.status ?? 'open') === 'open') {
        c.status = 'submitted';
        c.submitted_at = u.submittedAt;
        changed = true;
      }
    }
    if (changed) {
      renderAllCards();
      scheduleDraftsWrite();
    }
  });
}

/** §9.2 — wire the Claude pane DOM refs and IPC listeners. The terminal
 *  itself isn't constructed until the first PDF open (lazy per §9.2.2).
 *
 *  Project 4 / M-int-1: when the new-agent-pane flag is on, the lower-right
 *  body mounts the React agent-viewer port instead. Toolbar still boots
 *  alongside (the toolbar's Create Context / Sling / Fresh Start buttons
 *  will get rewired to the new pane in M-int-4 / M-int-5). */
function bootClaudePane(): void {
  const empty = document.getElementById('claudeEmpty');
  const term = document.getElementById('claudeTerm');
  const error = document.getElementById('claudeError');
  const identity = document.getElementById('claudeIdentity');
  const body = document.getElementById('claudeBody');
  const tabs = document.getElementById('claudeTabs');
  const progressStrip = document.getElementById('progressStrip');
  const tasksToggle = document.getElementById('tasksPanelToggle') as HTMLButtonElement | null;
  const tasksCount = document.getElementById('tasksPanelCount');
  const tasksPanel = document.getElementById('tasksPanel');
  const tasksList = document.getElementById('tasksPanelList');
  const tasksEmpty = document.getElementById('tasksPanelEmpty');
  const tasksClose = document.getElementById('tasksPanelClose') as HTMLButtonElement | null;
  if (!empty || !term || !error || !identity || !body || !tabs ||
      !progressStrip || !tasksToggle || !tasksCount || !tasksPanel ||
      !tasksList || !tasksEmpty || !tasksClose) return;

  if (useNewAgentPane()) {
    // Hide the legacy xterm DOM scaffold and mount the React island in
    // its place. The agent-viewer renderer uses its own internal layout.
    empty.style.display = 'none';
    term.style.display = 'none';
    error.style.display = 'none';
    identity.style.display = 'none';
    tabs.style.display = 'none';
    body.classList.add('agent-pane-react-host');
    mountAgentPane(body);
    // Project 4 / M-int-4b Phase 1: toolbar comes back so Fresh Start is
    // reachable. Create Context / Sling stay disabled until M-int-4c
    // wires worker spawn to agent:spawnSession + γ-panel routing.
    const pendingMsg =
      'Worker support pending — coming in M-int-4c. Use legacy pane for now (DevTools: localStorage.removeItem(\'pdf-latex-new-agent-pane\'); location.reload()).';
    const createBtn = document.getElementById('toolbarCreateContext') as HTMLButtonElement | null;
    const slingBtn = document.getElementById('toolbarSling') as HTMLButtonElement | null;
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.title = pendingMsg;
    }
    if (slingBtn) {
      slingBtn.disabled = true;
      slingBtn.title = pendingMsg;
    }
    bootToolbar();
    return;
  }

  mountClaudePane({
    empty, term, error, identity, body, tabs, progressStrip,
    tasksToggle, tasksCount, tasksPanel, tasksList, tasksEmpty, tasksClose,
    // App theme is dark in v1 (§13.6 toggle is a spike-only affordance).
    themeMode: 'dark',
  });
  // §9.2.2 — Restart button on a crashed pty fires this event. We re-spawn
  // against the currently-open PDF's source dir.
  window.addEventListener('claude-pane:restart-requested', () => {
    if (!docState.path) return;
    void ensureClaudePaneSpawned({ docSourceDir: dirnameOf(docState.path) });
  });

  bootToolbar();
}

/** §9.2.6 right-drawer toolbar (rev-1md.3). Wires the three buttons + their
 *  modals + the context provider that exposes current doc state to the
 *  toolbar at click-time. */
function bootToolbar(): void {
  const createBtn = document.getElementById('toolbarCreateContext') as HTMLButtonElement | null;
  const slingBtn = document.getElementById('toolbarSling') as HTMLButtonElement | null;
  const freshBtn = document.getElementById('toolbarFreshStart') as HTMLButtonElement | null;
  const toolbar = document.getElementById('claudeToolbar');
  const ctxModal = document.getElementById('ctxModal');
  const ctxBundle = document.getElementById('ctxBundle');
  const ctxPrompt = document.getElementById('ctxPrompt') as HTMLTextAreaElement | null;
  const ctxIterations = document.getElementById('ctxIterations') as HTMLInputElement | null;
  const ctxSubmit = document.getElementById('ctxSubmit') as HTMLButtonElement | null;
  const slingModal = document.getElementById('slingModal');
  const slingBundle = document.getElementById('slingBundle');
  const slingPrompt = document.getElementById('slingPrompt') as HTMLTextAreaElement | null;
  const slingDestination = document.getElementById('slingDestination') as HTMLInputElement | null;
  const slingHint = document.getElementById('slingHint');
  const slingSubmit = document.getElementById('slingSubmit') as HTMLButtonElement | null;
  const freshModal = document.getElementById('freshModal');
  const freshHandoff = document.getElementById('freshHandoff') as HTMLTextAreaElement | null;
  const freshSubmit = document.getElementById('freshSubmit') as HTMLButtonElement | null;
  if (!toolbar || !createBtn || !slingBtn || !freshBtn ||
      !ctxModal || !ctxBundle || !ctxPrompt || !ctxIterations || !ctxSubmit ||
      !slingModal || !slingBundle || !slingPrompt || !slingDestination || !slingHint || !slingSubmit ||
      !freshModal || !freshHandoff || !freshSubmit) return;
  mountToolbar({
    refs: {
      toolbar, createBtn, slingBtn, freshBtn,
      ctxModal, ctxBundle, ctxPrompt, ctxIterations, ctxSubmit,
      slingModal, slingBundle, slingPrompt, slingDestination, slingHint, slingSubmit,
      freshModal, freshHandoff, freshSubmit,
    },
    ctx: {
      docPath: () => docState.path,
      docSourceDir: () => docState.path ? dirnameOf(docState.path) : '',
      currentPage: () => viewerRef?.currentPage ?? null,
      pageCount: () => viewerRef?.totalPages ?? null,
      selection: () => {
        const sel = docState.lastSelection;
        if (!sel) return null;
        return {
          page: sel.page,
          region: sel.region,
          highlightedText: sel.highlighted_text,
        };
      },
      comments: () => docState.comments,
    },
  });
}

/** Cross-platform dirname — see basename(). We avoid pulling in the node
 *  path polyfill just for this. */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '/';
}

function classifyPath(p: string): 'pdf' | 'md' | 'other' {
  const lower = p.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  return 'other';
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

/** In-memory mirror of AppStateFile.left_drawer_collapsed. Toggled by the
 *  chevron button + Cmd+\; persisted via the existing app-state debounce. */
let leftDrawerCollapsed = false;

/** Mirror of AppStateFile.layout_widths. Updated by the splitter on every
 *  drag commit; flushed via the existing scheduleAppStateSave debounce. */
let layoutWidths: LayoutWidths = {};

function setLeftDrawerCollapsed(next: boolean): void {
  leftDrawerCollapsed = next;
  const layout = document.querySelector<HTMLElement>('.layout');
  if (layout) layout.classList.toggle('left-collapsed', next);
  const btn = document.getElementById('treeToggleCollapse');
  if (btn) {
    btn.textContent = next ? '▶' : '◀';
    btn.setAttribute('aria-pressed', String(next));
    btn.setAttribute('title', next ? 'Expand file tree (⌘\\)' : 'Collapse file tree (⌘\\)');
  }
}

async function bootLeftDrawerAndPalette(): Promise<void> {
  const body = document.getElementById('treeBody');
  const title = document.getElementById('treeTitle');
  const empty = document.getElementById('treeEmpty');
  const openBtn = document.getElementById('treeOpenFolder') as HTMLButtonElement | null;
  const hiddenBtn = document.getElementById('treeToggleHidden') as HTMLButtonElement | null;
  const collapseBtn = document.getElementById('treeToggleCollapse') as HTMLButtonElement | null;
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
  // a buffered cold-launch request flushes. §10.5.1 — record the `from`
  // rig-id (if any) before loadPdf so the picker logic sees an origin on
  // first Submit.
  window.electronAPI.onOpenExternalFile((event) => {
    if (event.from) {
      rememberOriginRig(event.path, event.from);
      scheduleAppStateSave();
    }
    void openFileFromTreeOrPalette(event.path);
  });

  // §3.5 — Cmd+P opens the palette. Spec §15's focus discipline doesn't
  // gate this; a global accelerator is the expected affordance.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      palette?.open();
    } else if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      setLeftDrawerCollapsed(!leftDrawerCollapsed);
      scheduleAppStateSave();
    }
  });

  // Left-drawer collapse toggle: click the chevron OR ⌘\ (§15-style accelerator).
  // Persists via AppStateFile.left_drawer_collapsed; restored in restoreFromAppState.
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      setLeftDrawerCollapsed(!leftDrawerCollapsed);
      scheduleAppStateSave();
    });
  }

  // In-tree search: 🔎 toggle reveals an inline filter input.
  const searchToggle = document.getElementById('treeSearchToggle') as HTMLButtonElement | null;
  const searchBar = document.getElementById('treeSearchBar') as HTMLElement | null;
  const searchInput = document.getElementById('treeSearchInput') as HTMLInputElement | null;
  const searchClear = document.getElementById('treeSearchClear') as HTMLButtonElement | null;
  if (searchToggle && searchBar && searchInput && searchClear) {
    const openSearch = () => {
      searchBar.hidden = false;
      searchToggle.setAttribute('aria-pressed', 'true');
      searchInput.focus();
      searchInput.select();
    };
    const closeSearch = () => {
      searchBar.hidden = true;
      searchToggle.setAttribute('aria-pressed', 'false');
      searchInput.value = '';
      fileTree?.setFilter('');
    };
    searchToggle.addEventListener('click', () => {
      if (searchBar.hidden) openSearch(); else closeSearch();
    });
    searchInput.addEventListener('input', () => {
      fileTree?.setFilter(searchInput.value);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    });
    searchClear.addEventListener('click', () => { closeSearch(); searchToggle.focus(); });
    // ⌘F as global accelerator (when nothing is focused inside the document
    // pane, otherwise it can stay native browser-find inside contenteditables).
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' &&
          !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        if (searchBar.hidden) openSearch(); else searchInput.focus();
      }
    });
  }

  // Refresh button: clear dir cache and re-read from disk.
  const refreshBtn = document.getElementById('treeRefresh') as HTMLButtonElement | null;
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (!fileTree) return;
      void fileTree.refresh().then(() => {
        const root = fileTree!.snapshot().root;
        if (root) void refreshPdfIndex(root);
      });
    });
  }

  // Fit-width: measure the tree's natural width and bump --col-left to match.
  const fitWidthBtn = document.getElementById('treeFitWidth') as HTMLButtonElement | null;
  if (fitWidthBtn) {
    fitWidthBtn.addEventListener('click', () => {
      if (!fileTree) return;
      const px = fileTree.measureFitWidth();
      const layoutEl = document.querySelector<HTMLElement>('.layout');
      if (!layoutEl) return;
      layoutEl.style.setProperty('--col-left', `${px}px`);
      layoutWidths = { ...layoutWidths, col_left: px };
      scheduleAppStateSave();
    });
  }

  // Splitter gutters between the three columns + the right-drawer row split.
  // Widths persist via AppStateFile.layout_widths; defaults apply on first run.
  const layoutEl = document.querySelector<HTMLElement>('.layout');
  const rightDrawerEl = document.querySelector<HTMLElement>('.right-drawer');
  if (layoutEl && rightDrawerEl) {
    bootSplitters({
      layout: layoutEl,
      rightDrawer: rightDrawerEl,
      onChange: (delta) => {
        layoutWidths = { ...layoutWidths, ...delta };
        scheduleAppStateSave();
      },
    });
  }

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

/** One canonical "open this file" entry point shared by the tree, the palette,
 *  and external handoff. Dispatches by file kind to the right viewer. */
async function openFileFromTreeOrPalette(path: string): Promise<void> {
  if (!viewerHandlesRef) return;
  const kind = classifyPath(path);
  if (kind === 'md') {
    await loadMarkdown(viewerHandlesRef, path);
  } else {
    await loadPdf(viewerHandlesRef, path);
  }
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
    left_drawer_collapsed: leftDrawerCollapsed,
    layout_widths: layoutWidths,
    origin_rig_per_doc: Object.fromEntries(originRigPerDoc.entries()),
    recent_rigs: [...recentRigsList],
    last_destination_per_doc: Object.fromEntries(lastDestinationPerDoc.entries()),
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
  // §10.5 — restore origin + recent-rigs from prior session. The picker
  // reads from these maps directly via the SubmitContext.
  if (state.origin_rig_per_doc) {
    for (const [path, rig] of Object.entries(state.origin_rig_per_doc)) {
      originRigPerDoc.set(path, rig);
    }
  }
  if (state.last_destination_per_doc) {
    for (const [path, dest] of Object.entries(state.last_destination_per_doc)) {
      lastDestinationPerDoc.set(path, dest);
    }
  }
  if (Array.isArray(state.recent_rigs)) {
    recentRigsList.length = 0;
    recentRigsList.push(...state.recent_rigs.slice(0, MAX_RECENT_RIGS));
  }
  // Left-drawer collapsed state (optional field; defaults to expanded).
  if (state.left_drawer_collapsed) {
    setLeftDrawerCollapsed(true);
  }
  // Splitter widths: apply to the CSS variables BEFORE the tree restore so
  // PDF.js and the Claude pane size themselves correctly on first paint.
  if (state.layout_widths) {
    layoutWidths = state.layout_widths;
    const layoutEl = document.querySelector<HTMLElement>('.layout');
    const rightDrawerEl = document.querySelector<HTMLElement>('.right-drawer');
    if (layoutEl && rightDrawerEl) {
      applyLayoutWidths(layoutEl, rightDrawerEl, state.layout_widths);
    }
  }
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
      await openFileFromTreeOrPalette(state.last_opened_doc);
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
    // Flush both drafts and md source saves
    const flushes: Promise<void>[] = [];
    if (writeTimer !== null) {
      window.clearTimeout(writeTimer);
      writeTimer = null;
      flushes.push(flushDraftsWrite());
    }
    if (mdSaveTimer !== null) {
      window.clearTimeout(mdSaveTimer);
      mdSaveTimer = null;
      flushes.push(flushMdSave());
    }
    if (flushes.length === 0) {
      window.electronAPI.sendDraftsFlushAck(id);
      return;
    }
    try { await Promise.all(flushes); }
    finally { window.electronAPI.sendDraftsFlushAck(id); }
  });
  window.addEventListener('beforeunload', () => {
    if (writeTimer !== null) {
      window.clearTimeout(writeTimer);
      writeTimer = null;
      void flushDraftsWrite();
    }
    if (mdSaveTimer !== null) {
      window.clearTimeout(mdSaveTimer);
      mdSaveTimer = null;
      void flushMdSave();
    }
  });
}

async function mountStartupDiagnostics(): Promise<void> {
  const diag = document.getElementById('diag');
  if (!diag) return;

  const ipcLine = document.createElement('div');
  const engineLine = document.createElement('div');
  diag.append(ipcLine, engineLine);

  let ipcOk = false;
  let engineOk = false;

  // 1. IPC bridge smoke-test
  try {
    const reply = await window.electronAPI.ping('hello from renderer');
    ipcLine.textContent = `electronAPI ✓  ${reply}`;
    ipcOk = true;
  } catch (err) {
    ipcLine.textContent = `electronAPI ✗  ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. Engine reachability probe (no longer blocks PDF-open; pdf-health is
  //    exercised per-document now, not at startup).
  try {
    const result = await window.electronAPI.engineVersion();
    engineLine.textContent = formatEngineResult(result);
    engineOk = true;
  } catch (err) {
    engineLine.textContent = `engine ✗  IPC error: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (ipcOk && engineOk) {
    setTimeout(() => {
      diag.style.transition = 'opacity 0.5s ease-out';
      diag.style.opacity = '0';
      diag.addEventListener('transitionend', () => { diag.hidden = true; }, { once: true });
    }, 5000);
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

  // §10.4 — Cmd+S (Export Bundle) and Cmd+Return (Submit). Both write
  // the bundle to disk. Submit's gt-mail sling layer lives in rev-1md.4;
  // .1 stops at the on-disk artifact and surfaces a clear "Submit pipeline
  // not wired" diagnostic so the user understands the rest of the flow is
  // pending — without losing the bundle they just wrote.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      void handleExportBundle();
    } else if (e.key === 'Enter' || e.key === 'Return') {
      e.preventDefault();
      void handleSubmitBundle();
    }
  });
}

/** Cmd+S handler. Writes the bundle to the source dir using the current
 *  draft comments verbatim — Cmd+S preserves `open` status (§10.4). */
async function handleExportBundle(): Promise<void> {
  if (!docState.path || !docState.sha256) {
    flashAnchorMeta('Open a PDF before exporting a bundle.');
    return;
  }
  if (docState.comments.length === 0) {
    // Spec doesn't forbid empty-bundle writes; users may want a dated
    // archive copy of an unannotated PDF. We allow it but the indicator
    // tells the user clearly what just happened.
  }
  await writeBundle();
}

/** Cmd+Return handler. §10.1 step 1-3:
 *    1. Refresh the bundle so the JSON sidecar contains the freshest comments.
 *    2. Promote the draft → submit-<ts>.json (main side).
 *    3. Sling via `gt mail send` (or open the picker first if no origin).
 *    4. Drive the state machine (pill + banner).
 *
 *  Concurrent-round lock: blocked while Submit is in-flight (pending_send /
 *  sent_unconfirmed / timeout) OR a results file for this doc carries
 *  round_status: in_progress (the rev-1md.5 banner takes over in that case).
 */
async function handleSubmitBundle(): Promise<void> {
  if (!docState.path || !docState.sha256) {
    flashAnchorMeta('Open a PDF before submitting.');
    return;
  }
  // §10.1 step 6 concurrent-round lock — if a round for this doc is
  // currently in_progress, the round banner already offers Resume/Abandon;
  // a fresh Submit would race the rig.
  if (!submitCanFire() || submitIsInFlight()) {
    flashAnchorMeta('Submit already in flight.');
    return;
  }
  if (hasInProgressRound()) {
    flashAnchorMeta('A round is already in progress for this doc — resume or abandon it first.');
    return;
  }
  // Refresh the bundle so JSON sidecar matches what we're about to submit.
  // The bundle write returns the resolved paths via the saved-indicator
  // state machine; we re-derive them from filenames here too because we
  // need them for the submit payload.
  const written = await writeBundle();
  if (!written) return;
  // Pull the bundle paths from the most-recent write (writeBundle stamped
  // them via setSavedIndicator). We need them as absolute paths for the
  // submit payload; the bundle filename grammar is deterministic so we
  // recompute via the same date used by main. Simpler approach: re-export
  // those values from writeBundle's return — we plumb them inline here by
  // re-issuing the writeBundle call's result. To avoid a second write,
  // capture them by extending writeBundle's return.
  const bundleSnapshot = lastBundleSnapshot;
  if (!bundleSnapshot) {
    flashAnchorMeta('Bundle snapshot unavailable — try Cmd+S then Cmd+Return.');
    return;
  }
  const parsed = parseSourceName(docState.path.replace(/^.*[\\/]/, ''));
  const sourceFileVersion = parsed?.source_version ?? null;
  const gtProbe = await window.electronAPI.probeReviewer();
  const ctx: SubmitContext = {
    sourcePath: docState.path,
    sourceSha256: docState.sha256,
    sourceFileVersion,
    bundlePdfPath: bundleSnapshot.bundlePdfPath,
    bundleJsonPath: bundleSnapshot.bundleJsonPath,
    bundleId: bundleSnapshot.bundleId,
    submittedComments: docState.comments.map((c) => ({ ...c })),
    originRig: docState.originRig,
    appVersion: APP_VERSION,
    recentRigs: [...recentRigsList],
    lastDestinationForDoc: lastDestinationPerDoc.get(docState.path) ?? null,
    gasTownEnabled: gtProbe.enabled,
    author: 'AJB',
  };
  await executeSubmit(ctx);
}

/** True iff any tracked round for this doc has round_status:in_progress
 *  and is not in the "complete" sentinel. Used by the concurrent-round
 *  lock at Submit time. */
function hasInProgressRound(): boolean {
  for (const r of docState.rounds.values()) {
    if (r.results.round_status === 'in_progress') return true;
  }
  return false;
}

/** Most recent successful bundle write — Cmd+Return reads this so it
 *  doesn't have to re-derive bundle paths from the filename grammar. */
interface BundleSnapshot {
  bundleId: string;
  bundlePdfPath: string;
  bundleJsonPath: string;
}
let lastBundleSnapshot: BundleSnapshot | null = null;

/** Shared writer for Cmd+S and Cmd+Return. Returns true on a successful
 *  write so callers can chain follow-up flows. Flushes any pending drafts
 *  debounce first so the JSON sidecar contains the freshest comments. */
async function writeBundle(): Promise<boolean> {
  if (!docState.path || !docState.sha256 || !viewerRef) return false;
  // Drain the pending drafts debounce so what's on disk matches what
  // goes into the bundle JSON. Otherwise a Cmd+S 100ms after editing
  // would write a bundle with the edits but a drafts file without —
  // confusing on next reload (drafts is checked first, per §10.4).
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
    await flushDraftsWrite();
  }
  const pageCount = viewerRef.totalPages;
  if (pageCount === 0) {
    flashAnchorMeta('Wait for the PDF to finish loading before exporting.');
    return false;
  }
  const res = await window.electronAPI.writeBundle({
    sourcePath: docState.path,
    sourceSha256: docState.sha256,
    pageCount,
    comments: docState.comments,
    appVersion: APP_VERSION,
    author: 'AJB',
  });
  if (!res.ok) {
    flashAnchorMeta(`Bundle write failed (${res.reason}): ${res.error}`);
    setSavedIndicator({ kind: 'error', detail: `${res.reason}: ${res.error}` });
    return false;
  }
  // Mirror the freshly-minted pdf_annotation_id values back onto the
  // in-memory drafts so the next bundle write can preserve them (and
  // so the JSON sidecar's IDs stay aligned with the live draft). Persist
  // via the debounced writer rather than directly — same code path as a
  // normal edit, keeps the "Saved" semantics consistent.
  const idMap = new Map(res.annotationIds.map((x) => [x.commentId, x.pdfAnnotationId]));
  let changed = false;
  for (const c of docState.comments) {
    const next = idMap.get(c.id) ?? null;
    if ((c.pdf_annotation_id ?? null) !== next) {
      c.pdf_annotation_id = next;
      changed = true;
    }
  }
  if (changed) scheduleDraftsWrite();
  setSavedIndicator({ kind: 'bundle', at: new Date(), pdfPath: res.bundlePdfPath });
  lastBundleSnapshot = {
    bundleId: res.bundleId,
    bundlePdfPath: res.bundlePdfPath,
    bundleJsonPath: res.bundleJsonPath,
  };
  return true;
}

/** Bundle's `app_version` field. Hardcoded to match package.json for v1;
 *  refactor to an injected build-time constant when packaging lands. */
const APP_VERSION = '0.0.1';

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
  // Flush pending .md save before switching away
  if (mdSaveTimer !== null) {
    window.clearTimeout(mdSaveTimer);
    mdSaveTimer = null;
    await flushMdSave();
  }
  if (mdFileChangeUnsub) { mdFileChangeUnsub(); mdFileChangeUnsub = null; }
  void window.electronAPI.unwatchFile();
  mdSourceModified = false;
  if (mdViewerRef) {
    mdViewerRef.dispose();
    mdViewerRef = null;
  }
  h.title.textContent = `Loading ${basename(path)}…`;
  hideBanner(h.banner);
  // Flush any pending write for the previous doc before its sha256 is gone.
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
    await flushDraftsWrite();
  }
  // Reset per-doc state. selection cache and in-memory drafts belong to the
  // previous document. Results-watcher state likewise resets so banners for
  // the previous doc's rounds don't bleed onto this one.
  docState.path = path;
  docState.sha256 = '';
  docState.lastSelection = null;
  docState.comments = [];
  docState.rounds = new Map();
  // §10.5.1 — restore the originating rig for this doc (if recorded earlier
  // via --from). Survives app restarts (loaded from AppState on boot).
  docState.originRig = originRigPerDoc.get(path) ?? null;
  // §10.1 — reset Submit pill/banner so the previous doc's in-flight
  // state doesn't bleed onto this one.
  resetSubmit();
  lastBundleSnapshot = null;
  focusedCommentId = null;
  editingCommentId = null;
  clearInput();
  renderAllCards();
  updateAnchorMeta();
  hideRoundBanner();
  // §10.4 — reset the Saved indicator on doc switch. The previous doc's
  // bundle stamp doesn't belong to this one.
  setSavedIndicator({ kind: 'idle' });
  // Stop watching the previous doc's `.review-state/` (no-op when nothing
  // was being watched). Stop is awaitable but we don't need the result.
  void window.electronAPI.watchResultsStop();

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

  // §10.1 step 6 / §10.3 — load drafts *before* starting the results
  // watcher. The watcher's initial scan immediately emits events for
  // pre-existing results files; if drafts haven't populated docState.comments
  // by then, those events find no matching ids and drop their dispositions
  // on the floor. Serializing the two avoids that race; loadDrafts is a
  // single readFile so the added latency is negligible.
  await loadDraftsForCurrentDoc();
  // Bail if the user opened a different doc while drafts were loading —
  // applies-to-different-doc state is meaningless now.
  if (docState.path !== path || docState.sha256 !== bytesResult.sha256) {
    // continue with viewer load below; the new loadPdf will have already
    // reset state — nothing to do here.
  } else {
    // Start watching `.review-state/`. Failures aren't fatal; we just flash
    // the anchor meta so the user knows reflection is offline.
    void window.electronAPI.watchResultsStart(path, bytesResult.sha256).then((res) => {
      if (!res.ok) {
        flashAnchorMeta(`Results watcher failed (${res.reason ?? 'unknown'}): ${res.error ?? ''}`);
      }
    });
  }

  let viewerLoaded = false;
  try {
    showViewer(h);
    await h.viewer.loadBytes(bytesResult.bytes);
    h.title.textContent = basename(path);
    setViewerControlsEnabled(h, true);
    viewerLoaded = true;
  } catch (err) {
    h.title.textContent = basename(path);
    showLoadError(h, null, err);
    setViewerControlsEnabled(h, false);
  }
  // §9.2 — lazy spawn the Claude pane on first PDF open. Doc-switches after
  // the first emit a debounced notification line (§9.2.4). Both are
  // best-effort; failures show inline in the pane and don't block load.
  if (viewerLoaded) {
    if (useNewAgentPane()) {
      // Project 4 / M-int-3 — same payload, routed to the agent-viewer
      // backend's debounced notifyDocSwitch (sends a context line on the
      // active session, creating one if needed).
      const w = window as unknown as {
        agentViewer?: {
          notifyDocSwitch: (payload: {
            path: string;
            pages: number;
            comments: number;
          }) => Promise<void>;
        };
      };
      void w.agentViewer?.notifyDocSwitch({
        path,
        pages: h.viewer.totalPages,
        comments: docState.comments.length,
      });
    } else {
      const sourceDir = dirnameOf(path);
      void ensureClaudePaneSpawned({ docSourceDir: sourceDir }).then(() => {
        notifyClaudeDocSwitch({
          path,
          pages: h.viewer.totalPages,
          comments: docState.comments.length,
        });
      });
    }
  }
  // §3.3 — persist last-opened-doc and reflect the active row in the tree.
  // Safe to no-op when boot ordering hasn't wired them up yet.
  fileTree?.setActiveFile(path);
  scheduleAppStateSave();
  // rev-1md.3 — let the toolbar re-evaluate its enabled state now that a
  // doc is active. Pty-spawn-state is already broadcast separately by
  // claude-pane via 'claude-pane:spawn-state-changed'.
  window.dispatchEvent(new CustomEvent('toolbar:doc-state-changed'));
}

async function loadMarkdown(h: ViewerHandles, path: string): Promise<void> {
  h.title.textContent = `Loading ${basename(path)}…`;
  hideBanner(h.banner);
  // Flush pending .md save for previous doc
  if (mdSaveTimer !== null) {
    window.clearTimeout(mdSaveTimer);
    mdSaveTimer = null;
    await flushMdSave();
  }
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
    await flushDraftsWrite();
  }
  // Stop watching previous file
  if (mdFileChangeUnsub) { mdFileChangeUnsub(); mdFileChangeUnsub = null; }
  void window.electronAPI.unwatchFile();
  mdSourceModified = false;

  docState.path = path;
  docState.sha256 = '';
  docState.lastSelection = null;
  docState.comments = [];
  docState.rounds = new Map();
  docState.originRig = originRigPerDoc.get(path) ?? null;
  resetSubmit();
  lastBundleSnapshot = null;
  focusedCommentId = null;
  editingCommentId = null;
  clearInput();
  renderAllCards();
  updateAnchorMeta();
  hideRoundBanner();
  setSavedIndicator({ kind: 'idle' });
  void window.electronAPI.watchResultsStop();

  const bytesResult = await window.electronAPI.readPdfBytes(path);
  if (!bytesResult.ok) {
    h.title.textContent = basename(path);
    showLoadError(h, bytesResult);
    setViewerControlsEnabled(h, false);
    return;
  }

  docState.sha256 = bytesResult.sha256;
  await loadDraftsForCurrentDoc();

  if (mdViewerRef) {
    mdViewerRef.dispose();
    mdViewerRef = null;
  }

  lastMdSelection = null;
  const mdViewer = new MarkdownViewer({
    container: h.mount,
    onWikilinkClick: (target) => {
      resolveAndOpenWikilink(target);
    },
    onContentChange: () => {
      scheduleMdSave();
      syncMdAnchorsToComments();
    },
    onSelection: (sel) => {
      lastMdSelection = sel;
      updateAnchorMeta();
      if (sel) {
        const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
        if (input && activeTool === 'redraft') {
          input.value = sel.text;
          input.focus();
          input.select();
        }
      }
    },
    onBlur: () => {
      if (mdSaveTimer !== null) {
        window.clearTimeout(mdSaveTimer);
        mdSaveTimer = null;
        void flushMdSave();
      }
    },
  });
  mdViewerRef = mdViewer;

  // Start watching for external changes
  void window.electronAPI.watchFile(path);
  mdFileChangeUnsub = window.electronAPI.onFileChange((event) => {
    if (event.filePath !== path) return;
    if (mdSourceModified) {
      showExternalModificationModal(h, path);
    }
  });

  try {
    showViewer(h);
    await mdViewer.loadBytes(bytesResult.bytes);
    h.title.textContent = basename(path);
    h.prevBtn.disabled = true;
    h.nextBtn.disabled = true;
    reanchorMdComments();
  } catch (err) {
    h.title.textContent = basename(path);
    showLoadError(h, null, err);
    setViewerControlsEnabled(h, false);
  }

  if (useNewAgentPane()) {
    const w = window as unknown as {
      agentViewer?: {
        notifyDocSwitch: (payload: {
          path: string; pages: number; comments: number;
        }) => Promise<void>;
      };
    };
    void w.agentViewer?.notifyDocSwitch({
      path, pages: 1, comments: docState.comments.length,
    });
  } else {
    const sourceDir = dirnameOf(path);
    void ensureClaudePaneSpawned({ docSourceDir: sourceDir }).then(() => {
      notifyClaudeDocSwitch({
        path, pages: 1, comments: docState.comments.length,
      });
    });
  }
  fileTree?.setActiveFile(path);
  scheduleAppStateSave();
  window.dispatchEvent(new CustomEvent('toolbar:doc-state-changed'));
}

function showExternalModificationModal(h: ViewerHandles, path: string): void {
  const existing = document.getElementById('externalModModal');
  if (existing) return;

  const overlay = document.createElement('div');
  overlay.id = 'externalModModal';
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal-dialog';
  modal.innerHTML = `
    <h3>File modified externally</h3>
    <p>${basename(path)} was changed outside the editor while you have unsaved edits.</p>
    <div class="modal-actions">
      <button id="extModReload" class="modal-btn modal-btn-primary">Reload from disk</button>
      <button id="extModKeep" class="modal-btn">Keep my edits</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('extModReload')!.addEventListener('click', () => {
    overlay.remove();
    mdSourceModified = false;
    void openFileFromTreeOrPalette(path);
  });
  document.getElementById('extModKeep')!.addEventListener('click', () => {
    overlay.remove();
  });
}

function reanchorMdComments(): void {
  if (!mdViewerRef) return;
  const doc = mdViewerRef.getContent();
  const tracked: Array<{ commentId: string; from: number; to: number; orphaned: boolean }> = [];
  for (const c of docState.comments) {
    if (!c.md_anchor) continue;
    const match = fuzzyMatchAnchor(doc, c.md_anchor);
    tracked.push({
      commentId: c.id,
      from: match.from,
      to: match.to,
      orphaned: match.confidence === 'orphaned',
    });
    c.md_anchor.char_start = match.from;
    c.md_anchor.char_end = match.to;
  }
  mdViewerRef.setTrackedAnchors(tracked);
}

function syncMdAnchorsToComments(): void {
  if (!mdViewerRef) return;
  const anchors = mdViewerRef.getTrackedAnchors();
  const byId = new Map(docState.comments.map((c) => [c.id, c]));
  for (const a of anchors) {
    const c = byId.get(a.commentId);
    if (!c || !c.md_anchor) continue;
    if (a.orphaned) {
      c.md_anchor.char_start = -1;
      c.md_anchor.char_end = -1;
    } else {
      c.md_anchor.char_start = a.from;
      c.md_anchor.char_end = a.to;
      const doc = mdViewerRef.getContent();
      if (a.from >= 0 && a.to <= doc.length) {
        c.md_anchor.quoted_text = doc.slice(a.from, a.to);
        c.md_anchor.prefix = doc.slice(Math.max(0, a.from - 40), a.from);
        c.md_anchor.suffix = doc.slice(a.to, Math.min(doc.length, a.to + 40));
      }
    }
  }
}

function resolveAndOpenWikilink(target: string): void {
  if (!fileTree) return;
  const root = fileTree.snapshot().root;
  if (!root) return;
  const candidates = [
    `${root}/${target}`,
    `${root}/${target}.md`,
    `${root}/${target}.markdown`,
  ];
  for (const candidate of candidates) {
    void window.electronAPI.pathExists(candidate).then((res) => {
      if (res.ok && res.exists && res.isFile) {
        void openFileFromTreeOrPalette(candidate);
      }
    });
  }
}

async function loadDraftsForCurrentDoc(): Promise<void> {
  if (!docState.path || !docState.sha256) return;
  const path = docState.path;
  const sha256 = docState.sha256;
  const cached = draftsCache.get(path);
  if (cached) {
    console.log('[drafts] load', { path, sha256: sha256.slice(0, 12), reason: 'cache_hit', commentCount: cached.comments.length });
    docState.comments = cached.comments;
    renderAllCards();
    return;
  }
  const res = await window.electronAPI.readDrafts(path, sha256);
  if (docState.path !== path || docState.sha256 !== sha256) return;
  if (!res.ok) {
    flashAnchorMeta(`Drafts load failed (${res.reason}): ${res.error}`);
    console.warn('[drafts] load failed', { path, sha256: sha256.slice(0, 12), reason: res.reason, error: res.error });
    return;
  }
  const commentCount = res.file?.comments.length ?? 0;
  console.log('[drafts] load', {
    path,
    sha256: sha256.slice(0, 12),
    reason: res.file === null ? 'not_found' : 'ok',
    commentCount,
  });
  docState.comments = res.file?.comments ?? [];
  if (res.file) draftsCache.set(path, res.file);
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
  const isMd = classifyPath(docState.path) === 'md';
  if (isMd) {
    if (!lastMdSelection) {
      meta.textContent = docState.path
        ? 'No selection — highlight text to anchor a comment.'
        : 'No file loaded.';
      meta.classList.remove('has-selection');
      return;
    }
    const snippet = truncate(lastMdSelection.text, 60);
    meta.textContent = `chars ${lastMdSelection.from}–${lastMdSelection.to} · “${snippet}”`;
    meta.classList.add('has-selection');
    return;
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

  const isMd = classifyPath(docState.path) === 'md';

  if (isMd && lastMdSelection && mdViewerRef) {
    const doc = mdViewerRef.getContent();
    const mdAnchor = createMdAnchor(doc, lastMdSelection.from, lastMdSelection.to);
    const payload = buildMdCommentPayload(buf, lastMdSelection, mdAnchor);
    docState.comments.unshift(payload);
    renderAllCards();
    scheduleDraftsWrite();
    reanchorMdComments();
    clearInput();
    input.focus();
    return;
  }

  if (!isMd && !docState.lastSelection) {
    flashAnchorMeta('Select text in the PDF first to anchor this comment.');
    return;
  }
  if (!docState.lastSelection) {
    flashAnchorMeta('Select text first to anchor this comment.');
    return;
  }
  const payload = buildCommentPayload(buf, docState.lastSelection);
  docState.comments.unshift(payload);
  renderAllCards();
  scheduleDraftsWrite();
  clearInput();
  input.focus();
}

function buildMdCommentPayload(
  buf: string,
  sel: MdSelection,
  mdAnchor: ReturnType<typeof createMdAnchor>,
): CommentPayload {
  const isRedraft = activeTool === 'redraft';
  return {
    id: crypto.randomUUID(),
    doc_id: docState.path,
    doc_version: docState.sha256,
    anchor: { page: 1, region: { x: 0, y: 0, w: 0, h: 0 } },
    highlighted_text: sel.text,
    comment: isRedraft ? '' : buf,
    redraft: isRedraft ? buf : null,
    redraft_suggestion: null,
    engagement_level: activeTool,
    author: 'AJB',
    kind: 'comment',
    status: 'open',
    created_at: new Date().toISOString(),
    md_anchor: mdAnchor,
  };
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
  // rev-1md.5: status drives the badge + the dimmed-for-terminal-state look.
  // Default to 'open' if a legacy draft predates the status field.
  card.dataset.status = c.status ?? 'open';
  // rev-680: cards are individually focusable so Tab walks them and the
  // spec's `j`/`k`/`Enter` bindings have a clear "currently focused card"
  // to operate on. role=button so AT users hear "button" semantics — click
  // and Enter both reveal the anchor.
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  // For comments with a `new_anchor` (rig moved the text on apply), the
  // reveal points at the new location — that's where the resulting text
  // actually lives. Original anchor is kept on the comment for audit only.
  const revealAnchor = c.new_anchor ?? c.anchor;
  card.setAttribute('aria-label', `${labelFor(c.engagement_level)} on page ${revealAnchor.page}`);
  card.addEventListener('focus', () => { focusedCommentId = c.id; });
  card.addEventListener('click', () => {
    if (!viewerRef) return;
    void viewerRef.revealAnchor(revealAnchor.page, revealAnchor.region);
  });

  const head = document.createElement('div');
  head.className = 'comment-card-head';
  const level = document.createElement('span');
  level.className = 'comment-card-level';
  level.textContent = labelFor(c.engagement_level);
  const status = document.createElement('span');
  status.className = 'comment-card-status';
  status.textContent = statusLabel(c.status ?? 'open');
  // §8.5 — re-raised v1.1 comment. Card retains the derived_from link so
  // the user can see at a glance "this is a follow-on from a prior round".
  // Click-through to the original submit file is deferred to a later
  // milestone (we don't have an archived-submit viewer yet).
  let derived: HTMLSpanElement | null = null;
  if (c.derived_from) {
    derived = document.createElement('span');
    derived.className = 'comment-card-derived';
    derived.textContent = '(re-raised from a prior round)';
    derived.title = `derived_from: ${c.derived_from}`;
  }
  const anchor = document.createElement('span');
  anchor.className = 'comment-card-anchor';
  const r = revealAnchor.region;
  anchor.textContent = `· p.${revealAnchor.page} · ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
  head.append(level, status);
  if (derived) head.append(derived);
  head.append(anchor, buildCardActions(c));

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
  // Agent note from the rig (status-dependent: build error excerpt, redirect-
  // to-L3 advice, terse confirmation, etc.). Rendered as a quoted aside under
  // the user's body so it's clearly someone else's voice.
  if (c.agent_note) {
    const note = document.createElement('div');
    note.className = 'comment-card-agent-note';
    note.textContent = c.agent_note;
    card.append(note);
  }

  return card;
}

function statusLabel(s: CommentStatus): string {
  switch (s) {
    case 'open': return 'open';
    case 'submitted': return 'submitted';
    case 'applied': return 'applied';
    case 'deferred': return 'deferred';
    case 'needs-followup': return 'needs follow-up';
    case 'rejected': return 'rejected';
    case 'build_failed': return 'build failed';
  }
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

// ─── rev-1md.5: results-file watcher → status reflection ─────────────────
//
// Main pushes a `results:event` whenever a `.review-state/results-*.json`
// file changes. We:
//   1. Drop events that target a different doc (matchesDoc=false).
//   2. Apply the rig's per-comment dispositions onto our in-memory drafts,
//      then re-render + debounce-persist (so the live draft has the new
//      statuses + agent notes after the watcher reflects them).
//   3. Track the round in docState.rounds so we can render the most-recent
//      banner (in-progress / complete / interrupted).
//   4. On round_status:complete with a new_source_path, seed the v1.1
//      draft (deferred + needs-followup → fresh `open` comments with
//      derived_from set), then surface the "Round complete — [open v1.1]"
//      CTA in the banner.

function wireResultsEvents(): void {
  window.electronAPI.onResultsEvent((event) => {
    // Ignore events for doc-versions that don't match the currently-open
    // doc. Main also surfaces these (deliberately, for diagnostics) so we
    // can debug a misaligned submit/results pair from devtools — but for
    // normal UI flow they're noise.
    if (!event.matchesDoc) return;
    void applyResultsEvent(event);
  });
}

async function applyResultsEvent(event: ResultsEvent): Promise<void> {
  const { results, submit } = event;
  // §10.1 step 4 — handoff to the Submit state machine. The first time we
  // see this round's results file with any content, that's the ack signal
  // (submit:sent_unconfirmed → idle). When it flips to a terminal
  // round_status, surface a brief "Round complete" toast in the pill.
  if (event.matchesDoc) {
    markSubmitAcknowledged(results.submit_id);
    if (results.round_status === 'complete') {
      markSubmitRoundComplete(results.submit_id, true);
    } else if (results.round_status === 'failed') {
      markSubmitRoundComplete(results.submit_id, false);
    }
  }
  // Apply per-entry dispositions. Match on comment id; the rig only writes
  // results entries for comments that were in the submit file, so a result
  // pointing at a draft entry we don't have is a stale-cache scenario worth
  // surfacing rather than silently dropping.
  const byId = new Map<string, CommentPayload>(docState.comments.map((c) => [c.id, c]));
  let changed = false;
  for (const r of results.results) {
    const target = byId.get(r.id);
    if (!target) {
      // Could happen if the user manually edited the drafts file; not fatal.
      continue;
    }
    if (applyEntry(target, r)) changed = true;
  }
  if (changed) {
    renderAllCards();
    scheduleDraftsWrite();
  }

  // Track this round's latest snapshot. We keep one entry per submit_id so
  // the banner reflects whichever round is most recent. If we've already
  // seeded this completed round, preserve `seeded:true` so re-emits don't
  // re-seed.
  const prev = docState.rounds.get(results.submit_id);
  docState.rounds.set(results.submit_id, {
    submit_id: results.submit_id,
    results_id: results.results_id,
    filePath: event.filePath,
    results,
    seeded: prev?.seeded ?? false,
  });
  renderRoundBanner();

  // §10.1 step 6 / §10.3 — on round complete, seed a fresh draft for the
  // new versioned source file. The seeded draft re-raises every
  // `deferred` / `needs-followup` item as a new `open` comment keyed on
  // the new file's sha256, with derived_from set to the original id.
  if (
    results.round_status === 'complete' &&
    results.new_source_path &&
    submit !== null &&
    !(docState.rounds.get(results.submit_id)?.seeded)
  ) {
    void seedNextVersionDraft(event);
  }
}

/** Mutate `target` in place per the rig's result entry. Returns true if any
 *  field actually changed (drives the dirty-flag for re-render + write). */
function applyEntry(target: CommentPayload, r: ResultEntry): boolean {
  let changed = false;
  const nextStatus: CommentStatus = r.status;
  if (target.status !== nextStatus) {
    target.status = nextStatus;
    changed = true;
  }
  // agent_note overwrites (the rig is the authority on its own commentary;
  // an updated note replaces the previous one — typically only the
  // last-write matters in practice).
  if ((target.agent_note ?? null) !== (r.agent_note ?? null)) {
    target.agent_note = r.agent_note ?? null;
    changed = true;
  }
  if ((target.new_anchor ?? null) !== (r.new_anchor ?? null)) {
    // Shallow compare-by-reference would miss a re-emit with the same
    // values; deep-compare via JSON is fine at this scale.
    const a = JSON.stringify(target.new_anchor ?? null);
    const b = JSON.stringify(r.new_anchor ?? null);
    if (a !== b) {
      target.new_anchor = r.new_anchor ?? null;
      changed = true;
    }
  }
  return changed;
}

function hideRoundBanner(): void {
  const banner = document.getElementById('roundBanner');
  if (!banner) return;
  banner.hidden = true;
  banner.removeAttribute('data-state');
  banner.replaceChildren();
}

/** Render the banner for the most-relevant round in `docState.rounds`.
 *  Selection rule: prefer an `in_progress` round (live or interrupted),
 *  otherwise the latest `complete` (its CTA stays visible until the user
 *  opens the new version or switches docs), otherwise hidden. */
function renderRoundBanner(): void {
  const banner = document.getElementById('roundBanner');
  if (!banner) return;
  const rounds = Array.from(docState.rounds.values());
  if (rounds.length === 0) { hideRoundBanner(); return; }
  // Sort by results_id (timestamp prefix) descending — most recent first.
  rounds.sort((a, b) => b.results_id.localeCompare(a.results_id));
  // Pick the highest-priority round to surface.
  const inProgress = rounds.find((r) => r.results.round_status === 'in_progress');
  const failed = rounds.find((r) => r.results.round_status === 'failed');
  const complete = rounds.find((r) => r.results.round_status === 'complete');
  const pick = inProgress ?? failed ?? complete;
  if (!pick) { hideRoundBanner(); return; }
  fillRoundBanner(banner, pick);
}

function fillRoundBanner(banner: HTMLElement, round: ResultsRoundState): void {
  banner.hidden = false;
  banner.replaceChildren();
  const r = round.results;
  const text = document.createElement('div');
  text.className = 'round-banner-text';
  const actions = document.createElement('div');
  actions.className = 'round-banner-actions';

  if (r.round_status === 'in_progress') {
    const processed = r.results.length;
    // The submit file would tell us the total; without it we report the
    // partial count alone. (matchesDoc:true means the submit was found —
    // could plumb its comment count through if needed for "N of M".)
    const interrupted = isLikelyInterrupted(r);
    if (interrupted) {
      banner.setAttribute('data-state', 'interrupted');
      const head = document.createElement('strong');
      head.textContent = 'Previous round was interrupted.';
      const detail = document.createElement('span');
      detail.className = 'round-banner-detail';
      detail.textContent = `Started ${formatRelativeTimestamp(r.started_at)} — ${processed} comments processed before the rig stopped.`;
      text.append(head, detail);
      // §10.1 step 6 — Resume re-slings the existing submit file to the
      // recorded origin (or opens the picker for standalone). Re-sling
      // matches the spec's "re-invoke the rig" semantics: the rig sees
      // the same submit_id and continues from the partial results file
      // per the resume guard. Implementation: we mint a follow-up sling
      // by reading the submit file via main, but the simpler path that
      // matches the spec is to just re-Submit — the rig dedups on
      // submit_id. Until that's wired through, we direct the user to
      // hit Cmd+Return again, which is the same payload.
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'is-primary';
      resume.textContent = 'Resume round';
      resume.title = 'Re-sling the existing submit file to the rig.';
      resume.addEventListener('click', () => {
        // Easiest path: tell the user to hit Cmd+Return; the rig's resume
        // guard handles dedup on submit_id. A first-class "resume from
        // banner" path is tracked separately.
        flashAnchorMeta('Press Cmd+Return to re-sling this round.');
      });
      // §10.1 step 6 — Abandon: rename results-<ts>.json →
      // results-<ts>.abandoned.json so the rig's resume guard ignores it
      // and the app's in-memory state flips back to idle (Submit re-enables).
      const abandon = document.createElement('button');
      abandon.type = 'button';
      abandon.textContent = 'Abandon round';
      abandon.title = 'Mark this round as abandoned so a fresh Submit can start.';
      abandon.addEventListener('click', () => { void abandonInterruptedRound(round); });
      actions.append(resume, abandon);
    } else {
      banner.setAttribute('data-state', 'in_progress');
      const head = document.createElement('strong');
      head.textContent = 'Round in progress.';
      const detail = document.createElement('span');
      detail.className = 'round-banner-detail';
      detail.textContent = `${processed} comments processed so far. Started ${formatRelativeTimestamp(r.started_at)}.`;
      text.append(head, detail);
    }
  } else if (r.round_status === 'complete') {
    banner.setAttribute('data-state', 'complete');
    const applied = r.results.filter((x) => x.status === 'applied').length;
    const failedCount = r.results.filter((x) => x.status === 'build_failed').length;
    const followup = r.results.filter((x) => x.status === 'needs-followup').length;
    const deferred = r.results.filter((x) => x.status === 'deferred').length;
    const rejected = r.results.filter((x) => x.status === 'rejected').length;
    const head = document.createElement('strong');
    head.textContent = `Round complete — ${applied} applied, ${failedCount} build failures.`;
    const detail = document.createElement('span');
    detail.className = 'round-banner-detail';
    const parts: string[] = [];
    if (deferred > 0) parts.push(`${deferred} deferred`);
    if (followup > 0) parts.push(`${followup} need follow-up`);
    if (rejected > 0) parts.push(`${rejected} rejected`);
    detail.textContent = parts.length > 0
      ? `${parts.join(', ')} — re-raised in the new version's draft.`
      : 'No items re-raised; the new versioned source is ready.';
    text.append(head, detail);
    if (r.new_source_path) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'is-primary';
      open.textContent = r.version_chosen
        ? `Open ${r.version_chosen}`
        : 'Open new version';
      open.addEventListener('click', () => {
        // The seeded draft (if any) was written before this banner
        // rendered, so loadPdf reads the freshly-seeded draft file when
        // it opens the new doc.
        void openFileFromTreeOrPalette(r.new_source_path!);
      });
      actions.append(open);
    }
  } else if (r.round_status === 'failed') {
    banner.setAttribute('data-state', 'failed');
    const head = document.createElement('strong');
    head.textContent = 'Round failed.';
    const detail = document.createElement('span');
    detail.className = 'round-banner-detail';
    detail.textContent = 'The rig couldn’t finish the round. Check the rig session for details.';
    text.append(head, detail);
  }
  banner.append(text, actions);
}

/** §10.1 step 6 — soft-tombstone an interrupted round so Submit re-enables
 *  and the resume banner clears. We rename the results file on disk via
 *  main; the renderer drops its in-memory round so the banner picker
 *  re-sorts (the next-most-recent round becomes the visible one, if any). */
async function abandonInterruptedRound(round: ResultsRoundState): Promise<void> {
  const ok = window.confirm(
    `Abandon this round?\n\nThe partial results file will be renamed to .abandoned.json — not deleted. You can re-open it later if you want to consult the dispositions.`,
  );
  if (!ok) return;
  const res = await window.electronAPI.submitAbandonRound({
    resultsFilePath: round.filePath,
  });
  if (!res.ok) {
    flashAnchorMeta(`Abandon failed (${res.reason}): ${res.error}`);
    return;
  }
  // Drop the in-memory round and re-render the banner. The watcher will
  // also fire for the rename, but we don't wait — flipping state
  // immediately matches user expectation.
  docState.rounds.delete(round.submit_id);
  renderRoundBanner();
  resetSubmit();
}

/** Heuristic for "interrupted" vs "live in progress": an in_progress round
 *  whose `started_at` is more than ~2 minutes in the past with no recent
 *  results-file change is almost certainly an abandoned run. We use the
 *  event's `source` (initial vs change) as a stronger signal: an initial
 *  scan reading `in_progress` means the rig wasn't running when we opened
 *  the doc. */
function isLikelyInterrupted(r: ResultsFile): boolean {
  if (r.round_status !== 'in_progress') return false;
  if (!r.started_at) return false;
  const startedMs = Date.parse(r.started_at);
  if (Number.isNaN(startedMs)) return false;
  const ageMs = Date.now() - startedMs;
  // 2 minutes: rounds normally complete or progress within this window;
  // longer than that without a fresh results-file write is interrupted.
  return ageMs > 2 * 60 * 1000;
}

function formatRelativeTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const deltaSec = Math.round((Date.now() - t) / 1000);
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h ago`;
  return `${Math.round(deltaSec / 86400)}d ago`;
}

/** §10.1 step 6 — write the v1.1 draft for the just-completed round so the
 *  new versioned source file opens with re-raised comments already in place.
 *
 *  Re-raise policy (§8.5):
 *    - `applied` / `rejected` / `build_failed` → archived only (don't appear
 *      in the new draft).
 *    - `deferred` / `needs-followup` → fresh `open` comments with
 *      `derived_from` pointing at the original id, anchored at `new_anchor`
 *      if set (the redraft may have shifted text) else at the original
 *      `anchor`.
 *
 *  The new file's sha256 is computed by re-reading its bytes through main
 *  (`readPdfBytes` already returns the digest), so the seeded draft is keyed
 *  on `<new_sha256>.json` and loadPdf will pick it up on open. */
async function seedNextVersionDraft(event: ResultsEvent): Promise<void> {
  const { results, submit } = event;
  if (!submit) return;
  if (!results.new_source_path) return;

  // Read the new file's bytes to compute its sha256 = new doc_version.
  const bytes = await window.electronAPI.readPdfBytes(results.new_source_path);
  if (!bytes.ok) {
    flashAnchorMeta(`Couldn’t seed next-version draft: ${bytes.reason} ${results.new_source_path}`);
    return;
  }
  const newSha = bytes.sha256;
  const newDocId = bytes.resolvedPath;

  // Build the re-raise list: only deferred + needs-followup carry forward.
  const submitById = new Map(submit.comments.map((c) => [c.id, c]));
  const reraised: CommentPayload[] = [];
  for (const r of results.results) {
    if (r.status !== 'deferred' && r.status !== 'needs-followup') continue;
    const original = submitById.get(r.id);
    if (!original) continue; // results entry without a submit-side twin; skip.
    const anchor = r.new_anchor ?? original.anchor;
    reraised.push({
      id: crypto.randomUUID(),
      doc_id: newDocId,
      doc_version: newSha,
      anchor,
      highlighted_text: original.highlighted_text,
      comment: original.comment,
      redraft: original.redraft,
      redraft_suggestion: null,
      engagement_level: original.engagement_level,
      author: original.author,
      kind: 'comment',
      status: 'open',
      created_at: new Date().toISOString(),
      derived_from: original.id,
      agent_note: r.agent_note ?? null,
    });
  }

  const file: DraftsFile = {
    schema_version: 1,
    doc_version: newSha,
    comments: reraised,
  };
  const res = await window.electronAPI.writeDrafts(newDocId, newSha, file);
  if (!res.ok) {
    flashAnchorMeta(`Couldn’t write next-version draft (${res.reason}): ${res.error}`);
    return;
  }
  // Mark the round as seeded so re-emits don't duplicate the draft. The
  // existing draft would be overwritten cleanly (same sha256 path) but
  // the dup work is wasted I/O.
  const round = docState.rounds.get(results.submit_id);
  if (round) round.seeded = true;
}

void init();
