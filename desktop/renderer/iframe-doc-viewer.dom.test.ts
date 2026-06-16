// @vitest-environment jsdom
//
// DOM-backed coverage for the rev-l6 text-quote anchoring leg of the iframe
// viewers (spec §5.5): the linear-text index, the offset→node `locate`, and the
// multi-text-node `paintCharRange`. The full IframeDocViewer is iframe-bound and
// not unit-testable under jsdom, so these exercise the pure helpers that carry
// the novel logic; `fuzzyMatchAnchor` (the resolver they feed) is covered in
// shared/md/anchors.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { HtmlSelectorHint, TextQuoteAnchor } from '@shared/types';
import { fuzzyMatchAnchor } from '@shared/md/anchors';
import {
  buildLinearIndex,
  locate,
  paintCharRange,
  selectorHintOffsets,
} from './iframe-doc-viewer';

function bodyFrom(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('buildLinearIndex', () => {
  it('concatenates text nodes in document order, with per-node start offsets', () => {
    const root = bodyFrom('<p>Hello </p><p><b>brave</b> world</p>');
    const idx = buildLinearIndex(root);
    expect(idx.text).toBe('Hello brave world');
    // "Hello " | "brave" | " world"
    expect(idx.nodes.map((n) => n.data)).toEqual(['Hello ', 'brave', ' world']);
    expect(idx.starts).toEqual([0, 6, 11]);
  });

  it('equals body.textContent', () => {
    const root = bodyFrom('<div>a<span>b</span>c</div>');
    expect(buildLinearIndex(root).text).toBe(root.textContent);
  });

  it('is empty for a body with no text', () => {
    const idx = buildLinearIndex(bodyFrom('<br>'));
    expect(idx.text).toBe('');
    expect(idx.nodes).toEqual([]);
  });
});

describe('locate', () => {
  it('maps a linear offset to the containing node and intra-node offset', () => {
    const idx = buildLinearIndex(bodyFrom('<p>Hello </p><p>world</p>'));
    expect(idx.text).toBe('Hello world');
    const at0 = locate(idx, 0);
    expect(at0?.node.data).toBe('Hello ');
    expect(at0?.nodeOffset).toBe(0);
    const at8 = locate(idx, 8); // 'r' of "world" (offset 6 starts "world")
    expect(at8?.node.data).toBe('world');
    expect(at8?.nodeOffset).toBe(2);
  });

  it('resolves a node-seam offset to the end of the earlier node', () => {
    const idx = buildLinearIndex(bodyFrom('<p>ab</p><p>cd</p>'));
    // offset 2 is the seam between "ab" and "cd".
    const seam = locate(idx, 2);
    expect(seam?.node.data).toBe('ab');
    expect(seam?.nodeOffset).toBe(2);
  });

  it('returns null for an empty index or an out-of-range offset', () => {
    expect(locate(buildLinearIndex(bodyFrom('')), 0)).toBeNull();
    const idx = buildLinearIndex(bodyFrom('<p>abc</p>'));
    expect(locate(idx, -1)).toBeNull();
    expect(locate(idx, 99)).toBeNull();
  });
});

describe('paintCharRange', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('wraps a range inside a single text node', () => {
    const root = bodyFrom('<p>the quick brown fox</p>');
    const idx = buildLinearIndex(root);
    const from = idx.text.indexOf('quick');
    expect(paintCharRange(document, idx, from, from + 'quick'.length)).toBe(true);
    const marks = root.querySelectorAll('.review-highlight');
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe('quick');
    // Text content of the document is unchanged by painting.
    expect(root.textContent).toBe('the quick brown fox');
  });

  it('wraps a range spanning multiple text nodes, one span per node segment', () => {
    const root = bodyFrom('<p>alpha </p><p><b>beta</b> gamma</p>');
    const idx = buildLinearIndex(root);
    expect(idx.text).toBe('alpha beta gamma');
    // Select "pha beta ga" — spans the first node, the <b> node, and the third.
    const from = idx.text.indexOf('pha');
    const to = idx.text.indexOf('ga') + 'ga'.length;
    expect(paintCharRange(document, idx, from, to)).toBe(true);
    const marks = Array.from(root.querySelectorAll('.review-highlight'));
    expect(marks.length).toBe(3);
    expect(marks.map((m) => m.textContent).join('')).toBe('pha beta ga');
    expect(root.textContent).toBe('alpha beta gamma');
  });

  it('returns false for a degenerate range', () => {
    const idx = buildLinearIndex(bodyFrom('<p>abc</p>'));
    expect(paintCharRange(document, idx, 5, 2)).toBe(false);
    expect(paintCharRange(document, idx, -1, 2)).toBe(false);
  });
});

