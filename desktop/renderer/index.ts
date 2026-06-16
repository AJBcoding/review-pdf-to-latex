import type {
  Anchor,
  AppStateFile,
  CommentPayload,
  CommentStatus,
  DraftsFile,
  EngagementLevel,
  EngineResult,
  PdfHealthResult,
  ReadFileBytesResult,
  ResultEntry,
  ResultsEvent,
  ResultsFile,
} from '@shared/types';
import { REVIEWER_LOCAL_ID } from '@shared/types';
import { parseSourceName } from '@shared/bundle';
import { PdfViewer } from './pdf-viewer';
import type { NativePdfAnnotation } from './pdf-viewer';
import { MarkdownViewer } from './md-viewer';
import { HtmlViewer } from './html-viewer';
import { DocxViewer } from './docx-viewer';
import { IframeDocViewer } from './iframe-doc-viewer';
import { createMdAnchor } from '@shared/md/anchors';
import { classifyPath, docFormatForPath } from '@shared/file-kinds';
import { basename, dirnameOf } from '@shared/paths';
import type { FileViewer, ViewerSelection } from '@shared/file-viewer';
import { FileTree } from './tree';
import { QuickOpenPalette } from './palette';
import { mountAgentPane } from './agent-pane/main';
import { seedNextVersionDraft as seedNextVersionDraftPure } from './seed-next-draft';
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
  canRetry as submitCanRetry,
  resling as reslingSubmit,
  canResume as submitCanResume,
  type SubmitContext,
} from './submit';

// Renderer entry. Milestone #2 (project-open flow):
//
//   1. Two startup diagnostics — IPC bridge + engine reachability — surface
//      in the top-right strip so AJB can confirm the engine is wired up
//      without having to open a PDF.
//   2. Empty state in the document pane until the user picks a file.
//   3. Open… button → native picker → pdfHealth() + readFileBytes() run in
//      parallel → render the page + surface the §5.2 banner if the report
//      flags problems.
//
// The §5.2 banner copy mirrors the spec's load-time pre-flight requirement:
// distinct messages for encrypted / all-unreadable / partial / ligature-loss /
// open-error, and no banner at all when the PDF is clean.

/** DOM surface the document pane owns. The viewer instance itself is no longer
 *  a handle — X7 makes it per-open module state (`activeViewer`) constructed via
 *  the format registry, so every format shares one mount + chrome. */
interface ViewerHandles {
  mount: HTMLElement;
  empty: HTMLElement;
  title: HTMLElement;
  banner: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  fitPageBtn: HTMLButtonElement;
  fitWidthBtn: HTMLButtonElement;
  darkBtn: HTMLButtonElement;
  pageLabel: HTMLElement;
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
  /** Last selection the active viewer reported, as the unified
   *  `ViewerSelection` (X7) — one field for all formats, replacing the v1 trio
   *  of pdf/md/html `lastSelection` lets. Persists across submits so the user
   *  can stack Comment + Redraft against the same highlight. */
  lastSelection: ViewerSelection | null;
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

// X7 single-flight open queue. Subsumes rev-ra6's epoch guard: `openDocument`
// is the one entry point for loading a doc (tree / palette / Open… / external /
// wikilink all funnel through it). Every request claims a monotonic token and
// is chained after the previous open settles, so two opens never interleave
// their `docState` mutations. A request newer than mine bumps `openToken`;
// `openSuperseded(myToken)` then short-circuits a queued-but-stale open before
// it starts and bails an in-flight one after each await — exactly the race the
// epoch guard fixed, now without four hand-copied checklists.
let openToken = 0;
let openChain: Promise<void> = Promise.resolve();

function openSuperseded(token: number): boolean {
  return token !== openToken;
}

/** THE document open entry point (X7). Returns a promise that settles when this
 *  request finishes or is superseded. */
function openDocument(path: string): Promise<void> {
  const myToken = ++openToken;
  openChain = openChain.then(() => runOpen(path, myToken)).catch(() => { /* runOpen surfaces its own errors */ });
  return openChain;
}

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
/** The currently-mounted viewer, whatever its format (X7). One ref replaces the
 *  v1 quartet of pdf/md/html/docx `*ViewerRef` lets; the open queue disposes it
 *  and constructs the next via the format registry. */
let activeViewer: FileViewer | null = null;
/** Session dark-mode preference, applied to every viewer the registry builds.
 *  Held in module state because viewers are now per-open: without it, dark mode
 *  would reset on each doc switch (v1's persistent PDF viewer kept it across
 *  PDF opens — this preserves that, and now extends it to every format). */
let darkModePref = false;

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
  if (!docState.path || !(activeViewer instanceof MarkdownViewer)) return;
  const content = activeViewer.getContent();
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
  const res = await window.electronAPI.readFileBytes(docState.path);
  return res.ok ? res.sha256 : null;
}

// ─── Drafts write debounce (§10.3 — 250ms) ─────────────────────────────────
let writeTimer: number | null = null;
const WRITE_DEBOUNCE_MS = 250;
const draftsCache = new Map<string, DraftsFile>();

