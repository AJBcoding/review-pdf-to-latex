// §10.1 Submit flow — renderer-side state machine + destination picker.
//
// Co-owns the Submit lifecycle with rev-1md.5 (results-watcher). Roles:
//
//  This module:
//   - Tracks the local state (idle / pending_send / sent_unconfirmed /
//     timeout / send_failed) and drives the pill + banner UI.
//   - Owns the destination picker modal (§10.5).
//   - Calls into main for promote + sling + abandon.
//
//  rev-1md.5 results-watcher (in index.ts):
//   - Drives the acknowledged / processing / complete transitions via the
//     results-file watcher. We expose `markAcknowledged()` so the watcher
//     can pull our local pill out of `sent_unconfirmed` when the rig writes
//     the first results file.
//
//  The two halves talk through this module's exported handles; we don't
//  reach back into index.ts. Same pattern as claude-pane.ts.
//
// Why two co-owners and not one: gt mail send (transport) is fundamentally
// fire-and-forget once exit 0 lands; everything past that is observable only
// via the results-file appearance, which is rev-1md.5's existing surface.
// Folding both into one module would either duplicate the watcher or pull
// the picker into watcher territory.

import { REVIEWER_LOCAL_ID } from '@shared/types';
import type {
  CommentPayload,
  SubmitSlingResult,
} from '@shared/types';

// ─── Public surface ────────────────────────────────────────────────────────

export type SubmitState =
  | 'idle'
  | 'pending_send'
  | 'sent_unconfirmed'
  | 'timeout'
  | 'send_failed'
  | 'complete'
  | 'complete-failed';

/** What the renderer hands us at Submit-fire time. The fields that matter
 *  to the picker (origin_rig, recent_rigs) come along so we don't reach
 *  back through indexes into module-scope. */
export interface SubmitContext {
  sourcePath: string;
  sourceSha256: string;
  sourceFileVersion: string | null;
  bundlePdfPath: string;
  bundleJsonPath: string;
  bundleId: string;
  submittedComments: CommentPayload[];
  /** Pinned at launch via --from. Null for standalone. */
  originRig: string | null;
  appVersion: string;
  /** Most-recently-used destination rigs, used to populate the picker. */
  recentRigs: string[];
  /** Last picked destination for this specific doc (per §10.5 "remembers
   *  its last choice per doc"). */
  lastDestinationForDoc: string | null;
  /** Whether the gt binary is available — drives picker option enablement
   *  per §10.5.3 (no gas-town → Reviewer-local is the only option). */
  gasTownEnabled: boolean;
  /** Author for the submit file's metadata. */
  author: string;
}

export interface SubmitMountOptions {
  pill: HTMLElement;
  banner: HTMLElement;
  picker: {
    root: HTMLElement;
    list: HTMLElement;
    custom: HTMLInputElement;
    submitBtn: HTMLButtonElement;
    closeBtn: HTMLButtonElement;
    hint: HTMLElement;
  };
  /** Called when the picker resolves a destination. The renderer persists
   *  this to AppState (per-doc + recent-rigs list). */
  onDestinationChosen?(rig: string): void;
  /** Called when a sling enters `sent_unconfirmed`. The renderer persists
   *  the pending submit_id so a doc-switch + re-open can recover its state
   *  (we don't deeply persist the pill across reloads in v1, but the hook
   *  is here for the §10.5 concurrent-round lock). */
  onPendingRound?(payload: { submitId: string; destination: string }): void;
  /** Called when the user clicks Re-sling after a timeout. */
  onResling?(): void;
}

interface PickResult {
  destination: string;
  /** False when the user closed the picker without picking. */
  picked: boolean;
}

let opts: SubmitMountOptions | null = null;
let currentState: SubmitState = 'idle';
let currentDestinationLabel: string | null = null;
let timeoutTimerId: number | null = null;
let lastFailure:
  | {
      kind: 'send_failed';
      reason: string;
      stderr: string;
      retryable: true;
    }
  | {
      kind: 'timeout';
    }
  | null = null;
let pendingSubmitId: string | null = null;
let pendingDestination: string | null = null;

/** §10.1 timing constants — values quoted verbatim from rev-2k7 / spec
 *  §10.1 step 4. Tuned to the spec; do not edit without re-checking. */
