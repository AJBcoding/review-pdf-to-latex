import { describe, expect, it, vi } from 'vitest';
import { SubmitMachine } from './submit-machine.js';
import type { SubmitMachineDeps, StartRequest } from './submit-machine.js';
import type {
  SubmitFile,
  SubmitPromoteResult,
  SubmitSlingRequest,
  SubmitSlingResult,
} from '@shared/comments.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeStartRequest(): StartRequest {
  return {
    promoteRequest: {
      sourcePath: '/docs/report-1.0.pdf',
      sourceSha256: 'abc123',
      sourceFileVersion: '1.0',
      bundlePdfPath: '/docs/bundle.pdf',
      bundleJsonPath: '/docs/bundle.json',
      originRig: 'report-engine/anthony',
      comments: [{ id: 'c1', status: 'open' } as never],
      author: 'AJB',
    },
    destination: 'report-engine/anthony',
    bundleId: '20260613-090000',
    bundlePdfPath: '/docs/bundle.pdf',
    bundleJsonPath: '/docs/bundle.json',
    appVersion: '0.0.1',
    originRig: 'report-engine/anthony',
  };
}

const SUBMIT_ID = '20260613-090001';

function makePromoteOk(submitId = SUBMIT_ID): SubmitPromoteResult {
  const submitFile = {
    schema_version: 1,
    submit_id: submitId,
    doc_id: '/docs/report-1.0.pdf',
    doc_version: 'abc123',
    source_file_version: '1.0',
    submitted_at: '2026-06-13T09:00:01Z',
    origin_rig: 'report-engine/anthony',
    comments: [],
  } satisfies SubmitFile;
  return {
    ok: true,
    submitId,
    submitFilePath: `/docs/.review-state/submit-${submitId}.json`,
    submitFile,
    statusUpdates: [{ commentId: 'c1', submittedAt: '2026-06-13T09:00:01Z' }],
  };
}

const SLING_OK: SubmitSlingResult = {
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  payload: '{}',
  subject: 'review-pdf submit · report-1.0 · 20260613-090000',
};

const SLING_GT_FAILED: SubmitSlingResult = {
  ok: false,
  reason: 'gt_failed',
  exitCode: 1,
  stdout: '',
  stderr: 'rig not found',
};

/** Build a machine with mock deps. The sling mock is programmable per-call so
 *  tests can fail the first attempt and succeed the retry. */