/** Cache key for an in-memory drafts snapshot. Drafts are a function of
 *  (path, content) — keying on path alone lets a stale entry from one
 *  doc_version mask a different version's sidecar on disk (e.g. v1 → v1.1
 *  share a logical path while a re-seed rewrites the file). Keying on both
 *  makes every cache hit version-exact; a sha change just falls through to a
 *  fresh disk read (which is itself path-keyed). */
function draftsCacheKey(path: string, sha256: string): string {
  return `${sha256}\u0000${path}`;
}

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
  const file: DraftsFile = {
    schema_version: 2,
    doc_version: docState.sha256,
    format: docFormatForPath(docState.path),
    // L3: native PDF annotations are a read-projection of the source — they're
    // re-derived on every open, so we never freeze them into the working-state
    // sidecar (they'd just be deduped away on the next render anyway).
    comments: docState.comments.filter((c) => c.origin !== 'native-pdf'),
  };
  draftsCache.set(draftsCacheKey(docState.path, docState.sha256), file);
  const res = await window.electronAPI.writeDrafts(docState.path, file);
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
  // rev-n6: the Retry / Re-sling / Resume buttons now re-sling the cached
  // round directly inside the submit module (same submit_id, no re-promote),
  // so there is no longer a `submit:retry-requested` round-trip through
  // handleSubmitBundle (which used to mint a duplicate round).
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
  if (!empty || !term || !error || !identity || !body || !tabs) return;

  // X8 stage 4 (rev-enext.3): the React agent pane is the only surface now
  // that the OD-3 parity checklist is green and the legacy pty route is
  // retired. Hide the legacy xterm DOM scaffold and mount the React island in
  // its place — the agent-viewer renderer uses its own internal layout.
  empty.style.display = 'none';
  term.style.display = 'none';
  error.style.display = 'none';
  identity.style.display = 'none';
  tabs.style.display = 'none';
  body.classList.add('agent-pane-react-host');
  mountAgentPane(body);
  const createBtn = document.getElementById('toolbarCreateContext') as HTMLButtonElement | null;
  const slingBtn = document.getElementById('toolbarSling') as HTMLButtonElement | null;
  if (createBtn) createBtn.title = 'Create Context: spawn a focused agent session with current page + selection';
  if (slingBtn) slingBtn.title = 'Sling: send the current review to another rig for processing';
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
      // Page info is meaningful only for paged formats (PDF); non-paged viewers
      // report 1/1, so mirror the v1 null for those (Create-Context is PDF-centric).
      currentPage: () => (activeViewer?.capabilities.paged ? activeViewer.currentPage : null),
      pageCount: () => (activeViewer?.capabilities.paged ? activeViewer.totalPages : null),
      selection: () => {
        // Create-Context is PDF-centric; only a pdf-quad selection carries the
        // page + region the toolbar context needs.
        const sel = docState.lastSelection;
        if (!sel || sel.kind !== 'pdf-quad') return null;
        return {
          page: sel.page,
          region: sel.region,
          highlightedText: sel.text,
        };
      },
      comments: () => docState.comments,
    },
  });
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

/** Mirror of AppStateFile.claude_dangerous_skip_permissions. Seeded from
 *  readAppState in restoreFromAppState; updated by the settings checkbox.
 *  Held in module state so flushAppStateSave reads the live value on both
 *  the legacy pane path and the new agent-pane path (where bootClaudeSettings
 *  is never called and the window global is undefined). Default true matches
 *  the AppStateFile field default (read site line 467). */
let claudeSkipPermissions = true;

/** Last AppState snapshot written or read. Spread into flushAppStateSave writes
 *  so fields with no live UI (e.g., future additions) are never clobbered to
 *  defaults. */
