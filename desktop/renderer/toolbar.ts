// §9.2.6 right-drawer toolbar (rev-1md.3; SDK route since X8 stage 4 / rev-enext.3).
//
// Three icon buttons above the conversational agent pane:
//   ✨ Create Context  — bundle current doc context + spawn a worker session
//   🪃 Sling           — bundle + destination → worker session calls `gt mail send`
//   🌅 Fresh Start     — respawn the conversational session with handoff priming
//
// Each button opens a modal that captures the user's prompt and any
// per-action knobs (Ralph-loop iterations, sling destination, handoff
// summary). On commit, we hand off to window.agentViewer.spawnSession /
// window.agentViewer.freshStart (the React agent pane / SDK route).
//
// Sling is greyed out when gas-town isn't available (§9.2.5 — explanatory
// popover). Create Context / Fresh Start require an open PDF so they're also
// conditionally disabled.

import type { CommentPayload, PdfQuadAnchor } from '@shared/comments';
import type {
  CreateContextMode,
  ReviewerProbe,
  ToolbarContextBundle,
} from '@shared/pty';

// X8 stage 4 (rev-enext.3): the pty route is retired — the React agent pane
// (window.agentViewer) is the only surface. The toolbar reads the reviewer-rig
// probe directly via the preload bridge (formerly cached by the now-deleted
// claude-pane) so Sling gating still reflects gt presence + identity.
let reviewerProbe: ReviewerProbe | null = null;

async function refreshReviewerProbe(): Promise<void> {
  try {
    reviewerProbe = await window.electronAPI.probeReviewer();
  } catch {
    reviewerProbe = null;
  }
  refreshButtonStates();
}

/** Callback provided by the host so the toolbar can pull the current doc
 *  context at button-click time (rather than at mount time, when the user
 *  hasn't picked anything yet). */
export interface ToolbarContextProvider {
  /** Absolute path of the currently-open source PDF. Empty when no doc. */
  docPath(): string;
  /** Source directory (cwd hint for worker spawns). */
  docSourceDir(): string;
  /** 1-indexed current page. Null when no PDF. */
  currentPage(): number | null;
  /** Total page count. Null when no PDF. */
  pageCount(): number | null;
  /** Last non-empty selection the viewer reported. Null when nothing
   *  highlighted (or after a doc switch). */
  selection(): {
    page: number;
    region: { x: number; y: number; w: number; h: number };
    highlightedText: string;
  } | null;
  /** All comments in scope for the current doc. The toolbar filters down to
   *  the current page for the bundle. */
  comments(): CommentPayload[];
}

interface DOMRefs {
  toolbar: HTMLElement;
  createBtn: HTMLButtonElement;
  slingBtn: HTMLButtonElement;
  freshBtn: HTMLButtonElement;
  ctxModal: HTMLElement;
  ctxBundle: HTMLElement;
  ctxPrompt: HTMLTextAreaElement;
  ctxIterations: HTMLInputElement;
  ctxSubmit: HTMLButtonElement;
  slingModal: HTMLElement;
  slingBundle: HTMLElement;
  slingPrompt: HTMLTextAreaElement;
  slingDestination: HTMLInputElement;
  slingHint: HTMLElement;
  slingSubmit: HTMLButtonElement;
  freshModal: HTMLElement;
  freshHandoff: HTMLTextAreaElement;
  freshSubmit: HTMLButtonElement;
}

export interface MountToolbarOptions {
  refs: DOMRefs;
  ctx: ToolbarContextProvider;
}

const NEARBY_COMMENT_CAP = 8;

let refsRef: DOMRefs | null = null;
let ctxRef: ToolbarContextProvider | null = null;