const SENT_UNCONFIRMED_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min
const COMPLETE_AUTOCLEAR_MS = 5_000;

export function mount(o: SubmitMountOptions): void {
  opts = o;
  wirePicker();
  renderPill();
  renderBanner();
}

export function getState(): SubmitState {
  return currentState;
}

/** True when Submit should be disabled — the concurrent-round lock from
 *  §10.1 step 6 lives outside this module (it tests docState.rounds for
 *  in_progress), but the in-flight states also disable Submit. Combine
 *  both into a single helper for callers. */
export function isInFlight(): boolean {
  return currentState === 'pending_send'
      || currentState === 'sent_unconfirmed'
      || currentState === 'timeout';
}

/** Called by the results-watcher (rev-1md.5) when the first results-*.json
 *  for our pending submit_id appears. Transitions out of sent_unconfirmed,
 *  cancels the 10-minute timeout watcher. */
export function markAcknowledged(submitId: string): void {
  if (pendingSubmitId !== submitId) return;
  if (currentState !== 'sent_unconfirmed' && currentState !== 'timeout') return;
  cancelTimeoutTimer();
  // We stay visually quiet from here until the round completes; the round
  // banner (rev-1md.5) carries the in-progress / complete UI from this
  // point forward. Clear the pill so the two surfaces don't fight.
  transition('idle');
}

/** Called by the results-watcher when a results file flips to
 *  round_status:complete for our pending submit. Shows a brief toast-style
 *  pill then auto-clears. */
export function markRoundComplete(submitId: string, succeeded: boolean): void {
  if (pendingSubmitId !== submitId) {
    // Late callback — the user may have already moved on. We still want
    // the toast to show if we were the originating round, so accept it
    // even when pendingSubmitId is null (only skip if a *different* round
    // is currently in flight).
    if (pendingSubmitId !== null) return;
  }
  cancelTimeoutTimer();
  transition(succeeded ? 'complete' : 'complete-failed');
  // Auto-clear after the spec's 5s window unless the user moves on.
  window.setTimeout(() => {
    if (currentState === 'complete' || currentState === 'complete-failed') {
      transition('idle');
    }
  }, COMPLETE_AUTOCLEAR_MS);
}

/** Reset everything — used on doc switch so the prior doc's pill doesn't
 *  bleed into the new doc. */
export function reset(): void {
  cancelTimeoutTimer();
  pendingSubmitId = null;
  pendingDestination = null;
  currentDestinationLabel = null;
  lastFailure = null;
  transition('idle');
}

/** Main entry point. Promote → sling → drive the state machine. The
 *  caller (Cmd+Return handler) is responsible for writeBundle() first; we
 *  expect the bundle paths in the context. */
export async function executeSubmit(ctx: SubmitContext): Promise<void> {
  if (isInFlight()) {
    flashHint('Submit already in flight — wait for the rig to pick it up.');
    return;
  }

  // Determine destination. If the user has an origin (--from), use it
  // directly. Otherwise open the picker.
  let destination: string;
  if (ctx.originRig) {
    destination = ctx.originRig;
  } else {
    const pick = await openDestinationPicker(ctx);
    if (!pick.picked) return; // user canceled
    destination = pick.destination;
    opts?.onDestinationChosen?.(destination);
  }

  // Promote the draft to a frozen submit file. This is the first irreversible
  // step — once on disk, the audit copy exists even if the sling fails.
  const promote = await window.electronAPI.submitPromote({
    sourcePath: ctx.sourcePath,
    sourceSha256: ctx.sourceSha256,
    sourceFileVersion: ctx.sourceFileVersion,
    bundlePdfPath: ctx.bundlePdfPath,
    bundleJsonPath: ctx.bundleJsonPath,
    originRig: ctx.originRig,
    comments: ctx.submittedComments,
    author: ctx.author,
  });
  if (!promote.ok) {
    transitionToFailure({
      kind: 'send_failed',
      reason: `promote: ${promote.reason}`,
      stderr: promote.error,
      retryable: true,
    });
    return;
  }

  // Mirror the per-comment "submitted" status back to the live drafts so
  // the right-drawer reflects the new state immediately. We dispatch a
  // CustomEvent so this module doesn't need a direct hook back into index.ts.
  window.dispatchEvent(new CustomEvent('submit:comments-promoted', {
    detail: { updates: promote.statusUpdates },
  }));

  pendingSubmitId = promote.submitId;
  pendingDestination = destination;
  currentDestinationLabel = labelForDestination(destination);
  transition('pending_send');

  const slingResult = await window.electronAPI.submitSling({
    destinationRig: destination,
    originRig: ctx.originRig,
    submitId: promote.submitId,
    bundleId: ctx.bundleId,
    sourcePath: ctx.sourcePath,
    submitFilePath: promote.submitFilePath,
    bundlePdfPath: ctx.bundlePdfPath,
    bundleJsonPath: ctx.bundleJsonPath,
    appVersion: ctx.appVersion,
  });

  if (slingResult.ok) {
    transition('sent_unconfirmed');
    opts?.onPendingRound?.({ submitId: promote.submitId, destination });
    startTimeoutTimer();
    return;
  }

  // Failure: hold onto the diagnostic so the banner can render verbatim
  // stderr and offer a Retry. Keep pendingSubmitId set so a manual Retry
  // can re-sling against the same submit file rather than minting a new
  // round.
  describeSlingFailure(slingResult);
}

