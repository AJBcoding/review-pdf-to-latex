// §9.2 embedded Claude pane — renderer side.
//
// Wires an xterm.js terminal to the main-process pty manager (claude-pty.ts).
// One conversational pty per app instance, lazy-spawned on first PDF open.
//
// rev-1md.3 layers worker ptys on top: each Create Context / Sling spawn
// gets its own xterm.js terminal, its own tab (up to 3) and a γ panel row.
// Sling workers go straight to γ. Fresh Start kills+respawns the
// conversational pty with a handoff priming line.
//
// Lifecycle in this module:
//   - mount(): grab DOM refs, attach pty IPC listeners, install resize obs.
//             Terminal itself isn't constructed yet (lazy).
//   - ensureSpawned(docPath): on first PDF open, construct xterm.js Terminal +
//             addons + open() it; tell main to spawn the pty with the right
//             cwd. Subsequent calls are no-ops.
//   - notifyDocSwitch(docPath, pages, comments): debounced 500ms — writes the
//             '[Now viewing: …]' line into the pty's stdin so the conversation
//             knows context changed (§9.2.4). Suppressed on initial spawn.
//   - spawnWorker(params): rev-1md.3 — Create Context / Sling worker spawn.
//   - freshStart(handoff): rev-1md.3 — kill + respawn conv pty with handoff.
//   - dispose(): tear down on app unload.

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type {
  CreateContextMode,
  PtyDataEvent,
  PtyExitEvent,
  ReviewerProbe,
  ToolbarContextBundle,
  WorkerDataEvent,
  WorkerExitEvent,
  WorkerKind,
  WorkerProgressEvent,
  WorkerProgressMarker,
  WorkerStartResult,
} from '@shared/pty';
import { MAX_WORKER_TABS } from '@shared/pty';

// CSS for xterm.js — must be imported so the styling rules are bundled. The
// xterm package ships its CSS alongside its dist; without this import the
// cursor box and selection rendering are broken.
import '@xterm/xterm/css/xterm.css';

const DOC_SWITCH_DEBOUNCE_MS = 500;

interface DOMRefs {
  empty: HTMLElement;
  term: HTMLElement;
  error: HTMLElement;
  identity: HTMLElement;
  body: HTMLElement;
  tabs: HTMLElement;
  progressStrip: HTMLElement;
  tasksToggle: HTMLButtonElement;
  tasksCount: HTMLElement;
  tasksPanel: HTMLElement;
  tasksList: HTMLElement;
  tasksEmpty: HTMLElement;
  tasksClose: HTMLButtonElement;
}

interface ClaudePaneState {
  refs: DOMRefs | null;
  terminal: Terminal | null;
  fit: FitAddon | null;
  /** Set when the renderer has called startPty and main confirmed the spawn.
   *  Subsequent ensureSpawned calls become no-ops. */
  spawned: boolean;
  /** True once the very first doc-switch notification (= the spawn's own
   *  docPath) has been *suppressed* per §9.2.4. Subsequent switches fire. */
  suppressedFirstSwitch: boolean;
  /** Current generation reported by main. We ignore stale data/exit events
   *  that arrive with a lower generation (kill+respawn race). */
  ptyGeneration: number;
  reviewer: ReviewerProbe | null;
  /** Pending doc-switch payload — coalesced inside the 500ms window so a
   *  burst of clicks emits one line. */
  pendingDocSwitch:
    | { path: string; pages: number; comments: number }
    | null;
  docSwitchTimer: number | null;
  /** Unsubscribe handles for the IPC listeners. */
  unsubData: (() => void) | null;
  unsubExit: (() => void) | null;
  unsubWorkerData: (() => void) | null;
  unsubWorkerExit: (() => void) | null;
  unsubWorkerProgress: (() => void) | null;
  resizeObs: ResizeObserver | null;
  /** Theme this pane was constructed under. Re-render the terminal if the
   *  app theme changes (no v1 trigger — but cheap to track). */
  themeMode: 'dark' | 'light';
  /** rev-1md.3 — every worker we've ever spawned, including dropped/exited
   *  ones. γ panel reads from this map; the tabs render the subset whose
   *  `hasTab` is true. */
  workers: Map<string, WorkerEntry>;
  /** Currently visible tab ('assistant' or workerId). */
  activeTab: string;
  /** Monotonically increasing label index for worker tabs (Worker 1, 2…). */
  workerLabelSeq: number;
}

/** Per-worker state. Includes the xterm.js Terminal (created on first
 *  visibility) plus the latest progress marker. Killed workers retain their
 *  entry in γ for retry/log access. */
