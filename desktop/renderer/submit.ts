// §10.1 Submit flow — renderer-side adapter + destination picker.
//
// Co-owns the Submit lifecycle with rev-1md.5 (results-watcher). Roles:
//
//  This module:
//   - Owns the DOM: drives the pill + banner UI and the destination picker
//     modal (§10.5), and the 10-minute sent_unconfirmed watchdog timer.
//   - Translates UI events into SubmitMachine calls and re-renders on every
//     state change. The lifecycle logic itself lives in submit-machine.ts
//     (rev-n6 extraction) so the unhappy paths are unit-testable.
//
//  rev-1md.5 results-watcher (in index.ts):
//   - Drives the acknowledged / processing / complete transitions via the
//     results-file watcher. We expose `markAcknowledged()` / `markRoundComplete()`
//     so the watcher can pull our local pill out of `sent_unconfirmed`.
//
//  The two halves talk through this module's exported handles; we don't
//  reach back into index.ts. Same pattern as claude-pane.ts.
//
// rev-n6: Retry / Re-sling / Resume all funnel through `resling()`, which
// re-sends the SAME submit_id against the cached frozen submit file (no
// re-promote, no picker, no duplicate round). The per-comment `submitted`
// flip is deferred to a successful sling so a failed delivery never strands
// comments in a permanently-submitted state.

import { REVIEWER_LOCAL_ID } from '@shared/comments';
import type { CommentPayload, SubmitFile, SubmitSlingRequest } from '@shared/comments';
import { SubmitMachine } from './submit-machine.js';
import type { SubmitState, StatusUpdate, CachedRound } from './submit-machine.js';

// ─── Public surface ────────────────────────────────────────────────────────

export type { SubmitState };

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
let machine: SubmitMachine | null = null;
let timeoutTimerId: number | null = null;

/** §10.1 timing constants — values quoted verbatim from rev-2k7 / spec
 *  §10.1 step 4. Tuned to the spec; do not edit without re-checking. */
const SENT_UNCONFIRMED_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min
const COMPLETE_AUTOCLEAR_MS = 5_000;

function getMachine(): SubmitMachine {
  if (!machine) {
    machine = new SubmitMachine({
      promote: (req) => window.electronAPI.submitPromote(req),
      sling: (req) => window.electronAPI.submitSling(req),
      onCommentsPromoted: (updates: StatusUpdate[]) => {
        // Mirror the per-comment "submitted" status flips back onto the live
        // drafts (right-drawer badges). rev-n6: this fires only after a sling
        // lands, so a failed delivery leaves the drafts `open`.
        window.dispatchEvent(new CustomEvent('submit:comments-promoted', {
          detail: { updates },
        }));
      },
      onStateChanged: () => { renderPill(); renderBanner(); },
      onPendingRound: (p) => { opts?.onPendingRound?.(p); },
      startTimeout: startTimeoutTimer,
      cancelTimeout: cancelTimeoutTimer,
    });
  }
  return machine;
}

export function mount(o: SubmitMountOptions): void {
  opts = o;
  getMachine();
  wirePicker();
  renderPill();
  renderBanner();
}

export function getState(): SubmitState {
  return getMachine().getState();
}

/** True when Submit should be disabled — the concurrent-round lock from
 *  §10.1 step 6 lives outside this module (it tests docState.rounds for
 *  in_progress), but the in-flight states also disable Submit. Combine
 *  both into a single helper for callers. */
export function isInFlight(): boolean {
  return getMachine().isInFlight();
}

/** Called by the results-watcher (rev-1md.5) when the first results-*.json
 *  for our pending submit_id appears. Transitions out of sent_unconfirmed,
 *  cancels the 10-minute timeout watcher. The cached round is kept so a
 *  later stall can still be resumed. */
export function markAcknowledged(submitId: string): void {
  getMachine().markAcknowledged(submitId);
}

/** Called by the results-watcher when a results file flips to
 *  round_status:complete for our pending submit. Shows a brief toast-style
 *  pill then auto-clears. */
export function markRoundComplete(submitId: string, succeeded: boolean): void {
  getMachine().markRoundComplete(submitId, succeeded);
  // Auto-clear after the spec's 5s window unless the user moves on.
  window.setTimeout(() => {
    const state = getMachine().getState();
    if (state === 'complete' || state === 'complete-failed') {
      getMachine().reset();
    }
  }, COMPLETE_AUTOCLEAR_MS);
}