let lastReadAppState: AppStateFile | null = null;

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
    onOpenFile: (path) => { void openDocument(path); },
    onStateChange: () => { scheduleAppStateSave(); },
  });

  palette = new QuickOpenPalette({
    root: paletteRoot, input: paletteInput, list: paletteList, empty: paletteEmpty,
    onPick: (path) => { void openDocument(path); },
  });

  openBtn.addEventListener('click', () => { void openFolderPicker(); });
  emptyOpenLink.addEventListener('click', (e) => { e.preventDefault(); void openFolderPicker(); });

  // §3.4 — main pushes external-open requests through this channel. We wire
  // it here (after the tree is alive) so openDocument is always callable when
  // a buffered cold-launch request flushes. §10.5.1 — record the `from`
  // rig-id (if any) before openDocument so the picker logic sees an origin on
  // first Submit.
  window.electronAPI.onOpenExternalFile((event) => {
    if (event.from) {
      rememberOriginRig(event.path, event.from);
      scheduleAppStateSave();
    }
    void openDocument(event.path);
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
    // Spread previously-read state first so fields with no live UI are never
    // clobbered to defaults (e.g., future AppStateFile additions).
    ...lastReadAppState,
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
    claude_dangerous_skip_permissions: claudeSkipPermissions,
  };
  const res = await window.electronAPI.writeAppState(state);
  if (!res.ok) {
    flashAnchorMeta(`App-state save failed (${res.reason}): ${res.error}`);
    return;
  }
  lastReadAppState = state;
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
  claudeSkipPermissions = state.claude_dangerous_skip_permissions !== false;
  lastReadAppState = state;
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
      await openDocument(state.last_opened_doc);
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

  // X7: the viewer is no longer created here. `openDocument` builds the right
  // one per open via the format registry and assigns `activeViewer`. This boot
  // only owns the DOM chrome + button wiring (delegating to whatever viewer is
  // currently active) and the empty-state toggle.
  const handles: ViewerHandles = {
    mount, empty, title, banner,
    prevBtn, nextBtn, fitPageBtn, fitWidthBtn, darkBtn, pageLabel,
  };
  // Exposed to bootLeftDrawerAndPalette + the registry so the tree / palette /
  // external open / Open… button all open through the same openDocument path.
  viewerHandlesRef = handles;

  bootToolPaletteAndInput();

  prevBtn.addEventListener('click', () => { void activeViewer?.prevPage(); });
  nextBtn.addEventListener('click', () => { void activeViewer?.nextPage(); });
  fitPageBtn.addEventListener('click', () => { void activeViewer?.fitPage(); });
  fitWidthBtn.addEventListener('click', () => { void activeViewer?.fitWidth(); });
  darkBtn.addEventListener('click', () => {
    if (!activeViewer) return;
    darkModePref = !activeViewer.isDarkMode();
    activeViewer.setDarkMode(darkModePref);
    darkBtn.setAttribute('aria-pressed', String(darkModePref));
  });

  openBtn.addEventListener('click', () => { void handleOpenClick(openBtn); });

  bindCommentStreamKeyboard();

  // ⌘O / Ctrl+O as a convenience accelerator. Spec doesn't mandate it for
  // this milestone, but it's expected on macOS and one event listener.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void handleOpenClick(openBtn);
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
  // Pre-v2 C5 guard (§4.4 step 0): submit is PDF-only. Keyed on the doc's
  // classification, NOT a viewer capability — an unknown extension renders in
  // the fallback PDF viewer but must not become submittable.
  if (classifyPath(docState.path) !== 'pdf') {
    flashAnchorMeta('Submit is only available for PDF documents.');
    return;
  }
  // rev-n6: from a failed/timed-out send, Cmd+Return re-slings the SAME
  // submit_id against the cached frozen submit file rather than minting a
  // fresh round (which would duplicate the round and re-open the picker).
  if (submitCanRetry()) {
    await reslingSubmit();
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
    author: AUTHOR,
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
  if (!docState.path || !docState.sha256 || !activeViewer) return false;
  // C5 guard (§4.4 step 0): bundle/submit pipeline is PDF-only. Reject if the
  // open file is not a PDF, or if any live comment carries a non-`pdf-quad`
  // anchor (the per-comment guard, keyed on the truthful union kind).
  if (classifyPath(docState.path) !== 'pdf') {
    flashAnchorMeta('Bundle export is only available for PDF documents.');
    return false;
  }
  if (docState.comments.some((c) => c.anchor.kind !== 'pdf-quad')) {
    flashAnchorMeta('Cannot export bundle: one or more comments carry non-PDF anchors.');
    return false;
  }
  // Drain the pending drafts debounce so what's on disk matches what
  // goes into the bundle JSON. Otherwise a Cmd+S 100ms after editing
  // would write a bundle with the edits but a drafts file without —
  // confusing on next reload (drafts is checked first, per §10.4).
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
    await flushDraftsWrite();
  }
  const pageCount = activeViewer.totalPages;
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
    author: AUTHOR,
  });
  if (!res.ok) {
    flashAnchorMeta(`Bundle write failed (${res.reason}): ${res.error}`);
    setSavedIndicator({ kind: 'error', detail: `${res.reason}: ${res.error}` });
    return false;
  }
  // Mirror the freshly-minted annotation ids back onto the in-memory drafts
  // so the next bundle write can preserve them (and so the JSON sidecar's IDs
  // stay aligned with the live draft). Under v2 the id lives in
  // `native.comment_id`. Persist via the debounced writer — same code path as
  // a normal edit, keeps the "Saved" semantics consistent.
  const idMap = new Map(res.annotationIds.map((x) => [x.commentId, x.pdfAnnotationId]));
  let changed = false;
  for (const c of docState.comments) {
    const next = idMap.get(c.id) ?? null;
    if ((c.native?.comment_id ?? null) !== next) {
      c.native = next ? { ...(c.native ?? {}), comment_id: next } : null;
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

/** Reviewer identity stamped on every comment the app authors and on the
 *  bundle/submit envelopes. Single source (X6) — previously the bare `'AJB'`
 *  literal was duplicated across the comment builder and the bundle/submit
 *  builders. */
const AUTHOR = 'AJB';

async function handleOpenClick(openBtn: HTMLButtonElement): Promise<void> {
  openBtn.disabled = true;
  try {
    const picked = await window.electronAPI.openPdfDialog();
    if (!picked.path) return; // user canceled — leave current state untouched
    await openDocument(picked.path);
  } finally {
    openBtn.disabled = false;
  }
}

// ─── X7 format registry ────────────────────────────────────────────────────
//
// One adapter per openable kind, keyed by classifyPath. Each factory mounts a
// fresh viewer into the document pane and wires its format-specific options:
// every format routes selection through the unified `handleSelection`; PDF also
// reports page info; markdown also wires content-change / blur / wikilink. The
// host no longer branches on format downstream — it asks the viewer's
// `capabilities` instead.
type ViewerKind = 'pdf' | 'md' | 'html' | 'docx';

const VIEWER_REGISTRY: Record<ViewerKind, (mount: HTMLElement) => FileViewer> = {
  pdf: (mount) => new PdfViewer({
    container: mount,
    onSelection: handleSelection,
    onPageInfo: ({ page, totalPages }) => {
      const h = viewerHandlesRef;
      if (!h) return;
      h.pageLabel.textContent = `${page} / ${totalPages}`;
      h.prevBtn.disabled = page <= 1;
      h.nextBtn.disabled = page >= totalPages;
    },
    onNativeAnnotations: handleNativeAnnotations,
  }),
  md: (mount) => new MarkdownViewer({
    container: mount,
    onSelection: handleSelection,
    onWikilinkClick: (target) => { resolveAndOpenWikilink(target); },
    onContentChange: () => {
      scheduleMdSave();
      syncMdAnchorsToComments();
    },
    onBlur: () => {
      if (mdSaveTimer !== null) {
        window.clearTimeout(mdSaveTimer);
        mdSaveTimer = null;
        void flushMdSave();
      }
    },
  }),
  html: (mount) => new HtmlViewer({ container: mount, onSelection: handleSelection }),
  docx: (mount) => new DocxViewer({ container: mount, onSelection: handleSelection }),
};

/** Reset all per-document session state to a clean slate for `path` (X7
 *  "DocSession reset"). This is the single, uniform reset the four cloned
 *  loaders used to hand-copy — and diverge on (e.g. the md loader forgot to
 *  dispose the docx/html viewers; each cleared only its own format's selection
 *  cache). One `docState.lastSelection` now covers every format. */
function resetDocSession(path: string): void {
  docState.path = path;
  docState.sha256 = '';
  docState.lastSelection = null;
  docState.comments = [];
  docState.rounds = new Map();
  // §10.5.1 — restore the originating rig for this doc (if recorded earlier
  // via --from). Survives app restarts (loaded from AppState on boot).
  docState.originRig = originRigPerDoc.get(path) ?? null;
  // §10.1 — reset Submit pill/banner so the previous doc's in-flight state
  // doesn't bleed onto this one.
  resetSubmit();
  lastBundleSnapshot = null;
  focusedCommentId = null;
  editingCommentId = null;
  clearInput();
  renderAllCards();
  updateAnchorMeta();
  hideRoundBanner();
  // §10.4 — the previous doc's bundle stamp doesn't belong to this one.
  setSavedIndicator({ kind: 'idle' });
  // Stop watching the previous doc's `.review-state/` (no-op when idle).
  void window.electronAPI.watchResultsStop();
}

/** §9.2 — notify the Claude / agent pane that the active doc changed. Lazy
 *  spawn on first open; debounced context line thereafter. Best-effort. */
function announceDocSwitch(path: string, pages: number, comments: number): void {
  const w = window as unknown as {
    agentViewer?: {
      notifyDocSwitch: (payload: { path: string; pages: number; comments: number }) => Promise<void>;
    };
  };
  void w.agentViewer?.notifyDocSwitch({ path, pages, comments });
}

/** The single document-load path (X7). Collapses the four cloned loaders into
 *  teardown → DocSession reset → registry-built viewer → load → anchors. Runs
 *  under the single-flight open queue: `token` is re-checked after every await
 *  so a superseding open bails this one cleanly (the rev-ra6 epoch check, now
 *  in one place instead of four hand-copied checklists). */
async function runOpen(path: string, token: number): Promise<void> {
  const h = viewerHandlesRef;
  if (!h) return;
  if (openSuperseded(token)) return;

  const kind = classifyPath(path);
  const viewerKind: ViewerKind = kind === 'other' ? 'pdf' : kind;
  const isPdf = viewerKind === 'pdf';

  h.title.textContent = `Loading ${basename(path)}…`;
  hideBanner(h.banner);

  // ── teardown of the previous document ──
  // Flush a pending .md save before its viewer is gone (uses the still-current
  // previous-doc path/sha — reset happens below).
  if (mdSaveTimer !== null) {
    window.clearTimeout(mdSaveTimer);
    mdSaveTimer = null;
    await flushMdSave();
    if (openSuperseded(token)) return;
  }
  // Flush a pending drafts write before the previous sha256 is overwritten.
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
    await flushDraftsWrite();
    if (openSuperseded(token)) return;
  }
  if (mdFileChangeUnsub) { mdFileChangeUnsub(); mdFileChangeUnsub = null; }
  void window.electronAPI.unwatchFile();
  mdSourceModified = false;
  if (activeViewer) { activeViewer.dispose(); activeViewer = null; }

  // ── DocSession reset ──
  resetDocSession(path);

  // ── read bytes (+ health, PDF only — run concurrently to hide latency) ──
  const [bytesResult, healthResult] = await Promise.all([
    window.electronAPI.readFileBytes(path),
    isPdf ? window.electronAPI.pdfHealth(path) : Promise.resolve(null),
  ]);
  if (openSuperseded(token)) return;

  // Render the health banner (PDF only) before the bytes check so a render
  // failure still has the diagnostic context visible. Non-blocking either way.
  if (healthResult) renderHealthBanner(h.banner, healthResult);

  if (!bytesResult.ok) {
    h.title.textContent = basename(path);
    showLoadError(h, bytesResult);
    setViewerControlsEnabled(h, false);
    return;
  }
  docState.sha256 = bytesResult.sha256;

  // §10.1 step 6 / §10.3 — load drafts BEFORE the results watcher so the
  // watcher's initial scan finds the comment ids its dispositions target.
  await loadDraftsForCurrentDoc();
  if (openSuperseded(token)) return;

  // Results watching is PDF-only (results come from the PDF-only Submit
  // pipeline). Failures aren't fatal — just surface them.
  if (isPdf) {
    void window.electronAPI.watchResultsStart(path, bytesResult.sha256).then((res) => {
      if (!res.ok) {
        flashAnchorMeta(`Results watcher failed (${res.reason ?? 'unknown'}): ${res.error ?? ''}`);
      }
    });
  }

  // ── construct the viewer via the registry + load ──
  const viewer = VIEWER_REGISTRY[viewerKind](h.mount);
  activeViewer = viewer;
  // Re-apply the session dark-mode preference to the fresh viewer.
  viewer.setDarkMode(darkModePref);
  h.darkBtn.setAttribute('aria-pressed', String(darkModePref));

  // Editable-text formats (md) want an external-change watch so a change on
  // disk while the user has unsaved edits prompts a reload.
  if (viewer.capabilities.editableText) {
    void window.electronAPI.watchFile(path);
    mdFileChangeUnsub = window.electronAPI.onFileChange((event) => {
      if (event.filePath !== path) return;
      if (mdSourceModified) showExternalModificationModal(path);
    });
  }

  let loaded = false;
  try {
    showViewer(h);
    await viewer.loadBytes(bytesResult.bytes, { path });
    if (openSuperseded(token)) return;
    h.title.textContent = basename(path);
    // fit/dark apply to every format (dark toggles; fit no-ops where unpaged).
    setViewerControlsEnabled(h, true);
    // Non-paged formats have no prev/next; PDF's onPageInfo manages them.
    if (!viewer.capabilities.paged) {
      h.prevBtn.disabled = true;
      h.nextBtn.disabled = true;
    }
    // Project the live comment set into the viewer (md re-tracks, html/docx
    // re-highlight, pdf no-ops). Replaces the per-format highlight helpers.
    viewer.applyAnchors(docState.comments);
    loaded = true;
  } catch (err) {
    h.title.textContent = basename(path);
    showLoadError(h, null, err);
    setViewerControlsEnabled(h, false);
  }

  // §9.2 — spawn / notify the agent pane only once the doc actually rendered
  // (the v1 PDF path's behavior; the other loaders notified even on failure).
  if (loaded) {
    announceDocSwitch(path, viewer.totalPages, docState.comments.length);
  }
  // §3.3 — persist last-opened-doc + reflect the active tree row.
  fileTree?.setActiveFile(path);
  scheduleAppStateSave();
  // Let the toolbar re-evaluate enabled state now a doc is active.
  window.dispatchEvent(new CustomEvent('toolbar:doc-state-changed'));
}

// X7: the html/docx comment-highlight derivation moved into the viewers
// (`applyAnchors` → `htmlAnchorsFromComments`), and md re-anchoring moved into
// `MarkdownViewer.applyAnchors`. The host now calls `activeViewer.applyAnchors`
// uniformly instead of the per-format helpers that used to live here.

function showExternalModificationModal(path: string): void {
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
    void openDocument(path);
  });
  document.getElementById('extModKeep')!.addEventListener('click', () => {
    overlay.remove();
  });
}

