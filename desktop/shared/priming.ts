// Shared, pure priming module for both embedded-Claude routes.
//
// X8 Stage 2 (OD-3 convergence): the priming *text* — the slash-command
// activation line, the bundle→text serialization, the doc-switch line, and the
// Fresh-Start handoff line — was written in three places that had already
// started to drift (claude-pty.ts stringified worker/fresh-start priming to the
// pty's stdin; agent-pane-ipc.ts and renderer/claude-pane.ts each hand-built
// their own copy of the doc-switch line), and the pty side fired it on magic
// wall-clock setTimeouts that raced claude's startup render (C11 "priming
// serialized twice with magic wall-clock delays"). This module is the single
// source of truth for the priming language all three sites consume, plus a pure
// readiness detector so the pty side can fire when claude's prompt is actually
// on screen and fall back to a timeout only.
//
// Lives in shared/ (not main/) precisely so the renderer pty route can import
// the same doc-switch builder the main routes use. Pure (no electron /
// node-pty / I/O) so it unit-tests without a host.

import type {
  ToolbarContextBundle,
  WorkerStartParams,
} from './pty';

/** The skill-activation slash-command. Claude Code 2.1.146 has no `--skill`
 *  flag (rev-a1u spike), so the slash-command written as the first line is the
 *  activation path for both the conversational and worker sessions. */
export const PRIMING_SLASH_COMMAND = '/review-pdf-to-latex';

// ─── Readiness detection (pty route) ───────────────────────────────────────

/**
 * Default fallback delay before priming fires if claude's ready prompt is
 * never observed in the output stream. Matches the conv pty's prior wall-clock
 * delay (rev-gkl) so behavior is unchanged when detection fails — the observed
 * trigger can only fire *earlier and after render*, never regress.
 */
export const PRIMING_CONV_FALLBACK_MS = 1500;

/** Worker pty fallback delay — matches the worker's prior wall-clock delay. */
export const PRIMING_WORKER_FALLBACK_MS = 500;

/**
 * Markers that only appear once Claude Code's interactive prompt is rendered
 * and ready for input. We bias HARD toward specificity: a marker that never
 * matches simply degrades to the timeout fallback (the prior behavior), whereas
 * a marker that fires too early — before claude's startup banner is cleared —
 * would lose the slash-command from scrollback (the exact rev-gkl regression).
 * The "? for shortcuts" footer hint is printed beneath the input box only once
 * the session is interactive, so it sits safely after the screen-clear. We
 * deliberately do NOT key on the rounded box border (`╰`): claude's startup
 * "Welcome" box uses the same character before the prompt is ready.
 */
export const CLAUDE_READY_MARKERS: readonly string[] = [
  '? for shortcuts',
];

/**
 * Decide, from the accumulated pty output so far, whether claude's interactive
 * prompt is ready to receive priming. Pure: the caller owns the accumulation
 * buffer and the fire-once latch. Returns true as soon as any ready marker is
 * present in the stream.
 */
export function detectClaudeReady(accumulatedOutput: string): boolean {
  for (const marker of CLAUDE_READY_MARKERS) {
    if (accumulatedOutput.includes(marker)) return true;
  }
  return false;
}

// ─── Fresh Start handoff line ──────────────────────────────────────────────

/** Build the handoff priming line. Bracketed so it reads as a system-style
 *  message in scrollback (same shape as §9.2.4's `[Now viewing: ...]`). */
export function buildFreshStartPriming(handoff: string): string {
  const trimmed = handoff.trim();
  if (!trimmed) return '[Fresh start — clean session.]';
  // Multi-line handoffs: collapse to a single bracketed line. Claude reads
  // stdin as line-buffered, and a multi-line paste would interleave with
  // the slash-command's own ack frames.
  const single = trimmed.replace(/\s+/g, ' ');
  return `[Fresh start — handoff from prior session: ${single}]`;
}

// ─── Doc-switch line (§9.2.4) ──────────────────────────────────────────────

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Build the `[Now reviewing/editing: …]` doc-context line sent on a doc switch.
 * The verb and unit are kind-aware: markdown files are "editing" a "file";
 * everything else is "reviewing" N "pages". Single-source for the SDK route's
 * debounced doc-switch send (agent-pane-ipc.ts).
 */