export function mountToolbar(opts: MountToolbarOptions): void {
  refsRef = opts.refs;
  ctxRef = opts.ctx;

  opts.refs.createBtn.addEventListener('click', () => openCtxModal());
  opts.refs.slingBtn.addEventListener('click', () => openSlingModal());
  opts.refs.freshBtn.addEventListener('click', () => openFreshModal());

  wireModalDismiss(opts.refs.ctxModal);
  wireModalDismiss(opts.refs.slingModal);
  wireModalDismiss(opts.refs.freshModal);

  // Create Context modal — enable iterations input when ralph-loop is active.
  opts.refs.ctxModal.querySelectorAll<HTMLInputElement>('input[name="ctxMode"]').forEach((r) => {
    r.addEventListener('change', () => {
      opts.refs.ctxIterations.disabled = r.value !== 'ralph-loop' || !r.checked;
      // When the radio just got selected, also enable; when deselected the
      // OTHER radio's change is what fires, so check both at once via the
      // checked sibling.
      const ralph = opts.refs.ctxModal.querySelector<HTMLInputElement>(
        'input[name="ctxMode"][value="ralph-loop"]',
      );
      opts.refs.ctxIterations.disabled = !(ralph?.checked);
    });
  });

  opts.refs.ctxSubmit.addEventListener('click', () => { void commitCtx(); });
  opts.refs.slingSubmit.addEventListener('click', () => { void commitSling(); });
  opts.refs.freshSubmit.addEventListener('click', () => { void commitFresh(); });

  // Enter-to-submit inside modal textareas: plain Enter inserts a newline
  // (multi-line prompts are common); ⌘/Ctrl+Enter commits.
  bindCommitOnMeta(opts.refs.ctxPrompt, () => commitCtx());
  bindCommitOnMeta(opts.refs.slingPrompt, () => commitSling());
  bindCommitOnMeta(opts.refs.freshHandoff, () => commitFresh());
  // Destination is a single-line input — plain Enter commits.
  opts.refs.slingDestination.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitSling();
    }
  });

  // X8 stage 4 (rev-enext.3): probe the reviewer rig once on mount so Sling
  // gating reflects gt presence + identity (the now-deleted claude-pane used
  // to broadcast this via 'claude-pane:reviewer-probed'). The call ends in
  // refreshButtonStates() so initial button states settle once it resolves.
  void refreshReviewerProbe();
  // Also react to selection / page changes — the modals re-read the bundle
  // when opened, but the buttons themselves are gated on doc presence only.
  window.addEventListener('toolbar:doc-state-changed', () => refreshButtonStates());

  refreshButtonStates();
}

function wireModalDismiss(modal: HTMLElement): void {
  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === modal) { closeModal(modal); return; }
    const action = t.dataset.action;
    if (action === 'close') closeModal(modal);
  });
  // Esc to close.
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(modal);
    }
  });
}

function bindCommitOnMeta(el: HTMLTextAreaElement, commit: () => void | Promise<void>): void {
  el.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'Return')) {
      e.preventDefault();
      void commit();
    }
  });
}

function openModal(modal: HTMLElement, focusEl?: HTMLElement): void {
  modal.hidden = false;
  if (focusEl) setTimeout(() => focusEl.focus(), 0);
}

function closeModal(modal: HTMLElement): void {
  modal.hidden = true;
}

// ─── Button gating ────────────────────────────────────────────────────────

function refreshButtonStates(): void {
  if (!refsRef || !ctxRef) return;
  const hasDoc = ctxRef.docPath().length > 0;
  const slingAvailable = !!(reviewerProbe && reviewerProbe.enabled);
  // X8 stage 4 (rev-enext.3): the React agent pane is always mounted, so the
  // "agent is alive" condition is simply that a doc is open. Create Context
  // and Fresh Start need a doc; Sling additionally needs gas-town (reviewer
  // probe enabled) + a destination (validated at commit time). The buttons
  // route to window.agentViewer.spawnSession / freshStart at commit.
  refsRef.createBtn.disabled = !hasDoc;
  refsRef.slingBtn.disabled = !(hasDoc && slingAvailable);
  refsRef.slingBtn.title = slingAvailable
    ? 'Sling to another rig or crew'
    : 'Enable gas-town integration in Settings to sling to other rigs';
  refsRef.freshBtn.disabled = !hasDoc;
}

// ─── Bundle assembly ──────────────────────────────────────────────────────

function bundleToPrompt(
  bundle: ToolbarContextBundle,
  kind: 'create-context' | 'sling',
  mode?: CreateContextMode,
  destination?: string,
): string {
  const lines: string[] = [];
  lines.push(`[${kind === 'sling' ? 'Sling' : 'Create Context'}]`);
  lines.push(`Document: ${bundle.docPath}`);
  if (bundle.currentPage !== null) lines.push(`Page: ${bundle.currentPage}/${bundle.pageCount ?? '?'}`);
  if (bundle.selection) {
    lines.push(`Selection (p.${bundle.selection.page}): "${bundle.selection.highlightedText}"`);
  }
  if (bundle.nearbyComments.length > 0) {
    lines.push(`Nearby comments: ${bundle.nearbyComments.map((c) => `[${c.engagementLevel}] ${c.body.slice(0, 80)}`).join('; ')}`);
  }
  if (mode?.kind === 'ralph-loop') lines.push(`Mode: iterate ${mode.iterations} times`);
  if (destination) lines.push(`Destination: ${destination}`);
  if (bundle.userPrompt) lines.push('', bundle.userPrompt);
  return lines.join('\n');
}