function describeSlingFailure(r: Exclude<SubmitSlingResult, { ok: true }>): void {
  switch (r.reason) {
    case 'no_gt':
      transitionToFailure({
        kind: 'send_failed',
        reason: 'gas-town disabled',
        stderr: r.message,
        retryable: true,
      });
      return;
    case 'spawn_failed':
      transitionToFailure({
        kind: 'send_failed',
        reason: 'spawn failed',
        stderr: r.error,
        retryable: true,
      });
      return;
    case 'timeout':
      transitionToFailure({
        kind: 'send_failed',
        reason: `gt mail timed out after ${r.timeoutMs}ms`,
        stderr: 'gt mail send did not exit within the local deadline. The mailbox may or may not have received the payload — check `gt mail outbox` manually before re-slinging.',
        retryable: true,
      });
      return;
    case 'gt_failed': {
      const lines: string[] = [];
      if (r.stdout) lines.push(`[stdout]\n${r.stdout.trim()}`);
      if (r.stderr) lines.push(`[stderr]\n${r.stderr.trim()}`);
      if (lines.length === 0) lines.push('(no output from gt)');
      transitionToFailure({
        kind: 'send_failed',
        reason: `gt mail exit ${r.exitCode ?? '?'}`,
        stderr: lines.join('\n\n'),
        retryable: true,
      });
      return;
    }
  }
}

function transitionToFailure(f: NonNullable<typeof lastFailure>): void {
  lastFailure = f;
  transition(f.kind === 'timeout' ? 'timeout' : 'send_failed');
}

function transition(next: SubmitState): void {
  if (next === currentState) return;
  currentState = next;
  if (next === 'idle') {
    lastFailure = null;
    pendingSubmitId = null;
    pendingDestination = null;
    currentDestinationLabel = null;
  }
  renderPill();
  renderBanner();
}

// ─── Pill ──────────────────────────────────────────────────────────────────

function renderPill(): void {
  if (!opts) return;
  const el = opts.pill;
  el.dataset.state = currentState;
  switch (currentState) {
    case 'idle':
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
      return;
    case 'pending_send':
      el.hidden = false;
      el.textContent = `Slinging to ${currentDestinationLabel ?? 'rig'}…`;
      el.removeAttribute('title');
      return;
    case 'sent_unconfirmed':
      el.hidden = false;
      el.textContent = `Submitted to ${currentDestinationLabel ?? 'rig'} — awaiting pickup`;
      el.removeAttribute('title');
      return;
    case 'timeout':
      el.hidden = false;
      el.textContent = `Still waiting on ${currentDestinationLabel ?? 'rig'} (10 min)`;
      el.removeAttribute('title');
      return;
    case 'send_failed':
      el.hidden = false;
      el.textContent = `Submit failed`;
      el.setAttribute('title', lastFailure?.kind === 'send_failed' ? lastFailure.reason : 'unknown error');
      return;
    case 'complete':
      el.hidden = false;
      el.textContent = `Round complete`;
      el.removeAttribute('title');
      return;
    case 'complete-failed':
      el.hidden = false;
      el.textContent = `Round failed`;
      el.removeAttribute('title');
      return;
  }
}