export function buildDocPrimingLine(p: {
  path: string;
  pages: number;
  comments: number;
}): string {
  const base = basenameOf(p.path);
  const ext = base.toLowerCase().split('.').pop() ?? '';
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const verb = isMarkdown ? 'editing' : 'reviewing';
  const unit = p.pages === 1 && isMarkdown ? 'file' : `${p.pages} pages`;
  return `[Now ${verb}: ${base} — ${p.path} (${unit}, ${p.comments} comments)]`;
}

// ─── Worker bundle → priming text ──────────────────────────────────────────

/** Serialize a context bundle into the worker's first-line priming. The shape
 *  is deliberately human-readable rather than JSON — the user sees this
 *  scrollback and should be able to grok what was sent. */
export function bundleToPrimingText(bundle: ToolbarContextBundle): string {
  const lines: string[] = [];
  lines.push('# Context bundle');
  lines.push(`doc: ${bundle.docPath}`);
  if (bundle.currentPage !== null) {
    lines.push(`page: ${bundle.currentPage}${bundle.pageCount !== null ? ` of ${bundle.pageCount}` : ''}`);
  }
  if (bundle.sectionHeading) {
    lines.push(`section: ${bundle.sectionHeading}`);
  }
  if (bundle.selection) {
    const s = bundle.selection;
    const text = s.highlightedText.replace(/\s+/g, ' ').trim();
    const snippet = text.length > 280 ? `${text.slice(0, 277)}…` : text;
    lines.push(`selection (p.${s.page}): "${snippet}"`);
  } else {
    lines.push('selection: (none — operating on the whole page)');
  }
  if (bundle.nearbyComments.length > 0) {
    lines.push('nearby comments:');
    for (const c of bundle.nearbyComments) {
      const body = (c.body || c.highlightedText).replace(/\s+/g, ' ').trim();
      const snippet = body.length > 160 ? `${body.slice(0, 157)}…` : body;
      lines.push(`  - [${c.engagementLevel}/${c.status}] p.${c.page}: ${snippet}`);
    }
  }
  lines.push('');
  if (bundle.userPrompt.trim().length > 0) {
    lines.push('# User intent');
    lines.push(bundle.userPrompt.trim());
  }
  return lines.join('\n');
}

/** Build the Create-Context worker's priming message (header + bundle). */
export function buildCreateContextPriming(params: WorkerStartParams): string {
  const head: string[] = [];
  head.push(`[Worker spawn — Create Context. Use the ${PRIMING_SLASH_COMMAND} skill.]`);
  const mode = params.mode ?? { kind: 'single-shot' };
  if (mode.kind === 'ralph-loop') {
    head.push(`[Ralph loop mode — iterate this prompt ${mode.iterations} times, ` +
      `reporting progress on each iteration via the §9.2.7 [β] marker grammar ` +
      `(e.g., "[β] kind=progress phase=ralph done=K total=${mode.iterations}").]`);
  } else {
    head.push('[Single-shot mode — answer the user interactively. ' +
      'You MAY emit [β] kind=status text="..." markers to surface progress in the inline strip.]');
  }
  head.push('');
  head.push(bundleToPrimingText(params.bundle));
  return head.join('\n');
}

/** Build the Sling worker's priming message (header + bundle). */
export function buildSlingPriming(params: WorkerStartParams): string {
  const destination = params.destination ?? 'reviewer/';
  const subjectPrefix = params.subjectPrefix ?? 'review-pdf sling';
  const head: string[] = [];
  head.push(`[Worker spawn — Sling. Forward this context bundle to ${destination} ` +
    `via \`gt mail send\`. Use --type task --priority 2 --subject "${subjectPrefix}" ` +
    `and pipe the bundle JSON to --stdin. Report progress via [β] markers ` +
    `(kind=status text="sending..." → kind=done text="sent" on success).]`);
  head.push('');
  head.push(bundleToPrimingText(params.bundle));
  return head.join('\n');
}
