// Unit tests for the shared session-policy module (X8 Stage 1).
//
// existsSync is mocked so resolveSessionCwd is testable without touching the
// filesystem — we drive the "dir exists" vs "dir missing" branches directly.
import { afterEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn<(p: string) => boolean>();
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
}));

const {
  resolveSessionCwd,
  resolveSkipPermissions,
  ptySkipPermissionArgs,
  sdkPermissionOptions,
} = await import('./session-policy.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveSessionCwd', () => {
  it('uses the doc source dir when it exists on disk', () => {
    existsSyncMock.mockReturnValue(true);
    expect(resolveSessionCwd('/docs/paper', '/fallback')).toBe('/docs/paper');
    expect(existsSyncMock).toHaveBeenCalledWith('/docs/paper');
  });

  it('falls back when the doc source dir does not exist', () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolveSessionCwd('/gone', '/fallback')).toBe('/fallback');
  });

  it('falls back when the doc source dir is undefined (no existsSync call)', () => {
    expect(resolveSessionCwd(undefined, '/fallback')).toBe('/fallback');
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('falls back when the doc source dir is an empty string', () => {
    expect(resolveSessionCwd('', '/fallback')).toBe('/fallback');
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});

describe('resolveSkipPermissions', () => {
  it('defaults to ON when the flag is undefined', () => {
    expect(resolveSkipPermissions(undefined)).toBe(true);
  });

  it('stays ON when the flag is explicitly true', () => {
    expect(resolveSkipPermissions(true)).toBe(true);
  });

  it('opts back into prompts only when the flag is exactly false', () => {
    expect(resolveSkipPermissions(false)).toBe(false);
  });
});

describe('ptySkipPermissionArgs', () => {
  it('emits the dangerous flag when skipping', () => {
    expect(ptySkipPermissionArgs(true)).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('emits no args when not skipping', () => {
    expect(ptySkipPermissionArgs(false)).toEqual([]);
  });
});

describe('sdkPermissionOptions', () => {
  it('maps skip → bypassPermissions with the required safety flag', () => {
    expect(sdkPermissionOptions(true)).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('maps no-skip → default mode without the bypass flag', () => {
    const opts = sdkPermissionOptions(false);
    expect(opts.permissionMode).toBe('default');
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
  });
});