// ─── Banner ────────────────────────────────────────────────────────────────

function renderBanner(): void {
  if (!opts) return;
  const banner = opts.banner;
  banner.replaceChildren();

  if (currentState === 'send_failed' && lastFailure?.kind === 'send_failed') {
    banner.hidden = false;
    banner.setAttribute('data-severity', 'error');
    const head = document.createElement('div');
    head.className = 'submit-banner-head';
    const headText = document.createElement('strong');
    headText.textContent = `Submit failed: ${lastFailure.reason}`;
    head.append(headText);
    const detail = document.createElement('pre');
    detail.className = 'submit-banner-detail';
    detail.textContent = lastFailure.stderr;
    const actions = document.createElement('div');
    actions.className = 'submit-banner-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'is-primary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => { void retrySling(); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { transition('idle'); });
    actions.append(retry, dismiss);
    banner.append(head, detail, actions);
    return;
  }

  if (currentState === 'timeout') {
    banner.hidden = false;
    banner.setAttribute('data-severity', 'warn');
    const head = document.createElement('div');
    head.className = 'submit-banner-head';
    const headText = document.createElement('strong');
    headText.textContent = `Still waiting on ${currentDestinationLabel ?? 'the rig'} (10 min)`;
    head.append(headText);
    const detail = document.createElement('div');
    detail.className = 'submit-banner-detail';
    detail.textContent = `The rig hasn't written a results-*.json yet. The submission may have been received but not picked up — the rig session may need a nudge. Re-sling resends the same payload (same submit_id, no new round file).`;
    const actions = document.createElement('div');
    actions.className = 'submit-banner-actions';
    const resling = document.createElement('button');
    resling.type = 'button';
    resling.className = 'is-primary';
    resling.textContent = 'Re-sling';
    resling.addEventListener('click', () => { void retrySling(); opts?.onResling?.(); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { transition('idle'); });
    actions.append(resling, dismiss);
    banner.append(head, detail, actions);
    return;
  }

  banner.hidden = true;
  banner.removeAttribute('data-severity');
}

async function retrySling(): Promise<void> {
  // Retry re-sends the same payload (same submit_id) so the rig sees a
  // single round. The renderer caches enough context to do this; the
  // simpler path is just to re-execute against the current pending state.
  // If we've lost context (e.g., user switched docs), fall back to telling
  // them to re-Submit.
  if (!pendingSubmitId || !pendingDestination) {
    flashHint('Lost submit context — press Cmd+Return to start a fresh round.');
    transition('idle');
    return;
  }
  // We don't have the original ctx after the function returned. The
  // simplest retry surface is to re-execute by dispatching an event the
  // caller listens for; index.ts re-derives ctx from current docState and
  // calls executeSubmit() again. This avoids stale-snapshot bugs.
  window.dispatchEvent(new CustomEvent('submit:retry-requested', {
    detail: { submitId: pendingSubmitId, destination: pendingDestination },
  }));
}

// ─── Timeout watcher ───────────────────────────────────────────────────────

function startTimeoutTimer(): void {
  cancelTimeoutTimer();
  timeoutTimerId = window.setTimeout(() => {
    timeoutTimerId = null;
    if (currentState === 'sent_unconfirmed') {
      lastFailure = { kind: 'timeout' };
      transition('timeout');
    }
  }, SENT_UNCONFIRMED_TIMEOUT_MS);
}

function cancelTimeoutTimer(): void {
  if (timeoutTimerId !== null) {
    window.clearTimeout(timeoutTimerId);
    timeoutTimerId = null;
  }
}

// ─── Destination picker ────────────────────────────────────────────────────

let pickerResolver: ((r: PickResult) => void) | null = null;
let pickerSelected: string | null = null;
let pickerOptions: PickerOption[] = [];
let pickerGasTownEnabled = true;

interface PickerOption {
  id: string;
  label: string;
  description: string;
  /** "rig" / "reviewer" / "pick" — pick is the input form. */
  kind: 'reviewer' | 'rig' | 'pick';
  disabled?: boolean;
  disabledReason?: string;
}

function wirePicker(): void {
  if (!opts) return;
  const { picker } = opts;
  picker.closeBtn.addEventListener('click', () => { closePicker({ picked: false, destination: '' }); });
  picker.root.addEventListener('click', (e) => {
    if (e.target === picker.root) closePicker({ picked: false, destination: '' });
  });
  picker.list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.dest-picker-row');
    if (!row || row.classList.contains('is-disabled')) return;
    const id = row.dataset.id;
    if (!id) return;
    selectPickerOption(id);
    // Single-click commit for non-input options; double-click would be nicer
    // but keystroke + Enter is the standard pattern.
  });
  picker.list.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.dest-picker-row');
    if (!row || row.classList.contains('is-disabled')) return;
    const id = row.dataset.id;
    if (id && id !== 'pick') confirmPickerSubmit(id);
  });
  picker.submitBtn.addEventListener('click', () => {
    if (pickerSelected === 'pick') {
      const custom = picker.custom.value.trim();
      if (!custom) {
        flashHint('Enter a rig-id (e.g., report-engine/anthony).');
        return;
      }
      confirmPickerSubmit(custom);
      return;
    }
    if (pickerSelected) confirmPickerSubmit(pickerSelected);
  });
  picker.custom.addEventListener('input', () => {
    if (pickerSelected === 'pick') {
      opts!.picker.submitBtn.disabled = picker.custom.value.trim().length === 0;
    }
  });
  picker.custom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && pickerSelected === 'pick') {
      e.preventDefault();
      const custom = picker.custom.value.trim();
      if (custom) confirmPickerSubmit(custom);
    } else if (e.key === 'Escape') {
      closePicker({ picked: false, destination: '' });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (picker.root.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker({ picked: false, destination: '' });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepPickerSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && pickerSelected && pickerSelected !== 'pick') {
      e.preventDefault();
      confirmPickerSubmit(pickerSelected);
    }
  });
}