interface WorkerEntry {
  workerId: string;
  kind: WorkerKind;
  /** User-visible label ("Worker 3" / short kind hint). */
  label: string;
  /** First non-empty line of the user's prompt — drives the γ row summary. */
  summaryHint: string;
  /** Bundle + prompt + mode/destination retained for retry. */
  retry: WorkerRetryState;
  /** Whether this worker currently occupies a tab. False = γ-only. */
  hasTab: boolean;
  tabEl: HTMLButtonElement | null;
  termEl: HTMLDivElement | null;
  terminal: Terminal | null;
  fit: FitAddon | null;
  /** Latest progress marker for the β strip + γ row. */
  lastMarker: WorkerProgressMarker | null;
  /** Lifecycle state. 'running' from spawn ack; flips to done/failed/killed
   *  on exit or marker. */
  state: 'running' | 'done' | 'failed' | 'killed';
  exitCode: number | null;
  exitSignal: number | null;
  startedAt: Date;
  /** Strip-fade clock. Set when the worker transitions out of 'running'.
   *  The strip drops the row when Date.now() > stripUntil. */
  stripUntil: number;
  /** Raw stdout buffer for γ-only workers whose tab hasn't been opened yet.
   *  Replayed into xterm.js on promotion. Capped at SCROLLBACK_BUFFER_CAP
   *  to avoid unbounded memory growth on chatty workers. */
  bufferedOutput: string;
}

interface WorkerRetryState {
  kind: WorkerKind;
  bundle: ToolbarContextBundle;
  mode?: CreateContextMode;
  destination?: string;
  docSourceDir: string;
}

const state: ClaudePaneState = {
  refs: null,
  terminal: null,
  fit: null,
  spawned: false,
  suppressedFirstSwitch: false,
  ptyGeneration: 0,
  reviewer: null,
  pendingDocSwitch: null,
  docSwitchTimer: null,
  unsubData: null,
  unsubExit: null,
  unsubWorkerData: null,
  unsubWorkerExit: null,
  unsubWorkerProgress: null,
  resizeObs: null,
  themeMode: 'dark',
  workers: new Map(),
  activeTab: 'assistant',
  workerLabelSeq: 0,
};

// ─── Theme palettes ───────────────────────────────────────────────────────

const DARK_THEME: ITheme = {
  background: '#0e0e0e',
  foreground: '#e6e6e6',
  cursor: '#4a9eff',
  cursorAccent: '#0e0e0e',
  selectionBackground: 'rgba(74, 158, 255, 0.35)',
  black: '#1a1a1a',
  red: '#ff6b6b',
  green: '#7ee787',
  yellow: '#f0c674',
  blue: '#4a9eff',
  magenta: '#c084fc',
  cyan: '#56b6c2',
  white: '#e6e6e6',
  brightBlack: '#444',
  brightRed: '#ff8787',
  brightGreen: '#a3e8a8',
  brightYellow: '#ffd687',
  brightBlue: '#6fb1ff',
  brightMagenta: '#d4a2ff',
  brightCyan: '#7fd0db',
  brightWhite: '#ffffff',
};

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#4a9eff',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(74, 158, 255, 0.25)',
  black: '#1a1a1a',
  red: '#d73a49',
  green: '#22863a',
  yellow: '#b08800',
  blue: '#1f6feb',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#444',
  brightBlack: '#666',
  brightRed: '#cb2431',
  brightGreen: '#28a745',
  brightYellow: '#d49b00',
  brightBlue: '#0366d6',
  brightMagenta: '#6f42c1',
  brightCyan: '#005cc5',
  brightWhite: '#000',
};

function themeForMode(mode: 'dark' | 'light'): ITheme {
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME;
}

// ─── Mounting ─────────────────────────────────────────────────────────────

export interface MountOptions {
  empty: HTMLElement;
  term: HTMLElement;
  error: HTMLElement;
  identity: HTMLElement;
  body: HTMLElement;
  tabs: HTMLElement;
  progressStrip: HTMLElement;
  tasksToggle: HTMLButtonElement;
  tasksCount: HTMLElement;
  tasksPanel: HTMLElement;
  tasksList: HTMLElement;
  tasksEmpty: HTMLElement;
  tasksClose: HTMLButtonElement;
  /** Current app theme mode (matches dark/light per §9.2.9). */
  themeMode: 'dark' | 'light';
}

export function mount(opts: MountOptions): void {
  state.refs = {
    empty: opts.empty,
    term: opts.term,
    error: opts.error,
    identity: opts.identity,
    body: opts.body,
    tabs: opts.tabs,
    progressStrip: opts.progressStrip,
    tasksToggle: opts.tasksToggle,
    tasksCount: opts.tasksCount,
    tasksPanel: opts.tasksPanel,
    tasksList: opts.tasksList,
    tasksEmpty: opts.tasksEmpty,
    tasksClose: opts.tasksClose,
  };
  state.themeMode = opts.themeMode;

  // Wire main → renderer streams up front so anything emitted during spawn
  // (the priming command echo, claude's banner) reaches xterm.js once we
  // construct it. If the data races the construction we buffer it inline
  // and flush after open().
  state.unsubData = window.electronAPI.onPtyData(onPtyData);
  state.unsubExit = window.electronAPI.onPtyExit(onPtyExit);
  state.unsubWorkerData = window.electronAPI.onWorkerPtyData(onWorkerData);
  state.unsubWorkerExit = window.electronAPI.onWorkerPtyExit(onWorkerExit);
  state.unsubWorkerProgress = window.electronAPI.onWorkerPtyProgress(onWorkerProgress);

  // Assistant tab is built into the HTML — wire its click to focus.
  const assistantTab = state.refs.tabs.querySelector<HTMLButtonElement>('#claudeTabAssistant');
  if (assistantTab) {
    assistantTab.addEventListener('click', () => setActiveTab('assistant'));
  }

  // γ tasks panel toggle + close.
  state.refs.tasksToggle.addEventListener('click', () => toggleTasksPanel());
  state.refs.tasksClose.addEventListener('click', () => setTasksPanelOpen(false));

  // Probe gas-town up front so the Sling button (rev-1md.3) can render with
  // the right initial state and the identity label shows immediately if
  // present. Best-effort; failure leaves the label hidden.
  window.electronAPI
    .probeReviewer()
    .then((p) => {
      state.reviewer = p;
      renderIdentity();
      window.dispatchEvent(new CustomEvent('claude-pane:reviewer-probed', { detail: p }));
    })
    .catch(() => {});
}