function syncMdAnchorsToComments(): void {
  if (!(activeViewer instanceof MarkdownViewer)) return;
  const mdViewer = activeViewer;
  const anchors = mdViewer.getTrackedAnchors();
  const byId = new Map(docState.comments.map((c) => [c.id, c]));
  for (const a of anchors) {
    const c = byId.get(a.commentId);
    if (!c || c.anchor.kind !== 'text-quote') continue;
    const tq = c.anchor;
    if (a.orphaned) {
      tq.char_start = -1;
      tq.char_end = -1;
    } else {
      tq.char_start = a.from;
      tq.char_end = a.to;
      const doc = mdViewer.getContent();
      if (a.from >= 0 && a.to <= doc.length) {
        // NOTE: provenance-immutable re-anchoring (relocations → anchor.relocated,
        // originals write-once) is roadmap X12; v2 introduces the field but the
        // live md tracking keeps the v1 in-place update until X12 rewires it.
        tq.quoted_text = doc.slice(a.from, a.to);
        tq.prefix = doc.slice(Math.max(0, a.from - 40), a.from);
        tq.suffix = doc.slice(a.to, Math.min(doc.length, a.to + 40));
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
        void openDocument(candidate);
      }
    });
  }
}

async function loadDraftsForCurrentDoc(): Promise<void> {
  if (!docState.path || !docState.sha256) return;
  const path = docState.path;
  const sha256 = docState.sha256;
  const cached = draftsCache.get(draftsCacheKey(path, sha256));
  if (cached) {
    console.log('[drafts] load', { path, sha256: sha256.slice(0, 12), reason: 'cache_hit', commentCount: cached.comments.length });
    docState.comments = cached.comments;
    renderAllCards();
    return;
  }
  const res = await window.electronAPI.readDrafts(path);
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
  if (res.file) draftsCache.set(draftsCacheKey(path, sha256), res.file);
  renderAllCards();
}