async function openDestinationPicker(ctx: SubmitContext): Promise<PickResult> {
  if (!opts) return { picked: false, destination: '' };
  pickerGasTownEnabled = ctx.gasTownEnabled;
  pickerOptions = buildPickerOptions(ctx);

  // Default selection: last-used for this doc if still present, else
  // Reviewer-local (first option). Falls back to first enabled if the
  // remembered choice is gone.
  const initial = pickerOptions.find((o) => o.id === ctx.lastDestinationForDoc && !o.disabled)
              ?? pickerOptions.find((o) => o.id === REVIEWER_LOCAL_ID && !o.disabled)
              ?? pickerOptions.find((o) => !o.disabled);
  pickerSelected = initial?.id ?? null;

  renderPickerOptions();
  opts.picker.root.hidden = false;
  opts.picker.custom.value = '';
  opts.picker.hint.textContent = '';
  // Focus the list so arrow keys work immediately.
  (opts.picker.list.querySelector<HTMLElement>('.dest-picker-row.is-selected') ?? opts.picker.list)
    .focus({ preventScroll: true });
  opts.picker.submitBtn.disabled = pickerSelected === 'pick'
    ? opts.picker.custom.value.trim().length === 0
    : pickerSelected === null;

  return new Promise<PickResult>((resolve) => {
    pickerResolver = resolve;
  });
}