/** Replace the empty state with the terminal mount + initialize xterm.js. */
function openTerminal(): Terminal {
  if (state.terminal) return state.terminal;
  if (!state.refs) throw new Error('claude-pane: openTerminal before mount');

  const term = makeTerminal();

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  state.refs.empty.hidden = true;
  state.refs.term.hidden = false;
  term.open(state.refs.term);
  fit.fit();

  // Pipe keystrokes back to main. xterm.js emits chunks as the OS sends them
  // (one keystroke or one paste); we forward verbatim.
  term.onData((data) => {
    window.electronAPI.sendPtyInput(data);
  });

  // Resize the pty whenever xterm.js's geometry changes. Triggered by fit()
  // calls as the right-drawer column changes width.
  term.onResize(({ cols, rows }) => {
    window.electronAPI.resizePty(cols, rows);
  });

  // Watch the pane's body for size changes. Debouncing is unnecessary — the
  // resize observer already coalesces consecutive layout updates within a
  // frame, and xterm.js's fit() is cheap.
  const resizeObs = new ResizeObserver(() => {
    // Guard: if the pane is collapsed (zero-size), skip the fit — fitting
    // to zero crashes the renderer.
    if (state.refs && state.refs.term.offsetWidth > 0 && state.refs.term.offsetHeight > 0) {
      try { fit.fit(); } catch { /* fit on a hidden terminal — ignore */ }
    }
    // Also re-fit any worker terminals whose tabs are active.
    for (const w of state.workers.values()) {
      if (w.hasTab && state.activeTab === w.workerId && w.fit && w.termEl &&
          w.termEl.offsetWidth > 0 && w.termEl.offsetHeight > 0) {
        try { w.fit.fit(); } catch { /* ignore */ }
      }
    }
  });
  resizeObs.observe(state.refs.body);

  state.terminal = term;
  state.fit = fit;
  state.resizeObs = resizeObs;

  return term;
}

function makeTerminal(): Terminal {
  return new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 5000,
    theme: themeForMode(state.themeMode),
    allowTransparency: false,
    macOptionIsMeta: true,
  });
}

// ─── Pty lifecycle ────────────────────────────────────────────────────────

/** First PDF open triggers the spawn (§9.2.2 lazy). Subsequent calls are
 *  no-ops — the conversational pty persists across doc switches. Returns
 *  whether the spawn was newly triggered (so the caller can suppress the
 *  doc-switch notification per §9.2.4). */
export async function ensureSpawned(opts: {
  docSourceDir: string;
}): Promise<{ spawned: 'new' | 'already' | 'failed'; reason?: string }> {
  if (!state.refs) return { spawned: 'failed', reason: 'not_mounted' };
  if (state.spawned) return { spawned: 'already' };

  const term = openTerminal();

  const result = await window.electronAPI.startPty({
    docSourceDir: opts.docSourceDir,
    cols: term.cols,
    rows: term.rows,
  });

  if (!result.ok) {
    showError(formatStartError(result));
    return { spawned: 'failed', reason: result.reason };
  }

  // Hide any earlier error state.
  if (state.refs.error) state.refs.error.hidden = true;

  state.spawned = true;
  state.suppressedFirstSwitch = false; // we'll suppress the *next* doc-switch
  state.reviewer = result.reviewer;
  state.ptyGeneration += 1;
  renderIdentity();

  // already_running means a previous PDF open already spawned the pty; we
  // shouldn't suppress further notifications in that case.
  if (result.already_running) state.suppressedFirstSwitch = true;

  // Broadcast a state change so the toolbar can flip its buttons enabled.
  window.dispatchEvent(new CustomEvent('claude-pane:spawn-state-changed'));

  // rev-gkl: write a local-only marker so the user sees the priming even if
  // claude's startup screen-clear races the slash-command echo. This goes
  // directly to xterm (not through the pty), so it's purely visual.
  if (!result.already_running && state.terminal) {
    setTimeout(() => {
      state.terminal?.write('\r\n\x1b[90m[skill: /review-pdf-to-latex activated]\x1b[0m\r\n');
    }, 2000);
  }

  return { spawned: result.already_running ? 'already' : 'new' };
}

