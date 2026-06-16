// Unit tests for the shared cross-platform path helpers (rev-l11 dedup).
// These pin the exact behavior the three former copies relied on so the
// consolidation is provably a no-op.
import { describe, expect, it } from 'vitest';

import { basename, dirnameOf } from './paths.js';

describe('basename', () => {
  it('returns the last POSIX segment', () => {
    expect(basename('/a/b/c.pdf')).toBe('c.pdf');
  });

  it('returns the last Windows segment', () => {
    expect(basename('C:\\Users\\me\\doc.md')).toBe('doc.md');
  });

  it('handles mixed separators (last separator wins)', () => {
    expect(basename('/a/b\\c.txt')).toBe('c.txt');
  });

  it('returns the whole string when there is no separator', () => {
    expect(basename('file.txt')).toBe('file.txt');
  });

  it('returns empty string for a trailing separator', () => {
    expect(basename('/a/b/')).toBe('');
  });

  it('handles the empty string', () => {
    expect(basename('')).toBe('');
  });
});

describe('dirnameOf', () => {
  it('returns the parent directory for a POSIX path', () => {
    expect(dirnameOf('/a/b/c.pdf')).toBe('/a/b');
  });

  it('returns the parent directory for a Windows path', () => {
    expect(dirnameOf('C:\\Users\\me\\doc.md')).toBe('C:\\Users\\me');
  });

  it('returns "/" for a root-level file', () => {
    expect(dirnameOf('/file.txt')).toBe('/');
  });

  it('returns "/" for a bare name with no separator', () => {
    expect(dirnameOf('file.txt')).toBe('/');
  });

  it('returns "/" for the empty string', () => {
    expect(dirnameOf('')).toBe('/');
  });
});