function showViewer(h: ViewerHandles): void {
  h.empty.hidden = true;
  h.mount.hidden = false;
}

function showLoadError(h: ViewerHandles, r: ReadFileBytesResult | null, err?: unknown): void {
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
  // Switching INTO Redraft with a live selection → populate the input with the
  // selected text as the editing starter (§4.3). Switching OUT of Redraft
  // leaves whatever is in the input alone — the user owns the buffer.
  if (next === 'redraft' && previous !== 'redraft' && docState.lastSelection) {
    const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
    if (input) {
      input.value = docState.lastSelection.text;
      input.focus();
      input.select();
    }
  }
}

/** Unified selection callback wired into every viewer (X7). Caches the
 *  selection so it's available at submit time and updates the anchor-status
 *  meta line. `null` clears the cached selection (the text viewers emit it on
 *  collapse; PDF simply never emits it). */
function handleSelection(sel: ViewerSelection | null): void {
  docState.lastSelection = sel;
  updateAnchorMeta();
  if (!sel) return;
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  if (!input) return;
  // §4.3: a fresh selection while Redraft is active populates the input as the
  // editing starter (v1 did this for PDF + md; X7 extends it to html/docx).
  if (activeTool === 'redraft') {
    input.value = sel.text;
    input.focus();
    input.select();
    return;
  }
  // §4.3 for Comment/Surface: "input gets focus; user types comment; Enter
  // submits." Skip this for editable-text viewers (md) — stealing focus mid
  // selection would yank the caret out of the editor (the v1 md behavior).
  if (!activeViewer?.capabilities.editableText) input.focus();
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
    // No-selection wording stays format-aware: the PDF copy names the PDF, and
    // an empty pane (no path) reads as the PDF empty-state (the v1 default).
    const isText = classifyPath(docState.path) !== 'pdf' && docState.path !== '';
    meta.textContent = docState.path
      ? (isText
          ? 'No selection — highlight text to anchor a comment.'
          : 'No selection — highlight text in the PDF to anchor a comment.')
      : 'No PDF loaded.';
    meta.classList.remove('has-selection');
    return;
  }
  const snippet = truncate(sel.text, 60);
  switch (sel.kind) {
    case 'text-quote':
      meta.textContent = `chars ${sel.from}–${sel.to} · “${snippet}”`;
      break;
    case 'html-selector-hint':
      meta.textContent = `${sel.selector.slice(-30)} · “${snippet}”`;
      break;
    case 'pdf-quad': {
      const r = sel.region;
      meta.textContent = `p.${sel.page} · ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)} · “${snippet}”`;
      break;
    }
  }
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

  const sel = docState.lastSelection;
  if (!sel) {
    flashAnchorMeta('Select text first to anchor this comment.');
    return;
  }
  commitNewComment(buildPayload(buf, anchorFromSelection(sel), sel.text));
}