function onPtyData(ev: PtyDataEvent): void {
  // Ignore stale data from a previous generation (kill+respawn race).
  if (ev.generation < state.ptyGeneration) return;
  state.ptyGeneration = ev.generation;
  if (state.terminal) {
    state.terminal.write(ev.data);
  } else {
    // We don't usually reach here — mount() subscribes before startPty —
    // but if we do, drop a console hint rather than silently lose data.
    console.warn('[claude-pane] data before terminal ready', ev.data.length, 'chars');
  }
}

function onPtyExit(ev: PtyExitEvent): void {
  if (ev.generation < state.ptyGeneration) return;
  state.spawned = false;
  // Show the §9.2.2 spontaneous-crash UI. The user clicks [Restart] which
  // calls ensureSpawned again with the current PDF's source dir.
  showError(
    `Claude session ended${ev.exitCode !== 0 ? ` (exit ${ev.exitCode})` : ''}.`,
    { offerRestart: true },
  );
  window.dispatchEvent(new CustomEvent('claude-pane:spawn-state-changed'));
}

// ─── Doc-switch line (§9.2.4) ─────────────────────────────────────────────

/** Inform the conversational pty that the user pivoted to a different doc.
 *  Debounced 500ms — rapid tree navigation emits one line at end. The first
 *  call after a fresh spawn is suppressed because the priming message
 *  already established context. */