function makeMachine(slingResults: SubmitSlingResult[], promote?: SubmitPromoteResult) {
  const slingRequests: SubmitSlingRequest[] = [];
  let slingCall = 0;
  const promoteFn = vi.fn(async () => promote ?? makePromoteOk());
  const slingFn = vi.fn(async (req: SubmitSlingRequest) => {
    slingRequests.push(req);
    const r = slingResults[Math.min(slingCall, slingResults.length - 1)];
    slingCall += 1;
    return r;
  });
  const onCommentsPromoted = vi.fn();
  const onPendingRound = vi.fn();
  const startTimeout = vi.fn();
  const cancelTimeout = vi.fn();
  const deps: SubmitMachineDeps = {
    promote: promoteFn,
    sling: slingFn,
    onCommentsPromoted,
    onPendingRound,
    startTimeout,
    cancelTimeout,
  };
  const machine = new SubmitMachine(deps);
  return {
    machine,
    promoteFn,
    slingFn,
    slingRequests,
    onCommentsPromoted,
    onPendingRound,
    startTimeout,
    cancelTimeout,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('SubmitMachine — happy path', () => {
  it('promotes, slings, and flips comments only after a successful sling', async () => {
    const h = makeMachine([SLING_OK]);
    await h.machine.start(makeStartRequest());

    expect(h.machine.getState()).toBe('sent_unconfirmed');
    expect(h.promoteFn).toHaveBeenCalledTimes(1);
    expect(h.slingFn).toHaveBeenCalledTimes(1);
    // rev-n6: the live-draft flip fires exactly once, after the sling lands.
    expect(h.onCommentsPromoted).toHaveBeenCalledTimes(1);
    expect(h.onCommentsPromoted).toHaveBeenCalledWith([
      { commentId: 'c1', submittedAt: '2026-06-13T09:00:01Z' },
    ]);
    expect(h.onPendingRound).toHaveBeenCalledWith({
      submitId: SUBMIT_ID,
      destination: 'report-engine/anthony',
    });
    expect(h.startTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('SubmitMachine — failed sling leaves comments open (rev-n6)', () => {
  it('does not flip comments when the sling fails, and retries against the SAME submit without re-promoting', async () => {
    const h = makeMachine([SLING_GT_FAILED, SLING_OK]);
    await h.machine.start(makeStartRequest());

    // First attempt failed: comments must remain `open` (no flip dispatched).
    expect(h.machine.getState()).toBe('send_failed');
    expect(h.onCommentsPromoted).not.toHaveBeenCalled();
    expect(h.machine.canRetry()).toBe(true);

    // Retry re-slings the cached round — no second promote.
    const did = await h.machine.resling();
    expect(did).toBe(true);
    expect(h.machine.getState()).toBe('sent_unconfirmed');
    expect(h.promoteFn).toHaveBeenCalledTimes(1); // never re-promoted
    expect(h.slingFn).toHaveBeenCalledTimes(2);
    // Same frozen submit file + submit_id on the retry.
    expect(h.slingRequests[0].submitId).toBe(SUBMIT_ID);
    expect(h.slingRequests[1].submitId).toBe(SUBMIT_ID);
    expect(h.slingRequests[1].submitFilePath).toBe(h.slingRequests[0].submitFilePath);
    // Now that delivery landed, the flip fires.
    expect(h.onCommentsPromoted).toHaveBeenCalledTimes(1);
  });
});

describe('SubmitMachine — timeout then re-sling uses the SAME submit_id (rev-n6)', () => {
  it('re-slings the cached round after a timeout without minting a new round', async () => {
    const h = makeMachine([SLING_OK, SLING_OK]);
    await h.machine.start(makeStartRequest());
    expect(h.machine.getState()).toBe('sent_unconfirmed');

    h.machine.notifyTimeout();
    expect(h.machine.getState()).toBe('timeout');
    expect(h.machine.canRetry()).toBe(true);
    expect(h.machine.canFire()).toBe(false); // no fresh round from timeout

    const did = await h.machine.resling();
    expect(did).toBe(true);
    expect(h.machine.getState()).toBe('sent_unconfirmed');
    expect(h.promoteFn).toHaveBeenCalledTimes(1); // SAME round, no re-promote
    expect(h.slingFn).toHaveBeenCalledTimes(2);
    expect(h.slingRequests[1].submitId).toBe(h.slingRequests[0].submitId);
  });
});

describe('SubmitMachine — capability predicates', () => {
  it('canFire excludes timeout; canRetry covers timeout + send_failed only', async () => {
    const h = makeMachine([SLING_OK]);
    expect(h.machine.canFire()).toBe(true); // idle
    expect(h.machine.canRetry()).toBe(false);

    await h.machine.start(makeStartRequest()); // sent_unconfirmed
    expect(h.machine.canFire()).toBe(false);
    expect(h.machine.canRetry()).toBe(false);

    h.machine.notifyTimeout();
    expect(h.machine.canRetry()).toBe(true);
    expect(h.machine.canFire()).toBe(false);
  });

  it('promote failure surfaces send_failed and never slings', async () => {
    const promoteFail: SubmitPromoteResult = {
      ok: false,
      reason: 'write_failed',
      error: 'disk full',
      submitFilePath: '/docs/.review-state/submit-x.json',
    };
    const h = makeMachine([SLING_OK], promoteFail);
    await h.machine.start(makeStartRequest());
    expect(h.machine.getState()).toBe('send_failed');
    expect(h.slingFn).not.toHaveBeenCalled();
    expect(h.onCommentsPromoted).not.toHaveBeenCalled();
    // No cached round → nothing to re-sling.
    expect(h.machine.canRetry()).toBe(false);
    expect(await h.machine.resling()).toBe(false);
  });
});

describe('SubmitMachine — resume lifecycle', () => {
  it('keeps the cached round across acknowledge so a stall can be resumed', async () => {
    const h = makeMachine([SLING_OK, SLING_OK]);
    await h.machine.start(makeStartRequest());

    // Rig wrote a first results file → acknowledged → pill goes quiet (idle)
    // but the round is still live, so Resume must remain available.
    h.machine.markAcknowledged(SUBMIT_ID);
    expect(h.machine.getState()).toBe('idle');
    expect(h.machine.canResume()).toBe(true);

    const did = await h.machine.resling();
    expect(did).toBe(true);
    expect(h.slingRequests[1].submitId).toBe(SUBMIT_ID); // same round
    expect(h.promoteFn).toHaveBeenCalledTimes(1);
  });

  it('drops the cached round on round completion so Resume cannot re-fire', async () => {
    const h = makeMachine([SLING_OK]);
    await h.machine.start(makeStartRequest());
    h.machine.markAcknowledged(SUBMIT_ID);
    h.machine.markRoundComplete(SUBMIT_ID, true);

    expect(h.machine.getState()).toBe('complete');
    expect(h.machine.canResume()).toBe(false);
    expect(await h.machine.resling()).toBe(false);
  });

  it('reset drops everything (doc switch)', async () => {
    const h = makeMachine([SLING_OK]);
    await h.machine.start(makeStartRequest());
    h.machine.reset();
    expect(h.machine.getState()).toBe('idle');
    expect(h.machine.canResume()).toBe(false);
    expect(h.cancelTimeout).toHaveBeenCalled();
  });
});