function buildPickerOptions(ctx: SubmitContext): PickerOption[] {
  const out: PickerOption[] = [];
  // Reviewer-local is always first per spec §10.5. Always enabled; even
  // without gas-town the rig falls back to a plain pty (L3 discussion only).
  out.push({
    id: REVIEWER_LOCAL_ID,
    label: '📨 Reviewer (local)',
    description: 'talk only — no source edits, L1/L2 → needs-followup',
    kind: 'reviewer',
  });
  // Recently-used rigs, deduped + skipping reviewer-local. Gated on gas-town
  // (without gt, no rig destination can possibly receive the sling).
  const seen = new Set<string>([REVIEWER_LOCAL_ID]);
  for (const rig of ctx.recentRigs) {
    if (seen.has(rig)) continue;
    seen.add(rig);
    out.push({
      id: rig,
      label: `⛏️ ${rig}`,
      description: 'full processing — source access + LaTeX engine if available',
      kind: 'rig',
      disabled: !ctx.gasTownEnabled,
      disabledReason: !ctx.gasTownEnabled ? 'gas-town disabled' : undefined,
    });
  }
  // "Pick another rig…" — input footer, gated on gas-town.
  out.push({
    id: 'pick',
    label: '⚙️ Pick another rig…',
    description: ctx.gasTownEnabled
      ? 'type an arbitrary rig-id below'
      : 'requires gas-town (gt) on PATH',
    kind: 'pick',
    disabled: !ctx.gasTownEnabled,
    disabledReason: !ctx.gasTownEnabled ? 'install gas-town to enable' : undefined,
  });
  return out;
}

function renderPickerOptions(): void {
  if (!opts) return;
  const list = opts.picker.list;
  list.replaceChildren();
  for (const o of pickerOptions) {
    const row = document.createElement('li');
    row.className = 'dest-picker-row';
    row.dataset.id = o.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'option');
    if (o.disabled) row.classList.add('is-disabled');
    if (o.id === pickerSelected) row.classList.add('is-selected');
    const name = document.createElement('span');
    name.className = 'dest-picker-row-name';
    name.textContent = o.label;
    const desc = document.createElement('span');
    desc.className = 'dest-picker-row-desc';
    desc.textContent = o.disabled && o.disabledReason
      ? `${o.description} · (${o.disabledReason})`
      : o.description;
    row.append(name, desc);
    list.append(row);
  }
  // Show / hide the custom input based on whether `pick` is currently
  // selected. Disabled state shadows enabled when gas-town is off.
  opts.picker.custom.hidden = pickerSelected !== 'pick';
  opts.picker.custom.disabled = !pickerGasTownEnabled;
}

function selectPickerOption(id: string): void {
  if (!opts) return;
  const opt = pickerOptions.find((o) => o.id === id);
  if (!opt || opt.disabled) return;
  pickerSelected = id;
  // Re-render to update the selected highlight and toggle the input.
  for (const row of opts.picker.list.querySelectorAll<HTMLElement>('.dest-picker-row')) {
    row.classList.toggle('is-selected', row.dataset.id === id);
  }
  const showCustom = id === 'pick';
  opts.picker.custom.hidden = !showCustom;
  if (showCustom) {
    opts.picker.custom.focus();
    opts.picker.submitBtn.disabled = opts.picker.custom.value.trim().length === 0;
  } else {
    opts.picker.submitBtn.disabled = false;
  }
}

function stepPickerSelection(dir: 1 | -1): void {
  const enabled = pickerOptions.filter((o) => !o.disabled);
  if (enabled.length === 0) return;
  const idx = enabled.findIndex((o) => o.id === pickerSelected);
  const next = idx === -1
    ? (dir === 1 ? 0 : enabled.length - 1)
    : Math.max(0, Math.min(enabled.length - 1, idx + dir));
  selectPickerOption(enabled[next].id);
}

function confirmPickerSubmit(destination: string): void {
  closePicker({ picked: true, destination });
}

function closePicker(result: PickResult): void {
  if (!opts) return;
  opts.picker.root.hidden = true;
  pickerSelected = null;
  if (pickerResolver) {
    const r = pickerResolver;
    pickerResolver = null;
    r(result);
  }
}

function flashHint(msg: string): void {
  if (!opts) return;
  const hint = opts.picker.hint;
  hint.textContent = msg;
  window.setTimeout(() => {
    if (hint.textContent === msg) hint.textContent = '';
  }, 3000);
}

function labelForDestination(destination: string): string {
  return destination === REVIEWER_LOCAL_ID ? 'Reviewer (local)' : destination;
}

// ─── Public capability check (concurrent-round lock helper) ────────────────

/** True iff Submit can fire right now from the renderer's perspective. The
 *  caller also checks the docState.rounds concurrent-round lock. */
export function canFire(): boolean {
  return currentState === 'idle'
      || currentState === 'send_failed'
      || currentState === 'complete'
      || currentState === 'complete-failed';
}