export function notifyDocSwitch(payload: {
  path: string;
  pages: number;
  comments: number;
}): void {
  if (!state.spawned) return;
  if (!state.suppressedFirstSwitch) {
    state.suppressedFirstSwitch = true;
    return;
  }

  state.pendingDocSwitch = payload;
  if (state.docSwitchTimer !== null) window.clearTimeout(state.docSwitchTimer);
  state.docSwitchTimer = window.setTimeout(() => {
    state.docSwitchTimer = null;
    const p = state.pendingDocSwitch;
    state.pendingDocSwitch = null;
    if (!p) return;
    const base = basenameOf(p.path);
    const ext = base.toLowerCase().split('.').pop() ?? '';
    const verb = (ext === 'md' || ext === 'markdown') ? 'editing' : 'reviewing';
    const unit = p.pages === 1 && (ext === 'md' || ext === 'markdown') ? 'file' : `${p.pages} pages`;
    const line = `[Now ${verb}: ${base} — ${p.path} (${unit}, ${p.comments} comments)]`;
    // Trailing \r so claude treats it as a complete input line. Newline is
    // sufficient — claude reads stdin as line-buffered.
    window.electronAPI.sendPtyInput(`${line}\r`);
  }, DOC_SWITCH_DEBOUNCE_MS);
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// ─── Identity label / error UI ────────────────────────────────────────────

function renderIdentity(): void {
  if (!state.refs) return;
  const el = state.refs.identity;
  if (state.reviewer && state.reviewer.enabled && state.reviewer.identity) {
    el.textContent = state.reviewer.identity;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function showError(message: string, opts: { offerRestart?: boolean } = {}): void {
  if (!state.refs) return;
  const el = state.refs.error;
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (opts.offerRestart) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rd-claude-restart';
    btn.textContent = 'Restart';
    btn.addEventListener('click', () => {
      // The current pty's spawn cwd is preserved in main; we re-request the
      // start with the same dir. We don't have it cached on the renderer
      // side after an exit, so we fall back to the PDF's dir (caller passes
      // it via ensureSpawned). If the user hasn't opened a PDF since the
      // exit, the renderer's docState.path drives the next call from
      // index.ts — for our purpose here, dispatch a custom event so the
      // host can react.
      const ev = new CustomEvent('claude-pane:restart-requested');
      window.dispatchEvent(ev);
    });
    el.appendChild(document.createTextNode(' '));
    el.appendChild(btn);
  }
  el.hidden = false;
}

function formatStartError(result: { reason: string; error?: string }): string {
  switch (result.reason) {
    case 'claude_not_found':
      return 'Claude CLI not found on PATH. Install with: npm i -g @anthropic-ai/claude-code';
    case 'spawn_failed':
      return `Failed to start Claude: ${result.error ?? 'unknown error'}`;
    case 'no_window':
      return 'Internal error: no window for pty start.';
    default:
      return `Failed to start Claude (${result.reason}).`;
  }
}

// ─── §9.2.6 Fresh Start ──────────────────────────────────────────────────

/** Kill the conv pty + respawn with a handoff priming message. Renderer-side
 *  bookkeeping: we keep the terminal DOM, just rebump the generation and
 *  let the new pty's data stream paint into the same xterm. */
export async function freshStart(opts: {
  handoffNotes: string;
  docSourceDir: string;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!state.refs) return { ok: false, reason: 'not_mounted' };
  // The terminal may not exist yet if Fresh Start is invoked before any PDF
  // has been opened. In that case spawn is functionally identical to
  // ensureSpawned, so route there.
  if (!state.terminal) {
    const r = await ensureSpawned({ docSourceDir: opts.docSourceDir });
    return { ok: r.spawned !== 'failed', reason: r.reason };
  }
  // Clear scrollback so the new session reads as a fresh start, not a
  // continuation.
  state.terminal.clear();
  state.terminal.write('\r\n[Fresh Start — respawning conversational pty…]\r\n');
  const res = await window.electronAPI.freshStartPty({
    handoffNotes: opts.handoffNotes,
    docSourceDir: opts.docSourceDir,
    cols: state.terminal.cols,
    rows: state.terminal.rows,
  });
  if (!res.ok) {
    showError(formatStartError(res));
    return { ok: false, reason: res.reason };
  }
  state.spawned = true;
  state.suppressedFirstSwitch = true; // we just primed it; first doc-switch is implicit
  state.reviewer = res.reviewer;
  state.ptyGeneration += 1;
  renderIdentity();
  if (state.refs.error) state.refs.error.hidden = true;
  window.dispatchEvent(new CustomEvent('claude-pane:spawn-state-changed'));
  return { ok: true };
}

// ─── §9.2.6 worker ptys ──────────────────────────────────────────────────

export interface WorkerSpawnInput {
  kind: WorkerKind;
  docSourceDir: string;
  bundle: ToolbarContextBundle;
  mode?: CreateContextMode;
  destination?: string;
  subjectPrefix?: string;
}

export async function spawnWorker(input: WorkerSpawnInput): Promise<WorkerStartResult> {
  if (!state.refs) {
    return { ok: false, reason: 'spawn_failed', error: 'pane not mounted' };
  }
  // Tab capacity: Sling always goes γ-only. Create Context gets a tab when
  // < MAX_WORKER_TABS workers currently hold tabs.
  const tabCount = countTabs();
  const wantsTab = input.kind === 'create-context' && tabCount < MAX_WORKER_TABS;

  // Initial size: match the conv terminal so the priming output fits.
  const cols = state.terminal?.cols ?? 100;
  const rows = state.terminal?.rows ?? 24;

  const res = await window.electronAPI.startWorkerPty({
    kind: input.kind,
    docSourceDir: input.docSourceDir,
    cols, rows,
    bundle: input.bundle,
    mode: input.mode,
    destination: input.destination,
    subjectPrefix: input.subjectPrefix,
  });
  if (!res.ok) return res;

  state.workerLabelSeq += 1;
  const seq = state.workerLabelSeq;
  const summaryHint = (input.bundle.userPrompt.trim().split('\n')[0] || `(${input.kind})`).slice(0, 80);
  const entry: WorkerEntry = {
    workerId: res.workerId,
    kind: input.kind,
    label: `${input.kind === 'sling' ? '🪃' : '✨'} ${seq}`,
    summaryHint,
    retry: {
      kind: input.kind,
      bundle: input.bundle,
      mode: input.mode,
      destination: input.destination,
      docSourceDir: input.docSourceDir,
    },
    hasTab: wantsTab,
    tabEl: null,
    termEl: null,
    terminal: null,
    fit: null,
    lastMarker: null,
    state: 'running',
    exitCode: null,
    exitSignal: null,
    startedAt: new Date(),
    stripUntil: Number.POSITIVE_INFINITY,
    bufferedOutput: '',
  };
  state.workers.set(res.workerId, entry);

  if (wantsTab) {
    mountWorkerTab(entry);
    setActiveTab(entry.workerId);
  }
  renderProgressStrip();
  renderTasksPanel();
  updateTasksToggle();
  return res;
}

function countTabs(): number {
  let n = 0;
  for (const w of state.workers.values()) {
    if (w.hasTab && w.state === 'running') n += 1;
  }
  return n;
}

function mountWorkerTab(entry: WorkerEntry): void {
  if (!state.refs) return;
  // Tab button.
  const tab = document.createElement('button');
  tab.className = 'rd-claude-tab';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.dataset.ptyKind = 'worker';
  tab.dataset.workerId = entry.workerId;
  tab.title = entry.summaryHint;
  const label = document.createElement('span');
  label.className = 'rd-claude-tab-label';
  label.textContent = entry.label;
  tab.appendChild(label);
  const close = document.createElement('button');
  close.className = 'rd-claude-tab-close';
  close.type = 'button';
  close.setAttribute('aria-label', `Close worker ${entry.label}`);
  close.textContent = '×';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    void killWorker(entry.workerId);
  });
  tab.appendChild(close);
  tab.addEventListener('click', () => setActiveTab(entry.workerId));
  state.refs.tabs.appendChild(tab);
  entry.tabEl = tab;

  // Terminal mount div as a sibling of the conv terminal. Reuse the
  // existing one on re-promotion so the xterm.js instance (if already
  // created) stays attached to a live DOM node.
  if (!entry.termEl) {
    const termEl = document.createElement('div');
    termEl.className = 'rd-claude-worker-term';
    termEl.dataset.workerId = entry.workerId;
    termEl.style.display = 'none';
    state.refs.body.appendChild(termEl);
    entry.termEl = termEl;
  }
}

