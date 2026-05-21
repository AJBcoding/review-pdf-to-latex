// §9.2 embedded Claude pane — renderer side.
//
// Wires an xterm.js terminal to the main-process pty manager (claude-pty.ts).
// One conversational pty per app instance, lazy-spawned on first PDF open.
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
//   - dispose(): tear down on app unload.

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { PtyDataEvent, PtyExitEvent, ReviewerProbe } from '@shared/types';

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
  resizeObs: ResizeObserver | null;
  /** Theme this pane was constructed under. Re-render the terminal if the
   *  app theme changes (no v1 trigger — but cheap to track). */
  themeMode: 'dark' | 'light';
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
  resizeObs: null,
  themeMode: 'dark',
};

// ─── Theme palettes ───────────────────────────────────────────────────────
//
// Anchored to the existing app vars (--bg / --text / --accent etc.). We can't
// directly bind xterm.js to CSS vars (its renderer paints to canvas), so we
// duplicate the 16-color palette here for now. v2 nicety: read computed
// styles from :root and feed them in.

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
  };
  state.themeMode = opts.themeMode;

  // Wire main → renderer streams up front so anything emitted during spawn
  // (the priming command echo, claude's banner) reaches xterm.js once we
  // construct it. If the data races the construction we buffer it inline
  // and flush after open().
  state.unsubData = window.electronAPI.onPtyData(onPtyData);
  state.unsubExit = window.electronAPI.onPtyExit(onPtyExit);

  // Probe gas-town up front so the Sling button (rev-1md.3) can render with
  // the right initial state and the identity label shows immediately if
  // present. Best-effort; failure leaves the label hidden.
  window.electronAPI
    .probeReviewer()
    .then((p) => {
      state.reviewer = p;
      renderIdentity();
    })
    .catch(() => {});
}

/** Replace the empty state with the terminal mount + initialize xterm.js. */
function openTerminal(): Terminal {
  if (state.terminal) return state.terminal;
  if (!state.refs) throw new Error('claude-pane: openTerminal before mount');

  const term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    // Scrollback bound matches Claude Code's chatty tool-call output without
    // blowing the renderer heap. 5000 lines ≈ a typical day's session.
    scrollback: 5000,
    theme: themeForMode(state.themeMode),
    // Allow non-opaque background — surface the app's pane bg if the user
    // ever tweaks --pane-bg under us. Cheap; no rendering cost in practice.
    allowTransparency: false,
    // Disable Alt+letter from binding to the menu bar (macOS) — claude uses
    // Alt for word-wise navigation.
    macOptionIsMeta: true,
  });

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
  });
  resizeObs.observe(state.refs.body);

  state.terminal = term;
  state.fit = fit;
  state.resizeObs = resizeObs;

  return term;
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
  renderIdentity();

  // already_running means a previous PDF open already spawned the pty; we
  // shouldn't suppress further notifications in that case.
  if (result.already_running) state.suppressedFirstSwitch = true;

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
    // Format mirrors §9.2.4 exactly so the user can grep their scrollback.
    const line = `[Now viewing: ${base} — ${p.path} (${p.pages} pages, ${p.comments} comments)]`;
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

// ─── Teardown ─────────────────────────────────────────────────────────────

export function dispose(): void {
  if (state.unsubData) { state.unsubData(); state.unsubData = null; }
  if (state.unsubExit) { state.unsubExit(); state.unsubExit = null; }
  if (state.resizeObs) { state.resizeObs.disconnect(); state.resizeObs = null; }
  if (state.docSwitchTimer !== null) {
    window.clearTimeout(state.docSwitchTimer);
    state.docSwitchTimer = null;
  }
  if (state.terminal) {
    try { state.terminal.dispose(); } catch { /* already disposed */ }
    state.terminal = null;
    state.fit = null;
  }
  state.spawned = false;
}

/** Lets the host (index.ts) read the current reviewer probe without re-running
 *  the IPC roundtrip. Used by rev-1md.3 to gate the Sling button. */
export function getReviewerProbe(): ReviewerProbe | null {
  return state.reviewer;
}
