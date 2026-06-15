// Unit tests for the shared reviewer-probe module (X8 Stage 3.5).
//
// node:fs.existsSync and node:child_process.spawnSync are mocked so we drive
// probeReviewer's gt-presence + identity branches without touching the real
// PATH or spawning gt. The cache is reset between tests via the test seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn<(p: string) => boolean>();
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
}));

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const {
  whichSync,
  probeReviewer,
  reviewerEnvOverlay,
  _resetReviewerProbeCacheForTests,
} = await import('./reviewer-probe.js');

beforeEach(() => {
  _resetReviewerProbeCacheForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('whichSync', () => {
  it('returns the first PATH dir that holds the binary', () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/usr/local/bin';
    existsSyncMock.mockImplementation((p: string) => p === '/usr/local/bin/gt');
    expect(whichSync('gt')).toBe('/usr/local/bin/gt');
    process.env.PATH = prevPath;
  });

  it('returns null when the binary is not on PATH', () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/usr/bin';
    existsSyncMock.mockReturnValue(false);
    expect(whichSync('gt')).toBeNull();
    process.env.PATH = prevPath;
  });
});

describe('probeReviewer', () => {
  it('degrades to no_gt when gt is absent from PATH', () => {
    existsSyncMock.mockReturnValue(false);
    const r = probeReviewer();
    expect(r).toEqual({ enabled: false, reason: 'no_gt' });
    // gt never spawned when it isn't on PATH.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('degrades to gt_failed when `gt --version` exits non-zero', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '' });
    const r = probeReviewer();
    expect(r).toMatchObject({ enabled: false, reason: 'gt_failed', exitCode: 1 });
  });

  it('enables with version + best-effort identity when gt is healthy', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: 'gt 1.2.3\n' }) // --version
      .mockReturnValueOnce({ status: 0, stdout: 'reviewer/anthony\n' }); // whoami
    const r = probeReviewer();
    expect(r).toMatchObject({
      enabled: true,
      version: 'gt 1.2.3',
      identity: 'reviewer/anthony',
    });
  });

  it('stays enabled with null identity when `gt whoami` fails', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: 'gt 1.2.3\n' })
      .mockReturnValueOnce({ status: 1, stdout: '' });
    const r = probeReviewer();
    expect(r).toMatchObject({ enabled: true, identity: null });
  });

  it('uses a 2s timeout for the gt calls (no Dolt-blocking hang)', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'gt 1.2.3\n' });
    probeReviewer();
    for (const call of spawnSyncMock.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 2000 });
    }
  });

  it('caches the probe — gt is spawned at most once across calls', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'gt 1.2.3\n' });
    probeReviewer();
    const callsAfterFirst = spawnSyncMock.mock.calls.length;
    probeReviewer();
    probeReviewer();
    expect(spawnSyncMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('reviewerEnvOverlay', () => {
  it('sets GT_RIG=reviewer when the rig is enabled', () => {
    expect(
      reviewerEnvOverlay({
        enabled: true,
        gtPath: '/usr/local/bin/gt',
        version: 'gt 1.2.3',
        identity: null,
      }),
    ).toEqual({ GT_RIG: 'reviewer' });
  });

  it('returns an empty overlay for the no_gt degrade path', () => {
    expect(reviewerEnvOverlay({ enabled: false, reason: 'no_gt' })).toEqual({});
  });

  it('returns an empty overlay for the gt_failed degrade path', () => {
    expect(
      reviewerEnvOverlay({ enabled: false, reason: 'gt_failed', exitCode: 1 }),
    ).toEqual({});
  });
});