function ensureWorkerTerminal(entry: WorkerEntry): Terminal | null {
  if (!entry.termEl) return null;
  if (entry.terminal) return entry.terminal;
  const term = makeTerminal();
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(entry.termEl);
  term.onData((data) => {
    window.electronAPI.workerPtyInput(entry.workerId, data);
  });
  term.onResize(({ cols, rows }) => {
    window.electronAPI.resizeWorkerPty(entry.workerId, cols, rows);
  });
  entry.terminal = term;
  entry.fit = fit;
  // Replay buffered γ-mode output so the promoted tab shows everything the
  // user missed. The buffer is bounded so this is cheap.
  if (entry.bufferedOutput.length > 0) {
    term.write(entry.bufferedOutput);
    entry.bufferedOutput = '';
  }
  // First fit happens once it's visible — fitting a display:none terminal
  // crashes the renderer.
  return term;
}

function setActiveTab(target: string): void {
  if (!state.refs) return;
  state.activeTab = target;
  // Toggle conversational terminal.
  if (target === 'assistant') {
    state.refs.term.style.display = '';
    if (state.terminal && state.fit) {
      try { state.fit.fit(); } catch { /* ignore */ }
      state.terminal.focus();
    }
  } else {
    state.refs.term.style.display = 'none';
  }
  // Toggle worker terminals.
  for (const w of state.workers.values()) {
    if (!w.termEl) continue;
    const active = w.workerId === target;
    w.termEl.style.display = active ? '' : 'none';
    if (active) {
      const term = ensureWorkerTerminal(w);
      if (term && w.fit) {
        // Defer one frame so the layout settles before fit reads dimensions.
        requestAnimationFrame(() => {
          if (!w.fit || !w.termEl || w.termEl.offsetWidth === 0) return;
          try { w.fit.fit(); } catch { /* ignore */ }
          term.focus();
        });
      }
    }
  }
  // Reflect aria + class on tabs.
  state.refs.tabs.querySelectorAll<HTMLButtonElement>('.rd-claude-tab').forEach((t) => {
    const isAssistant = t.id === 'claudeTabAssistant';
    const isMatch = (isAssistant && target === 'assistant') ||
      (!isAssistant && t.dataset.workerId === target);
    t.classList.toggle('is-active', isMatch);
    t.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
}

const SCROLLBACK_BUFFER_CAP = 64 * 1024; // ~64 KB of raw bytes per γ-only worker.

function onWorkerData(ev: WorkerDataEvent): void {
  const w = state.workers.get(ev.workerId);
  if (!w) return;
  if (w.terminal) {
    // Terminal already exists — write straight through.
    w.terminal.write(ev.data);
    return;
  }
  // γ-only: stash in a bounded buffer so promotion can replay scrollback.
  // We keep the tail (most recent) rather than head — early banner text is
  // less useful than ongoing progress when the user opens [log] later.
  w.bufferedOutput += ev.data;
  if (w.bufferedOutput.length > SCROLLBACK_BUFFER_CAP) {
    w.bufferedOutput = w.bufferedOutput.slice(w.bufferedOutput.length - SCROLLBACK_BUFFER_CAP);
  }
}

function onWorkerExit(ev: WorkerExitEvent): void {
  const w = state.workers.get(ev.workerId);
  if (!w) return;
  w.exitCode = ev.exitCode;
  w.exitSignal = ev.signal;
  // Distinguish failed vs done: marker said error, or non-zero exit.
  if (w.lastMarker && w.lastMarker.kind === 'error') w.state = 'failed';
  else if (ev.exitCode !== 0 || ev.signal !== null) w.state = 'failed';
  else if (w.state === 'killed') { /* keep */ }
  else w.state = 'done';
  // Strip-fade window starts at exit; failed rows hang around longer than
  // successes since the user often needs a beat to read the error.
  const fadeMs = w.state === 'failed' ? 12000 : 4000;
  w.stripUntil = Date.now() + fadeMs;
  // Tabs for completed workers stay around (the user may still want to
  // scroll the log) until they close it explicitly.
  renderProgressStrip();
  renderTasksPanel();
}

function onWorkerProgress(ev: WorkerProgressEvent): void {
  const w = state.workers.get(ev.workerId);
  if (!w) return;
  w.lastMarker = ev.marker;
  if (ev.marker.kind === 'error') w.state = 'failed';
  else if (ev.marker.kind === 'done' && w.state === 'running') {
    // done marker doesn't mean exit — the worker may still be running an
    // interactive session. Keep state=running until exit; just surface the
    // text in the strip.
  }
  renderProgressStrip();
  renderTasksPanel();
}

async function killWorker(workerId: string): Promise<void> {
  const w = state.workers.get(workerId);
  if (!w) return;
  if (w.state === 'running') {
    w.state = 'killed';
    w.stripUntil = Date.now() + 4000;
  }
  await window.electronAPI.killWorkerPty(workerId);
  removeWorkerTab(workerId);
  if (state.activeTab === workerId) setActiveTab('assistant');
  renderProgressStrip();
  renderTasksPanel();
}

function removeWorkerTab(workerId: string): void {
  const w = state.workers.get(workerId);
  if (!w) return;
  if (w.tabEl) { w.tabEl.remove(); w.tabEl = null; }
  w.hasTab = false;
  // Terminal stays attached so γ [log] can still surface scrollback. It's
  // hidden until promoted again.
  if (w.termEl) w.termEl.style.display = 'none';
}

// ─── §9.2.7 β progress strip ──────────────────────────────────────────────

let stripFadeTimer: number | null = null;

function renderProgressStrip(): void {
  if (!state.refs) return;
  const strip = state.refs.progressStrip;
  // Visible = running, or any non-running whose stripUntil hasn't elapsed.
  const now = Date.now();
  const visible: WorkerEntry[] = [];
  let earliestFadeOut = Number.POSITIVE_INFINITY;
  for (const w of state.workers.values()) {
    if (w.state === 'running') {
      visible.push(w);
    } else if (w.stripUntil > now) {
      visible.push(w);
      if (w.stripUntil < earliestFadeOut) earliestFadeOut = w.stripUntil;
    }
  }
  if (visible.length === 0) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  strip.hidden = false;
  strip.replaceChildren();
  for (const w of visible) strip.appendChild(buildProgressRow(w));
  // Schedule a re-render when the next fade window closes. Cancels any
  // earlier timer so we don't stack.
  if (stripFadeTimer !== null) {
    window.clearTimeout(stripFadeTimer);
    stripFadeTimer = null;
  }
  if (earliestFadeOut < Number.POSITIVE_INFINITY) {
    const delay = Math.max(50, earliestFadeOut - now);
    stripFadeTimer = window.setTimeout(() => {
      stripFadeTimer = null;
      renderProgressStrip();
    }, delay);
  }
}

function buildProgressRow(w: WorkerEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rd-progress-row';
  row.dataset.state = w.state;
  const icon = document.createElement('span');
  icon.className = 'rd-progress-icon';
  icon.textContent = w.state === 'running' ? '⟳' :
                     w.state === 'done' ? '✓' :
                     w.state === 'failed' ? '✗' : '◼';
  const text = document.createElement('span');
  text.className = 'rd-progress-text';
  text.textContent = formatStripText(w);
  const actions = document.createElement('span');
  actions.className = 'rd-progress-actions';
  const log = document.createElement('button');
  log.type = 'button';
  log.textContent = '[log]';
  log.title = 'Open this worker\'s tab';
  log.addEventListener('click', () => openWorkerInTab(w.workerId));
  actions.appendChild(log);
  row.append(icon, text, actions);
  return row;
}

function formatStripText(w: WorkerEntry): string {
  const kindLabel = w.kind === 'sling' ? 'Sling' : 'Worker';
  const head = `${kindLabel} ${w.label.replace(/^[^\s]+\s/, '')}`;
  const marker = w.lastMarker;
  if (!marker) {
    if (w.state === 'running') return `${head} — running`;
    if (w.state === 'failed') return `${head} — failed${w.exitCode ? ` (exit ${w.exitCode})` : ''}`;
    if (w.state === 'killed') return `${head} — killed`;
    return `${head} — done`;
  }
  if (marker.kind === 'progress') {
    const label = marker.label ? ` (${marker.label})` : '';
    return `${head} — ${marker.phase} ${marker.done} of ${marker.total}${label}`;
  }
  if (marker.kind === 'status') return `${head} — ${marker.text}`;
  if (marker.kind === 'done')   return `${head} — ${marker.text ?? 'done'}`;
  if (marker.kind === 'error')  return `${head} — error: ${marker.text}`;
  return head;
}

/** Promote a worker into a visible tab. Used by the β strip [log] action
 *  and γ panel [log] action. If no tab capacity, the user has to close
 *  another tab first; we don't auto-evict. */
function openWorkerInTab(workerId: string): void {
  const w = state.workers.get(workerId);
  if (!w) return;
  if (!w.hasTab) {
    // Try to promote. If at capacity, just switch focus to its existing
    // (hidden) terminal in a γ-only modal — for v1 we simplify by forcing a
    // tab slot via shifting the oldest non-active worker.
    const tabCount = countTabs();
    if (tabCount >= MAX_WORKER_TABS) {
      // Demote the oldest non-active tabbed worker to γ.
      let oldest: WorkerEntry | null = null;
      for (const cand of state.workers.values()) {
        if (!cand.hasTab) continue;
        if (cand.workerId === state.activeTab) continue;
        if (!oldest || cand.startedAt < oldest.startedAt) oldest = cand;
      }
      if (oldest) removeWorkerTab(oldest.workerId);
    }
    w.hasTab = true;
    mountWorkerTab(w);
  }
  setActiveTab(workerId);
}

// ─── §9.2.7 γ tasks panel ─────────────────────────────────────────────────

function toggleTasksPanel(): void {
  if (!state.refs) return;
  const open = state.refs.tasksPanel.hidden;
  setTasksPanelOpen(open);
}

function setTasksPanelOpen(open: boolean): void {
  if (!state.refs) return;
  state.refs.tasksPanel.hidden = !open;
  state.refs.tasksToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderTasksPanel();
}

function updateTasksToggle(): void {
  if (!state.refs) return;
  const total = state.workers.size;
  state.refs.tasksToggle.hidden = total === 0;
  state.refs.tasksCount.textContent = String(total);
}

function renderTasksPanel(): void {
  if (!state.refs) return;
  updateTasksToggle();
  const list = state.refs.tasksList;
  const empty = state.refs.tasksEmpty;
  list.replaceChildren();
  const all = Array.from(state.workers.values()).sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  );
  if (all.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    return;
  }
  list.hidden = false;
  empty.hidden = true;
  for (const w of all) {
    list.appendChild(buildTaskRow(w));
  }
}

function buildTaskRow(w: WorkerEntry): HTMLElement {
  const row = document.createElement('li');
  row.className = 'tasks-panel-row';
  row.dataset.state = w.state;
  row.dataset.workerId = w.workerId;

  const head = document.createElement('div');
  head.className = 'tasks-panel-row-head';
  const kind = document.createElement('span');
  kind.className = 'tasks-panel-row-kind';
  kind.textContent = w.kind === 'sling' ? 'Sling' : 'Context';
  const summary = document.createElement('span');
  summary.className = 'tasks-panel-row-summary';
  summary.textContent = w.summaryHint || '(no prompt)';
  head.append(kind, summary);

  const meta = document.createElement('div');
  meta.className = 'tasks-panel-row-meta';
  const startedAgo = formatRelative(w.startedAt);
  const stateLabel =
    w.state === 'running' ? 'running' :
    w.state === 'done' ? 'done' :
    w.state === 'failed' ? `failed${w.exitCode ? ` (exit ${w.exitCode})` : ''}` :
    'killed';
  meta.textContent = `${stateLabel} · started ${startedAgo}`;

  const actions = document.createElement('div');
  actions.className = 'tasks-panel-row-actions';
  const logBtn = document.createElement('button');
  logBtn.type = 'button';
  logBtn.textContent = '[log]';
  logBtn.addEventListener('click', () => {
    openWorkerInTab(w.workerId);
    setTasksPanelOpen(false);
  });
  actions.appendChild(logBtn);
  if (w.state !== 'running') {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = '↻ retry';
    retryBtn.title = 'Spawn a new worker with the same bundle + prompt';
    retryBtn.addEventListener('click', () => {
      void spawnWorker({
        kind: w.retry.kind,
        docSourceDir: w.retry.docSourceDir,
        bundle: w.retry.bundle,
        mode: w.retry.mode,
        destination: w.retry.destination,
      });
      setTasksPanelOpen(false);
    });
    actions.appendChild(retryBtn);
  } else {
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.textContent = '◼ stop';
    stopBtn.title = 'Kill this worker';
    stopBtn.addEventListener('click', () => {
      void killWorker(w.workerId);
    });
    actions.appendChild(stopBtn);
  }

  row.append(head, meta, actions);
  return row;
}

function formatRelative(d: Date): string {
  const delta = Math.round((Date.now() - d.getTime()) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  return `${Math.round(delta / 3600)}h ago`;
}

// ─── Teardown ─────────────────────────────────────────────────────────────

export function dispose(): void {
  if (state.unsubData) { state.unsubData(); state.unsubData = null; }
  if (state.unsubExit) { state.unsubExit(); state.unsubExit = null; }
  if (state.unsubWorkerData) { state.unsubWorkerData(); state.unsubWorkerData = null; }
  if (state.unsubWorkerExit) { state.unsubWorkerExit(); state.unsubWorkerExit = null; }
  if (state.unsubWorkerProgress) { state.unsubWorkerProgress(); state.unsubWorkerProgress = null; }
  if (state.resizeObs) { state.resizeObs.disconnect(); state.resizeObs = null; }
  if (state.docSwitchTimer !== null) {
    window.clearTimeout(state.docSwitchTimer);
    state.docSwitchTimer = null;
  }
  if (stripFadeTimer !== null) {
    window.clearTimeout(stripFadeTimer);
    stripFadeTimer = null;
  }
  if (state.terminal) {
    try { state.terminal.dispose(); } catch { /* already disposed */ }
    state.terminal = null;
    state.fit = null;
  }
  for (const w of state.workers.values()) {
    if (w.terminal) try { w.terminal.dispose(); } catch { /* already disposed */ }
  }
  state.workers.clear();
  state.spawned = false;
}

/** Lets the host (index.ts) read the current reviewer probe without re-running
 *  the IPC roundtrip. Used by rev-1md.3 to gate the Sling button. */
export function getReviewerProbe(): ReviewerProbe | null {
  return state.reviewer;
}

/** True iff the conversational pty is currently alive (spawned and not
 *  exited). The toolbar reads this to gate Create Context / Fresh Start. */
export function isSpawned(): boolean {
  return state.spawned;
}