/** Lift a viewer-native selection into the discriminated anchor union (§3.1).
 *  The one place selection kinds map to anchor kinds — from here on `buildPayload`
 *  and the reveal/label paths speak the union, never the selection. */
function anchorFromSelection(sel: ViewerSelection): Anchor {
  switch (sel.kind) {
    case 'pdf-quad':
      return { kind: 'pdf-quad', page: sel.page, region: sel.region };
    case 'text-quote': {
      // ONE text-quote builder for every text format (§3.1 rule 3): MD folds in
      // verbatim, and HTML/DOCX now anchor by text-quote over the iframe's linear
      // text (rev-l6, §5.5). The `from`/`to` offsets are in the active viewer's
      // own coordinate space; `getContent()` returns that same text.
      const doc =
        activeViewer instanceof MarkdownViewer || activeViewer instanceof IframeDocViewer
          ? activeViewer.getContent()
          : '';
      return { ...createMdAnchor(doc, sel.from, sel.to), relocated: null };
    }
    case 'html-selector-hint':
      // Legacy locality-hint anchor (§5.5): retained for migrated v1 rows. The
      // iframe viewers no longer EMIT this kind — capture is text-quote now — but
      // the union member stays valid so existing comments keep resolving.
      return {
        kind: 'html-selector-hint',
        selector: sel.selector,
        char_offset: sel.charOffset,
        char_length: sel.charLength,
        quoted_text: sel.text,
      };
  }
}

