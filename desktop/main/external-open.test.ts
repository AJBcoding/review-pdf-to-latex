// Unit tests for the external-open launch parsers (rev-l9).
//
// external-open.ts imports `electron` at module scope for its setup helpers;
// the pure parsers under test don't touch it, so we stub electron just enough
// to let the module load.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn(), quit: vi.fn(), requestSingleInstanceLock: vi.fn(() => true) },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn() },
}));

import { extractPathFromArgv, parseReviewpdfUrl } from './external-open.js';

describe('parseReviewpdfUrl', () => {
  it('parses path + from', () => {
    expect(parseReviewpdfUrl('reviewpdf://open?path=/a/b.pdf&from=rig-1'))
      .toEqual({ path: '/a/b.pdf', from: 'rig-1' });
  });

  it('returns null from when from is absent', () => {
    expect(parseReviewpdfUrl('reviewpdf://open?path=/a/b.pdf'))
      .toEqual({ path: '/a/b.pdf', from: null });
  });

  it('rejects a non-reviewpdf scheme', () => {
    expect(parseReviewpdfUrl('https://example.com/?path=/a/b.pdf')).toBeNull();
  });

  it('rejects a URL missing the required path', () => {
    expect(parseReviewpdfUrl('reviewpdf://open?from=rig-1')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseReviewpdfUrl('not a url')).toBeNull();
  });
});

describe('extractPathFromArgv', () => {
  it('recognizes the `open <path>` shim form', () => {
    expect(extractPathFromArgv(['open', '/docs/a.pdf']))
      .toEqual({ path: '/docs/a.pdf', from: null });
  });

  it('recognizes a bare positional PDF', () => {
    expect(extractPathFromArgv(['/docs/a.pdf']))
      .toEqual({ path: '/docs/a.pdf', from: null });
  });

  // rev-l9: the positional filter now admits every openable FileKind, not just
  // PDF — md / html / docx route the same way.
  it.each([
    ['/docs/a.md'],
    ['/docs/a.markdown'],
    ['/docs/a.html'],
    ['/docs/a.htm'],
    ['/docs/a.docx'],
  ])('recognizes a bare positional %s', (p) => {
    expect(extractPathFromArgv([p])).toEqual({ path: p, from: null });
  });

  it('ignores a positional with an unrecognized extension', () => {
    expect(extractPathFromArgv(['/docs/a.txt'])).toBeNull();
  });

  it('ignores flag-looking args', () => {
    expect(extractPathFromArgv(['--verbose', '-x'])).toBeNull();
  });

  it('pairs --from with a positional doc', () => {
    expect(extractPathFromArgv(['--from', 'rig-7', '/docs/a.docx']))
      .toEqual({ path: '/docs/a.docx', from: 'rig-7' });
  });

  it('accepts the --from=<id> form', () => {
    expect(extractPathFromArgv(['--from=rig-7', '/docs/a.md']))
      .toEqual({ path: '/docs/a.md', from: 'rig-7' });
  });

  it('extracts path + from from a reviewpdf:// arg', () => {
    expect(extractPathFromArgv(['reviewpdf://open?path=/a/b.html&from=rig-2']))
      .toEqual({ path: '/a/b.html', from: 'rig-2' });
  });

  it('does not treat a --from value as a positional doc', () => {
    // `a.pdf` here is the --from value, not an openable path.
    expect(extractPathFromArgv(['--from', 'a.pdf'])).toBeNull();
  });

  it('returns null when no openable arg is present', () => {
    expect(extractPathFromArgv(['electron', 'main.js'])).toBeNull();
  });
});