/** Reset everything — used on doc switch so the prior doc's pill doesn't
 *  bleed into the new doc. */
export function reset(): void {
  getMachine().reset();
}

/** Main entry point. Resolve destination → promote → sling → drive the
 *  state machine. The caller (Cmd+Return handler) is responsible for
 *  writeBundle() first; we expect the bundle paths in the context. */
export async function executeSubmit(ctx: SubmitContext): Promise<void> {
  const m = getMachine();
  if (m.isInFlight()) {
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

  await m.start({
    promoteRequest: {
      sourcePath: ctx.sourcePath,
      sourceSha256: ctx.sourceSha256,
      sourceFileVersion: ctx.sourceFileVersion,
      bundlePdfPath: ctx.bundlePdfPath,
      bundleJsonPath: ctx.bundleJsonPath,
      bundleId: ctx.bundleId,
      destination,
      originRig: ctx.originRig,
      comments: ctx.submittedComments,
      author: ctx.author,
    },
    destination,
    bundleId: ctx.bundleId,
    bundlePdfPath: ctx.bundlePdfPath,
    bundleJsonPath: ctx.bundleJsonPath,
    appVersion: ctx.appVersion,
    originRig: ctx.originRig,
  });
}

/** Re-sling the cached round (same submit_id, frozen submit file). Backs the
 *  Retry banner button, the timeout Re-sling button, and the round-banner
 *  Resume button — rev-n6's "wire Resume to the same entry". Returns false if
 *  there is no cached round to re-sling (e.g., after an app restart). */
export async function resling(): Promise<boolean> {
  const did = await getMachine().resling();
  if (!did) {
    flashHint('No round to re-sling — press Cmd+Return to start a fresh one.');
  }
  return did;
}

/** True iff a cached round can be resumed/re-slung right now. Lets the
 *  round-banner Resume button decide whether to re-sling in-session or fall
 *  back to guidance. */
export function canResume(): boolean {
  return getMachine().canResume();
}

/** rev-7cg — rebuild the cached round from the on-disk submit file the
 *  results-watcher already read, so the round-banner Resume works after an app
 *  restart (the in-memory cache is gone on a fresh launch). `submitFilePath` is
 *  the frozen `submit-<id>.json` the re-sling re-sends; `appVersion` is the
 *  CURRENT running app's version (the re-sling is a new delivery from this
 *  process, not a replay of the old payload).
 *
 *  Returns false — leaving the banner's Cmd+Return hint in place — when the
 *  round can't be rehydrated: a sling is already in flight / a live round is
 *  cached, or the submit file predates rev-7cg and lacks the resume metadata
 *  (`bundle_id` / `destination_rig`) the sling payload requires. */
export function rehydrateRound(
  submit: SubmitFile,
  submitFilePath: string,
  appVersion: string,
): boolean {
  const destination = submit.destination_rig;
  const bundleId = submit.bundle_id;
  if (!destination || !bundleId) return false;
  // Prefer the generalized v2 paths; fall back to the v1 PDF aliases.
  const bundlePdfPath = submit.native_artifact_path ?? submit.bundle_pdf;
  const bundleJsonPath = submit.sidecar_json_path ?? submit.bundle_json;
  if (!bundlePdfPath || !bundleJsonPath) return false;

  const slingRequest: SubmitSlingRequest = {
    destinationRig: destination,
    originRig: submit.origin_rig,
    submitId: submit.submit_id,
    bundleId,
    sourcePath: submit.doc_id,
    submitFilePath,
    bundlePdfPath,
    bundleJsonPath,
    appVersion,
  };
  const cached: CachedRound = {
    submitId: submit.submit_id,
    destination,
    slingRequest,
    // The comments were flipped to `submitted` (and persisted) at the original
    // submit; the reloaded drafts already reflect that, so there is nothing to
    // re-flip on the re-sling.
    statusUpdates: [],
  };
  const ok = getMachine().rehydrate(cached);
  if (ok) { renderPill(); renderBanner(); }
  return ok;
}

// ─── Pill ──────────────────────────────────────────────────────────────────

function renderPill(): void {
  if (!opts) return;
  const m = getMachine();
  const state = m.getState();
  const destinationLabel = m.getDestination() ? labelForDestination(m.getDestination()!) : null;
  const el = opts.pill;
  el.dataset.state = state;
  switch (state) {
    case 'idle':
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
      return;
    case 'pending_send':
      el.hidden = false;
      el.textContent = `Slinging to ${destinationLabel ?? 'rig'}…`;
      el.removeAttribute('title');
      return;
    case 'sent_unconfirmed':
      el.hidden = false;
      el.textContent = `Submitted to ${destinationLabel ?? 'rig'} — awaiting pickup`;
      el.removeAttribute('title');
      return;
    case 'timeout':
      el.hidden = false;
      el.textContent = `Still waiting on ${destinationLabel ?? 'rig'} (10 min)`;
      el.removeAttribute('title');
      return;
    case 'send_failed': {
      const failure = m.getFailure();
      el.hidden = false;
      el.textContent = `Submit failed`;
      el.setAttribute('title', failure?.kind === 'send_failed' ? failure.reason : 'unknown error');
      return;
    }
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
  const m = getMachine();
  const state = m.getState();
  const failure = m.getFailure();
  const destinationLabel = m.getDestination() ? labelForDestination(m.getDestination()!) : null;
  const banner = opts.banner;
  banner.replaceChildren();

  if (state === 'send_failed' && failure?.kind === 'send_failed') {
    banner.hidden = false;
    banner.setAttribute('data-severity', 'error');
    const head = document.createElement('div');
    head.className = 'submit-banner-head';
    const headText = document.createElement('strong');
    headText.textContent = `Submit failed: ${failure.reason}`;
    head.append(headText);
    const detail = document.createElement('pre');
    detail.className = 'submit-banner-detail';
    detail.textContent = failure.stderr;
    const actions = document.createElement('div');
    actions.className = 'submit-banner-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'is-primary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => { void resling(); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { m.reset(); });
    actions.append(retry, dismiss);
    banner.append(head, detail, actions);
    return;
  }

  if (state === 'timeout') {
    banner.hidden = false;
    banner.setAttribute('data-severity', 'warn');
    const head = document.createElement('div');
    head.className = 'submit-banner-head';
    const headText = document.createElement('strong');
    headText.textContent = `Still waiting on ${destinationLabel ?? 'the rig'} (10 min)`;
    head.append(headText);
    const detail = document.createElement('div');
    detail.className = 'submit-banner-detail';
    detail.textContent = `The rig hasn't written a results-*.json yet. The submission may have been received but not picked up — the rig session may need a nudge. Re-sling resends the same payload (same submit_id, no new round file).`;
    const actions = document.createElement('div');
    actions.className = 'submit-banner-actions';
    const reslingBtn = document.createElement('button');
    reslingBtn.type = 'button';
    reslingBtn.className = 'is-primary';
    reslingBtn.textContent = 'Re-sling';
    reslingBtn.addEventListener('click', () => { void resling(); opts?.onResling?.(); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    // Dismiss keeps the cached round (the rig may still be processing it), so
    // the round-banner Resume can re-sling later; it just hides the pill.
    dismiss.addEventListener('click', () => { m.dismiss(); });
    actions.append(reslingBtn, dismiss);
    banner.append(head, detail, actions);
    return;
  }

  banner.hidden = true;
  banner.removeAttribute('data-severity');
}

// ─── Timeout watcher ───────────────────────────────────────────────────────

function startTimeoutTimer(): void {
  cancelTimeoutTimer();
  timeoutTimerId = window.setTimeout(() => {
    timeoutTimerId = null;
    getMachine().notifyTimeout();
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

/** True iff a fresh Submit can fire right now from the renderer's
 *  perspective. The caller also checks the docState.rounds concurrent-round
 *  lock. Excludes `timeout` — from there the user re-slings, not re-submits. */
export function canFire(): boolean {
  return getMachine().canFire();
}

/** True iff Cmd+Return should route to a re-sling (same submit_id) rather
 *  than a fresh submit: a delivery failed or the rig never acked. */
export function canRetry(): boolean {
  return getMachine().canRetry();
}