/** Build a v2 comment from the input buffer + an anchor union (X6). ONE builder
 *  for every format — the three near-identical buildPdf/buildMd/buildHtml
 *  builders collapsed here; the per-kind work now lives in `anchorFromSelection`.
 *  `highlightedText` is passed separately because a pdf-quad anchor carries no
 *  text of its own (the region is geometric); the other kinds duplicate it in
 *  `quoted_text` but we keep one source for the card quote. */
function buildPayload(buf: string, anchor: Anchor, highlightedText: string): CommentPayload {
  // Tool ↔ engagement_level / field mapping (§11.1):
  //   Comment / Surface → buffer is the comment text; redraft is null.
  //   Redraft           → buffer is the edited replacement text; comment is "".
  const isRedraft = activeTool === 'redraft';
  return {
    id: crypto.randomUUID(),
    doc_id: docState.path,
    doc_version: docState.sha256,
    anchor,
    highlighted_text: highlightedText,
    comment: isRedraft ? '' : buf,
    redraft: isRedraft ? buf : null,
    redraft_suggestion: null,
    engagement_level: activeTool,
    author: AUTHOR,
    kind: 'comment',
    status: 'open',
    created_at: new Date().toISOString(),
    origin: 'app-draft',
  };
}

/** The shared tail for adding a freshly-authored comment (X6): prepend it to the
 *  live set, re-render the stream, schedule the drafts write, re-project anchors
 *  into the viewer, and reset the composer. Re-projection subsumes the old
 *  per-format post-submit calls (reanchorMdComments / apply{Html,Docx}
 *  CommentHighlights) — md re-tracks (incl. the new comment), html/docx
 *  re-highlight, pdf no-ops. */
function commitNewComment(payload: CommentPayload): void {
  docState.comments.unshift(payload);
  renderAllCards();
  scheduleDraftsWrite();
  activeViewer?.applyAnchors(docState.comments);
  clearInput();
  const input = document.getElementById('commentInput') as HTMLTextAreaElement | null;
  input?.focus();
}

/** L3 round-trip READ half: fold a page's native PDF annotations into the live
 *  comment stream as `native-pdf` cards. Fired per page render (incl. zoom /
 *  revisit), so we dedupe by `native.comment_id` — only genuinely new annots get
 *  added (PDF.js ref-based ids are deterministic for a given file, so the dedupe
 *  also holds across reloads once the cards persist to drafts). When at least one
 *  is added we re-render the stream, persist, and re-project anchors. The bundle
 *  writer skips `native-pdf` origins, so these never re-emit as duplicate
 *  annotations on the next bundle write (§3.2 provenance). */
function handleNativeAnnotations(annots: NativePdfAnnotation[]): void {
  if (annots.length === 0) return;
  const seen = new Set(
    docState.comments
      .map((c) => c.native?.comment_id)
      .filter((id): id is string => !!id),
  );
  let added = 0;
  for (const a of annots) {
    if (seen.has(a.native.comment_id)) continue;
    seen.add(a.native.comment_id);
    docState.comments.push(buildNativeComment(a));
    added += 1;
  }
  if (added === 0) return;
  renderAllCards();
  // Deliberately NOT persisted to the drafts sidecar: native annotations are
  // re-derived from the PDF on every open (getAnnotations in renderPage), so the
  // PDF stays their single source of truth and merely *viewing* an annotated PDF
  // never silently writes a `.review-state/drafts/` file. `flushDraftsWrite`
  // filters `native-pdf` out too, so an app-authored write won't carry them.
  // They DO ride along in an explicit bundle/submit (the frozen deliverable).
  activeViewer?.applyAnchors(docState.comments);
}

/** Build a v2 `native-pdf` comment from a normalized native annotation (L3).
 *  The annotation /Contents becomes the card body; `highlighted_text` is left
 *  empty — PDF.js doesn't return the glyphs under a markup annot, and a
 *  text-layer hit-test is a later enrichment (filed separately). Engagement
 *  level is `comment`: a native highlight/note is a plain remark, not an app
 *  L2/L3 action. `created_at` stays ISO for schema consistency; the PDF's own
 *  /CreationDate is preserved in `native.created`. */
function buildNativeComment(a: NativePdfAnnotation): CommentPayload {
  return {
    id: crypto.randomUUID(),
    doc_id: docState.path,
    doc_version: docState.sha256,
    anchor: {
      kind: 'pdf-quad',
      page: a.page,
      region: a.region,
      ...(a.quads ? { quads: a.quads } : {}),
    },
    highlighted_text: '',
    comment: a.contents,
    redraft: null,
    redraft_suggestion: null,
    engagement_level: 'comment',
    author: a.native.author ?? 'native',
    kind: 'comment',
    status: 'open',
    created_at: new Date().toISOString(),
    origin: 'native-pdf',
    native: a.native,
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
      if (!c || !activeViewer) return;
      e.preventDefault();
      revealComment(c);
    }
  });
}