function buildBundle(userPrompt: string): ToolbarContextBundle {
  if (!ctxRef) throw new Error('toolbar: context provider missing');
  const docPath = ctxRef.docPath();
  const page = ctxRef.currentPage();
  const all = ctxRef.comments();
  // "Nearby comments on this page" is a PDF-only notion — only pdf-quad anchors
  // carry a page. Narrow on the truthful union kind.
  const onPage = page !== null
    ? all
        .filter((c): c is typeof c & { anchor: PdfQuadAnchor } => c.anchor.kind === 'pdf-quad' && c.anchor.page === page)
        .slice(0, NEARBY_COMMENT_CAP)
    : [];
  return {
    docPath,
    currentPage: page,
    pageCount: ctxRef.pageCount(),
    selection: ctxRef.selection(),
    // Section heading detection deferred — the bundle schema reserves the
    // slot so future engine work (TOC parsing) can fill it without breaking
    // the rig-side priming language.
    sectionHeading: null,
    nearbyComments: onPage.map((c) => ({
      id: c.id,
      engagementLevel: c.engagement_level,
      body: c.comment || c.redraft || '',
      page: c.anchor.page,
      highlightedText: c.highlighted_text,
      status: c.status ?? 'open',
    })),
    userPrompt,
  };
}

function renderBundlePreview(target: HTMLElement, bundle: ToolbarContextBundle): void {
  target.replaceChildren();
  const lines: string[] = [];
  lines.push(`**doc**: ${bundle.docPath || '(none)'}`);
  if (bundle.currentPage !== null) {
    lines.push(`**page**: ${bundle.currentPage}${bundle.pageCount !== null ? ` / ${bundle.pageCount}` : ''}`);
  }
  if (bundle.selection) {
    const t = bundle.selection.highlightedText.replace(/\s+/g, ' ').trim();
    const snippet = t.length > 200 ? `${t.slice(0, 197)}…` : t;
    lines.push(`**selection (p.${bundle.selection.page})**: "${snippet}"`);
  } else {
    lines.push('**selection**: (none — operating on whole page)');
  }
  if (bundle.nearbyComments.length > 0) {
    lines.push(`**comments on page (${bundle.nearbyComments.length})**:`);
    for (const c of bundle.nearbyComments) {
      const body = (c.body || c.highlightedText).replace(/\s+/g, ' ').trim();
      const snippet = body.length > 120 ? `${body.slice(0, 117)}…` : body;
      lines.push(`  • [${c.engagementLevel}/${c.status}] ${snippet}`);
    }
  }
  // Render with **strong** segments highlighted. Cheap manual tokenizer —
  // the modal's content is fully under our control.
  for (const line of lines) {
    const row = document.createElement('div');
    const parts = line.split(/\*\*(.+?)\*\*/g);
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const strong = document.createElement('strong');
        strong.textContent = p;
        row.appendChild(strong);
      } else {
        row.appendChild(document.createTextNode(p));
      }
    });
    target.appendChild(row);
  }
}

// ─── Create Context ───────────────────────────────────────────────────────

function openCtxModal(): void {
  if (!refsRef || !ctxRef) return;
  const bundle = buildBundle('');
  renderBundlePreview(refsRef.ctxBundle, bundle);
  refsRef.ctxPrompt.value = '';
  // Restore default mode (single-shot).
  const single = refsRef.ctxModal.querySelector<HTMLInputElement>(
    'input[name="ctxMode"][value="single-shot"]',
  );
  if (single) single.checked = true;
  refsRef.ctxIterations.disabled = true;
  refsRef.ctxIterations.value = '5';
  openModal(refsRef.ctxModal, refsRef.ctxPrompt);
}

