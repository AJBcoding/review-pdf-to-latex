// §10.1 Submit flow — pure state machine (rev-n6 extraction).
//
// This module owns the Submit *lifecycle* with zero DOM coupling so the
// unhappy paths (retry / resume / compensation) can be exercised under
// vitest. The DOM adapter (submit.ts) constructs one of these, feeds it the
// promote/sling effects + UI callbacks, and renders on every state change.
//
// rev-n6 fixes, all enforced here so a test can prove them:
//   - Retry / Re-sling / Resume re-send the SAME submit_id against the
//     cached frozen submit file — no re-promote, no destination picker, no
//     duplicate round. (`resling()` operates on `cached`.)
//   - The per-comment "submitted" flip onto the live drafts only fires
//     AFTER a sling succeeds (`onCommentsPromoted`). A failed sling leaves
//     the drafts `open` so the user can retry without stranding comments
//     in a permanently-submitted state.
//   - The cached round survives `markAcknowledged` so a stalled round can be
//     resumed (re-slung) until it actually completes / is abandoned.

import type {
  CommentPayload,
  SubmitPromoteRequest,
  SubmitPromoteResult,
  SubmitSlingRequest,
  SubmitSlingResult,
} from '@shared/types';

export type SubmitState =
  | 'idle'
  | 'pending_send'
  | 'sent_unconfirmed'
  | 'timeout'
  | 'send_failed'
  | 'complete'
  | 'complete-failed';

export interface SubmitFailure {
  kind: 'send_failed' | 'timeout';
  reason: string;
  stderr: string;
}

/** Per-comment status flip the promote step computed. Mirrored onto the
 *  live drafts only once a sling lands. */
export type StatusUpdate = { commentId: string; submittedAt: string };

/** Everything needed to re-sling a round WITHOUT re-promoting. Cached at the
 *  moment of a successful promote and kept until the round completes, is
 *  abandoned, or the doc is switched. The frozen `slingRequest.submitFilePath`
 *  + `slingRequest.submitId` are what make retry/resume idempotent. */
export interface CachedRound {
  submitId: string;
  destination: string;
  slingRequest: SubmitSlingRequest;
  statusUpdates: StatusUpdate[];
}

/** Fresh-submit inputs. The adapter resolves the destination (picker or
 *  origin) before calling `start`; the bundle metadata rides along so the
 *  machine can assemble the sling request once promote returns the ids. */
export interface StartRequest {
  promoteRequest: SubmitPromoteRequest;
  destination: string;
  bundleId: string;
  bundlePdfPath: string;
  bundleJsonPath: string;
  appVersion: string;
  originRig: string | null;
}

export interface SubmitMachineDeps {
  promote(req: SubmitPromoteRequest): Promise<SubmitPromoteResult>;
  sling(req: SubmitSlingRequest): Promise<SubmitSlingResult>;
  /** Mirror the per-comment `submitted` flip onto the live drafts. Called
   *  ONLY after a sling succeeds — never on a failed/aborted sling. */
  onCommentsPromoted?(updates: StatusUpdate[]): void;
  /** Fired on every state transition so the adapter can re-render. */
  onStateChanged?(state: SubmitState): void;
  /** Fired when a round enters `sent_unconfirmed` (fresh or re-slung). */
  onPendingRound?(p: { submitId: string; destination: string }): void;
  /** Start / cancel the 10-minute sent_unconfirmed watchdog. The timer
   *  itself lives in the adapter (window.setTimeout → notifyTimeout). */
  startTimeout?(): void;
  cancelTimeout?(): void;
}

/** Translate a sling failure into a banner-ready failure record. Mirrors the
 *  reason switch the renderer used before the extraction; kept here so the
 *  copy lives next to the state it drives. */
export function describeSlingFailure(
  r: Exclude<SubmitSlingResult, { ok: true }>,
): SubmitFailure {
  switch (r.reason) {
    case 'no_gt':
      return { kind: 'send_failed', reason: 'gas-town disabled', stderr: r.message };
    case 'spawn_failed':
      return { kind: 'send_failed', reason: 'spawn failed', stderr: r.error };
    case 'timeout':
      return {
        kind: 'send_failed',
        reason: `gt mail timed out after ${r.timeoutMs}ms`,
        stderr:
          'gt mail send did not exit within the local deadline. The mailbox may or may not have received the payload — check `gt mail outbox` manually before re-slinging.',
      };
    case 'gt_failed': {
      const lines: string[] = [];
      if (r.stdout) lines.push(`[stdout]\n${r.stdout.trim()}`);
      if (r.stderr) lines.push(`[stderr]\n${r.stderr.trim()}`);
      if (lines.length === 0) lines.push('(no output from gt)');
      return {
        kind: 'send_failed',
        reason: `gt mail exit ${r.exitCode ?? '?'}`,
        stderr: lines.join('\n\n'),
      };
    }
  }
}

export class SubmitMachine {
  private state: SubmitState = 'idle';
  private failure: SubmitFailure | null = null;
  private cached: CachedRound | null = null;

  constructor(private readonly deps: SubmitMachineDeps) {}

  getState(): SubmitState {
    return this.state;
  }

  getFailure(): SubmitFailure | null {
    return this.failure;
  }

  getDestination(): string | null {
    return this.cached?.destination ?? null;
  }

  getPendingSubmitId(): string | null {
    return this.cached?.submitId ?? null;
  }

  /** In-flight states block a fresh Submit (concurrent-round guard). Includes
   *  `timeout`: a timed-out round is unresolved, so a fresh round can't start
   *  — but it CAN be re-slung (see `resling`). */
  isInFlight(): boolean {
    return (
      this.state === 'pending_send' ||
      this.state === 'sent_unconfirmed' ||
      this.state === 'timeout'
    );
  }