/** The anchor a card points at: the rig-relocated `new_anchor` when present
 *  (that's where the applied text now lives), else the original capture. Single
 *  source (X6) for the card's reveal target, location label, and ARIA phrase.
 *  The original `anchor` is kept on the comment for audit even when superseded. */
function effectiveAnchor(c: CommentPayload): Anchor {
  return c.new_anchor ?? c.anchor;
}

/** Reveal a comment in the active viewer via its effective anchor. Shared by the
 *  card click handler and the stream's Enter binding (X6) so click and keyboard
 *  resolve to the exact same target. */
function revealComment(c: CommentPayload): void {
  revealCommentAnchor(effectiveAnchor(c));
}

/** Route a reveal to the active viewer, which handles its own anchor kind (X6
 *  polymorphic reveal): PDF navigates to page + region, md scrolls + selects the
 *  text-quote range, html/docx scroll the selector into view. */
function revealCommentAnchor(a: Anchor): void {
  activeViewer?.reveal(a);
}

/** Short, per-kind card location label (X6 honest cards): page + region for
 *  pdf-quad, char-range for text-quote, trailing selector for html-selector-hint.
 *  Replaces the v1 "p.1 · 0,0 0×0" that rendered for 3 of 4 formats (C5/C6). */
function anchorLabel(a: Anchor): string {
  if (a.kind === 'pdf-quad') {
    const r = a.region;
    return `· p.${a.page} · ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
  }
  if (a.kind === 'text-quote') return `· chars ${a.char_start}–${a.char_end}`;
  return `· ${a.selector.slice(-30)}`;
}

/** ARIA location phrase for a comment card. */
function anchorAriaLocation(a: Anchor): string {
  if (a.kind === 'pdf-quad') return `page ${a.page}`;
  if (a.kind === 'text-quote') return `chars ${a.char_start}–${a.char_end}`;
  return a.selector.slice(-30);
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
  const revealAnchor = effectiveAnchor(c);
  card.setAttribute('aria-label', `${labelFor(c.engagement_level)} on ${anchorAriaLocation(revealAnchor)}`);
  card.addEventListener('focus', () => { focusedCommentId = c.id; });
  card.addEventListener('click', () => {
    revealComment(c);
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
  anchor.textContent = anchorLabel(revealAnchor);
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
  // Belt-and-suspenders: skip .abandoned.json tombstones. Primary filter is
  // isResultsName() in results-watcher.ts; this guard catches any edge case
  // where the event escapes that layer (e.g., a future code path change).
  if (event.filePath.endsWith('.abandoned.json')) return;
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
      // §10.1 step 6 / rev-n6 — Resume re-slings the existing submit file
      // (same submit_id) so the rig continues from the partial results file
      // per its resume guard. This wires to the SAME entry as the Retry /
      // Re-sling banner buttons (submit module's `resling()`), which re-sends
      // the cached frozen submit file — no re-promote, no picker, no
      // duplicate round. If the cached round was lost (e.g. an app restart
      // since the sling), `resling()` returns false and falls back to a hint
      // directing a fresh Cmd+Return — disk-rehydrated resume after restart
      // is tracked separately (rev-n6 follow-up).
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'is-primary';
      resume.textContent = 'Resume round';
      resume.title = 'Re-sling the existing submit file to the rig (same submit_id).';
      resume.disabled = !submitCanResume();
      resume.addEventListener('click', () => { void reslingSubmit(); });
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
        // rendered, so openDocument reads the freshly-seeded draft file when
        // it opens the new doc.
        void openDocument(r.new_source_path!);
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
 *  Thin renderer wrapper: the seeding logic (re-raise policy §8.5 + the N2
 *  read-before-write idempotency guard) lives in `./seed-next-draft` as a
 *  pure, injectable unit so it can be tested rig-free. Here we supply the
 *  live I/O (`window.electronAPI` + crypto + clock) and apply the renderer
 *  side effects the outcome calls for. */
async function seedNextVersionDraft(event: ResultsEvent): Promise<void> {
  const outcome = await seedNextVersionDraftPure(event, {
    readFileBytes: (p) => window.electronAPI.readFileBytes(p),
    readDrafts: (p) => window.electronAPI.readDrafts(p),
    writeDrafts: (p, file) => window.electronAPI.writeDrafts(p, file),
    randomUUID: () => crypto.randomUUID(),
    nowIso: () => new Date().toISOString(),
  });
  switch (outcome.kind) {
    case 'error':
      flashAnchorMeta(outcome.message);
      return;
    case 'seeded':
    case 'skipped-existing': {
      // Mark the round seeded so further re-emits in this session skip the
      // redundant read/write. (Across sessions the on-disk guard handles it.)
      const round = docState.rounds.get(event.results.submit_id);
      if (round) round.seeded = true;
      return;
    }
    case 'noop':
      return;
  }
}

void init();