describe('selectorHintOffsets (§5.5 lazy-upgrade resolution)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function hint(over: Partial<HtmlSelectorHint>): HtmlSelectorHint {
    return {
      kind: 'html-selector-hint',
      selector: '',
      char_offset: 0,
      char_length: 0,
      quoted_text: '',
      ...over,
    };
  }

  it('projects a quoted match onto linear offsets, counting preceding text', () => {
    const root = bodyFrom('<h1>Title</h1><p>The cat sat on the mat.</p>');
    const off = selectorHintOffsets(root, hint({ selector: 'p', quoted_text: 'cat sat' }));
    const linear = buildLinearIndex(root).text;
    expect(off).toEqual({ from: linear.indexOf('cat sat'), to: linear.indexOf('cat sat') + 7 });
    // The offsets feed paintCharRange directly and highlight the same text.
    paintCharRange(document, buildLinearIndex(root), off!.from, off!.to);
    expect(root.querySelector('.review-highlight')?.textContent).toBe('cat sat');
  });

  it('falls back to the whole body when the selector is missing or bad', () => {
    const root = bodyFrom('<p>alpha</p><p>beta gamma</p>');
    const linear = buildLinearIndex(root).text;
    // A selector that matches nothing is demoted to a whole-body search scope.
    const off = selectorHintOffsets(root, hint({ selector: '.nope', quoted_text: 'gamma' }));
    expect(off).toEqual({ from: linear.indexOf('gamma'), to: linear.indexOf('gamma') + 5 });
    // A malformed selector is swallowed and behaves the same way.
    const bad = selectorHintOffsets(root, hint({ selector: ':::', quoted_text: 'beta' }));
    expect(bad).toEqual({ from: linear.indexOf('beta'), to: linear.indexOf('beta') + 4 });
  });

  it('confines the search to the selector scope', () => {
    const root = bodyFrom('<div class="a">target</div><div class="b">target</div>');
    const linear = buildLinearIndex(root).text;
    const off = selectorHintOffsets(root, hint({ selector: '.b', quoted_text: 'target' }));
    // Both divs contain "target"; the scope picks the second occurrence.
    expect(off?.from).toBe(linear.indexOf('target', 'target'.length));
  });

  it('returns null when the quoted text is absent', () => {
    const root = bodyFrom('<p>nothing here</p>');
    expect(selectorHintOffsets(root, hint({ quoted_text: 'missing' }))).toBeNull();
  });
});

describe('text-quote resolution end to end (resolver + paint)', () => {
  it('resolves an exact text-quote anchor and highlights it', () => {
    const root = bodyFrom('<h1>Title</h1><p>The cat sat on the mat.</p>');
    const linear = buildLinearIndex(root).text;
    const anchor: TextQuoteAnchor = {
      kind: 'text-quote',
      char_start: linear.indexOf('cat sat'),
      char_end: linear.indexOf('cat sat') + 'cat sat'.length,
      prefix: 'The ',
      suffix: ' on the',
      quoted_text: 'cat sat',
    };
    const match = fuzzyMatchAnchor(linear, anchor);
    expect(match.confidence).toBe('exact');
    paintCharRange(document, buildLinearIndex(root), match.from, match.to);
    expect(root.querySelector('.review-highlight')?.textContent).toBe('cat sat');
  });

  it('relocates a text-quote anchor whose stored offsets drifted', () => {
    const root = bodyFrom('<p>Intro paragraph added later. The cat sat on the mat.</p>');
    const linear = buildLinearIndex(root).text;
    // Stored offsets point at the pre-drift position (0); the quoted text now
    // lives further along. fuzzyMatchAnchor finds it by content.
    const anchor: TextQuoteAnchor = {
      kind: 'text-quote',
      char_start: 0,
      char_end: 7,
      prefix: 'The ',
      suffix: ' on the',
      quoted_text: 'cat sat',
    };
    const match = fuzzyMatchAnchor(linear, anchor);
    expect(match.confidence).toBe('exact');
    expect(match.from).toBe(linear.indexOf('cat sat'));
    paintCharRange(document, buildLinearIndex(root), match.from, match.to);
    expect(root.querySelector('.review-highlight')?.textContent).toBe('cat sat');
  });
});