  /** True while a sling is actively running or awaiting first pickup — the
   *  two states where re-slinging would race an in-flight delivery. Narrower
   *  than `isInFlight` (which also blocks on the resolvable `timeout`). */
  private isSending(): boolean {
    return this.state === 'pending_send' || this.state === 'sent_unconfirmed';
  }

  /** True when a fresh round may be started (Cmd+Return promotes a new
   *  submit_id). Deliberately excludes `timeout`: from there the user must
   *  re-sling the existing round, not mint a new one. */
  canFire(): boolean {
    return (
      this.state === 'idle' ||
      this.state === 'send_failed' ||
      this.state === 'complete' ||
      this.state === 'complete-failed'
    );
  }

  /** True when Cmd+Return should route to a re-sling rather than a fresh
   *  submit: a delivery failed (`send_failed`) or the rig never acked
   *  (`timeout`) and we still hold the cached round. */
  canRetry(): boolean {
    return (
      this.cached !== null &&
      (this.state === 'send_failed' || this.state === 'timeout')
    );
  }

  /** True when the round-banner Resume can re-sling the cached round. Covers
   *  `canRetry()` plus the acknowledged-but-stalled case (state back to
   *  `idle` after the rig wrote a first results file, then went quiet). */
  canResume(): boolean {
    return this.cached !== null && !this.isSending();
  }

  /** Fresh submit: promote → cache → sling. The flip onto live drafts is
   *  deferred to a successful sling inside `doSling`. */
  async start(req: StartRequest): Promise<void> {
    if (this.isInFlight()) return;
    const promote = await this.deps.promote(req.promoteRequest);
    if (!promote.ok) {
      this.fail({
        kind: 'send_failed',
        reason: `promote: ${promote.reason}`,
        stderr: promote.error,
      });
      return;
    }
    const slingRequest: SubmitSlingRequest = {
      destinationRig: req.destination,
      originRig: req.originRig,
      submitId: promote.submitId,
      bundleId: req.bundleId,
      sourcePath: req.promoteRequest.sourcePath,
      submitFilePath: promote.submitFilePath,
      bundlePdfPath: req.bundlePdfPath,
      bundleJsonPath: req.bundleJsonPath,
      appVersion: req.appVersion,
    };
    this.cached = {
      submitId: promote.submitId,
      destination: req.destination,
      slingRequest,
      statusUpdates: promote.statusUpdates,
    };
    await this.doSling();
  }

  /** Re-sling the cached round: SAME submit_id, SAME frozen submit file, no
   *  re-promote and no picker. Backs Retry, Re-sling, and Resume. Returns
   *  false when there is nothing to re-sling or a sling is already running. */
  async resling(): Promise<boolean> {
    if (!this.cached || this.isSending()) return false;
    this.deps.cancelTimeout?.();
    await this.doSling();
    return true;
  }

  /** Shared sling driver. Assumes `this.cached` is set. */
  private async doSling(): Promise<void> {
    const cached = this.cached;
    if (!cached) return;
    this.setState('pending_send');
    const result = await this.deps.sling(cached.slingRequest);
    if (result.ok) {
      // rev-n6: only now that delivery landed do we flip the live drafts to
      // `submitted`. A failed sling above leaves them `open`.
      this.deps.onCommentsPromoted?.(cached.statusUpdates);
      this.setState('sent_unconfirmed');
      this.deps.onPendingRound?.({
        submitId: cached.submitId,
        destination: cached.destination,
      });
      this.deps.startTimeout?.();
      return;
    }
    this.fail(describeSlingFailure(result));
  }

  /** Watchdog fired (10 min in `sent_unconfirmed` with no results file). */
  notifyTimeout(): void {
    if (this.state !== 'sent_unconfirmed') return;
    this.failure = { kind: 'timeout', reason: 'timeout', stderr: '' };
    this.setState('timeout');
  }

  /** Results-watcher saw the first results-*.json for our submit_id. We go
   *  quiet (round banner takes over) but KEEP the cached round so a later
   *  stall can be resumed. */
  markAcknowledged(submitId: string): void {
    if (this.cached?.submitId !== submitId) return;
    if (this.state !== 'sent_unconfirmed' && this.state !== 'timeout') return;
    this.deps.cancelTimeout?.();
    this.setState('idle');
  }

  /** Results-watcher saw round_status flip to complete/failed. The round is
   *  done — drop the cached round so Resume can't re-fire it. */
  markRoundComplete(submitId: string, succeeded: boolean): void {
    if (this.cached !== null && this.cached.submitId !== submitId) return;
    this.deps.cancelTimeout?.();
    this.cached = null;
    this.setState(succeeded ? 'complete' : 'complete-failed');
  }

  /** Hide the pill/banner without dropping the cached round — the rig may
   *  still be processing it, so Resume must stay available. Used by the
   *  banner Dismiss buttons. */
  dismiss(): void {
    this.deps.cancelTimeout?.();
    this.setState('idle');
  }

  /** Doc switch / explicit clear. Drops everything. */
  reset(): void {
    this.deps.cancelTimeout?.();
    this.cached = null;
    this.failure = null;
    this.setState('idle');
  }

  private fail(f: SubmitFailure): void {
    this.failure = f;
    this.setState(f.kind === 'timeout' ? 'timeout' : 'send_failed');
  }

  private setState(next: SubmitState): void {
    if (next === this.state) return;
    this.state = next;
    // Reaching `idle` clears the transient failure, but NOT the cached round:
    // markAcknowledged lands us in `idle` while a round is still live on the
    // rig, and Resume must still be able to re-sling it.
    if (next === 'idle') this.failure = null;
    this.deps.onStateChanged?.(next);
  }
}

/** Re-export for the adapter's typing convenience. */
export type { CommentPayload };