async function commitCtx(): Promise<void> {
  if (!refsRef || !ctxRef) return;
  const prompt = refsRef.ctxPrompt.value.trim();
  if (!prompt) {
    refsRef.ctxPrompt.focus();
    return;
  }
  const isRalph = !!refsRef.ctxModal.querySelector<HTMLInputElement>(
    'input[name="ctxMode"][value="ralph-loop"]:checked',
  );
  let mode: CreateContextMode = { kind: 'single-shot' };
  if (isRalph) {
    const n = Math.max(2, Math.min(50, parseInt(refsRef.ctxIterations.value, 10) || 5));
    mode = { kind: 'ralph-loop', iterations: n };
  }
  const bundle = buildBundle(prompt);
  if (!window.agentViewer) {
    flashErr(refsRef.ctxModal, 'Create Context failed: agent bridge missing');
    return;
  }
  refsRef.ctxSubmit.disabled = true;
  try {
    const sessionId = `worker-ctx-${Date.now()}`;
    const agentPrompt = bundleToPrompt(bundle, 'create-context', mode);
    await window.agentViewer.spawnSession({
      sessionId,
      prompt: agentPrompt,
      docSourceDir: ctxRef.docSourceDir(),
    });
    closeModal(refsRef.ctxModal);
  } catch (err) {
    flashErr(refsRef.ctxModal, `Create Context failed: ${errMsg(err)}`);
  } finally {
    refsRef.ctxSubmit.disabled = false;
  }
}

// ─── Sling ────────────────────────────────────────────────────────────────

function openSlingModal(): void {
  if (!refsRef || !ctxRef) return;
  const bundle = buildBundle('');
  renderBundlePreview(refsRef.slingBundle, bundle);
  refsRef.slingPrompt.value = '';
  refsRef.slingDestination.value = '';
  refsRef.slingHint.textContent =
    'Examples: mayor · report-engine/anthony · reviewer/anthony';
  openModal(refsRef.slingModal, refsRef.slingDestination);
}

async function commitSling(): Promise<void> {
  if (!refsRef || !ctxRef) return;
  const prompt = refsRef.slingPrompt.value.trim();
  const destination = refsRef.slingDestination.value.trim();
  if (!destination) {
    refsRef.slingHint.textContent = 'Destination is required.';
    refsRef.slingDestination.focus();
    return;
  }
  const bundle = buildBundle(prompt);
  if (!window.agentViewer) {
    flashErr(refsRef.slingModal, 'Sling failed: agent bridge missing');
    return;
  }
  refsRef.slingSubmit.disabled = true;
  try {
    const sessionId = `worker-sling-${Date.now()}`;
    const agentPrompt = bundleToPrompt(bundle, 'sling', undefined, destination);
    await window.agentViewer.spawnSession({
      sessionId,
      prompt: agentPrompt,
      docSourceDir: ctxRef.docSourceDir(),
    });
    closeModal(refsRef.slingModal);
  } catch (err) {
    flashErr(refsRef.slingModal, `Sling failed: ${errMsg(err)}`);
  } finally {
    refsRef.slingSubmit.disabled = false;
  }
}

// ─── Fresh Start ──────────────────────────────────────────────────────────

function openFreshModal(): void {
  if (!refsRef) return;
  refsRef.freshHandoff.value = '';
  openModal(refsRef.freshModal, refsRef.freshHandoff);
}

async function commitFresh(): Promise<void> {
  if (!refsRef || !ctxRef) return;
  const handoffNotes = refsRef.freshHandoff.value.trim();
  const docSourceDir = ctxRef.docSourceDir();
  refsRef.freshSubmit.disabled = true;
  try {
    // X8 stage 4 (rev-enext.3): route to the agent pane's freshStart. The
    // handoff text becomes the first user message of a brand-new agent session.
    if (!window.agentViewer) {
      flashErr(refsRef.freshModal, 'Fresh start failed: agent bridge missing');
      return;
    }
    await window.agentViewer.freshStart({
      handoffText: handoffNotes || '(no handoff notes)',
      docSourceDir,
    });
    closeModal(refsRef.freshModal);
  } catch (err) {
    flashErr(refsRef.freshModal, `Fresh start failed: ${errMsg(err)}`);
  } finally {
    refsRef.freshSubmit.disabled = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function flashErr(modal: HTMLElement, message: string): void {
  // Inline error: prepend a banner inside the modal body. Removed after 5s.
  const body = modal.querySelector<HTMLElement>('.toolbar-modal-body');
  if (!body) return;
  let banner = body.querySelector<HTMLElement>('.toolbar-modal-err');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'toolbar-modal-err';
    banner.style.color = '#ffb3b3';
    banner.style.fontSize = '12px';
    banner.style.padding = '6px 8px';
    banner.style.background = 'rgba(122, 42, 42, 0.25)';
    banner.style.border = '1px solid #7a2a2a';
    banner.style.borderRadius = '3px';
    body.prepend(banner);
  }
  banner.textContent = message;
  setTimeout(() => banner?.remove(), 5000);
}
