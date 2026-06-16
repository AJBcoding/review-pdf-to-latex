// L3 round-trip READ half — the pure normalizer that turns PDF.js
// `getAnnotations()` rows into the anchor union + provenance. This is the seam
// that decides which native annotations become cards and how their geometry /
// metadata map across, so a regression here silently drops or mis-places every
// imported annotation.

import { describe, expect, it } from 'vitest';
import {
  formatAnnotColor,
  normalizePdfAnnotations,
  quadToRect,
  reconstructHighlightedText,
  type PdfTextBox,
  type RawPdfAnnotation,
} from './pdf-annotations';

/** A PDF.js-shaped Highlight row: normalized `rect` + a single 8-number quad in
 *  Acrobat UL/UR/LL/LR order (what `getQuadPoints` emits). */
function highlight(overrides: Partial<RawPdfAnnotation> = {}): RawPdfAnnotation {
  return {
    id: '10R',
    subtype: 'Highlight',
    rect: [72, 698, 449, 714],
    // UL, UR, LL, LR for the box (72,698)–(449,714).
    quadPoints: [72, 714, 449, 714, 72, 698, 449, 698],
    color: new Uint8ClampedArray([255, 255, 0]),
    contentsObj: { str: 'tighten this' },
    titleObj: { str: 'AJB' },
    creationDate: "D:20260614120000+00'00'",
    ...overrides,
  };
}

describe('normalizePdfAnnotations', () => {
  it('maps /Rect → region and /QuadPoints → a single Acrobat-order quad', () => {
    const [a] = normalizePdfAnnotations([highlight()], 3);
    expect(a.page).toBe(3);
    expect(a.region).toEqual({ x: 72, y: 698, w: 377, h: 16 });
    expect(a.quads).toEqual([
      { x1: 72, y1: 714, x2: 449, y2: 714, x3: 72, y3: 698, x4: 449, y4: 698 },
    ]);
  });

  it('carries /Contents, author, color (#rrggbb) and creation date into provenance', () => {
    const [a] = normalizePdfAnnotations([highlight()], 1);
    expect(a.contents).toBe('tighten this');
    expect(a.native).toMatchObject({
      comment_id: '10R',
      subtype: 'Highlight',
      author: 'AJB',
      color: '#ffff00',
      created: "D:20260614120000+00'00'",
      page_index: 0,
      annot_index: 0,
    });
  });

  it('records page_index / annot_index as the read-time fallback handle', () => {
    const out = normalizePdfAnnotations(
      [highlight({ id: 'aR' }), highlight({ id: 'bR' })],
      5,
    );
    expect(out.map((a) => a.native.page_index)).toEqual([4, 4]);
    expect(out.map((a) => a.native.annot_index)).toEqual([0, 1]);
  });

  it('synthesizes a comment_id from page/annot index when /id is absent', () => {
    const [a] = normalizePdfAnnotations([highlight({ id: undefined })], 2);
    expect(a.native.comment_id).toBe('p1-a0');
  });

  it('keeps multi-line markup as multiple quads', () => {
    const twoLine = highlight({
      rect: [72, 698, 449, 740],
      quadPoints: [
        72, 740, 449, 740, 72, 724, 449, 724, // line 1
        72, 714, 300, 714, 72, 698, 300, 698, // line 2
      ],
    });
    const [a] = normalizePdfAnnotations([twoLine], 1);
    expect(a.quads).toHaveLength(2);
  });

  it('handles a Text sticky note (no quadPoints) — region only', () => {
    const sticky = normalizePdfAnnotations(
      [{ id: '4R', subtype: 'Text', rect: [100, 200, 120, 220], contentsObj: { str: 'note' } }],
      1,
    );
    expect(sticky).toHaveLength(1);
    expect(sticky[0].quads).toBeUndefined();
    expect(sticky[0].region).toEqual({ x: 100, y: 200, w: 20, h: 20 });
    expect(sticky[0].contents).toBe('note');
  });

  it('imports every readable markup subtype', () => {
    const subs = ['Highlight', 'StrikeOut', 'Underline', 'Squiggly', 'Text'];
    const out = normalizePdfAnnotations(
      subs.map((subtype, i) => highlight({ subtype, id: `${i}R` })),
      1,
    );
    expect(out.map((a) => a.native.subtype)).toEqual(subs);
  });

  it('skips non-markup subtypes (Link, Widget, Popup) and unknown kinds', () => {
    const out = normalizePdfAnnotations(
      [
        highlight({ subtype: 'Link', id: 'lR' }),
        highlight({ subtype: 'Widget', id: 'wR' }),
        highlight({ subtype: 'Popup', id: 'pR' }),
        highlight({ subtype: undefined, id: 'uR' }),
      ],
      1,
    );
    expect(out).toHaveLength(0);
  });

  it('skips annotations missing a usable /Rect', () => {
    const out = normalizePdfAnnotations(
      [highlight({ rect: undefined }), highlight({ rect: [1, 2] }), highlight({ id: 'okR' })],
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].native.comment_id).toBe('okR');
  });

  it('ignores a malformed quadPoints array (length not a multiple of 8)', () => {
    const [a] = normalizePdfAnnotations([highlight({ quadPoints: [1, 2, 3] })], 1);
    expect(a.quads).toBeUndefined();
    // region still derives from /Rect, so the annot is not dropped.
    expect(a.region.w).toBe(377);
  });

  it('omits optional provenance fields when absent rather than emitting empties', () => {
    const [a] = normalizePdfAnnotations(
      [{ id: '9R', subtype: 'Highlight', rect: [0, 0, 10, 10] }],
      1,
    );
    expect(a.contents).toBe('');
    expect(a.native.author).toBeUndefined();
    expect(a.native.color).toBeUndefined();
    expect(a.native.created).toBeUndefined();
  });

  it('falls back to modificationDate when creationDate is absent', () => {
    const [a] = normalizePdfAnnotations(
      [highlight({ creationDate: null, modificationDate: "D:20260101000000+00'00'" })],
      1,
    );
    expect(a.native.created).toBe("D:20260101000000+00'00'");
  });
});

describe('quadToRect', () => {
  it('collapses an Acrobat UL/UR/LL/LR quad to its bounding rect', () => {
    // The single-line Highlight quad from the fixtures above.
    expect(quadToRect({ x1: 72, y1: 714, x2: 449, y2: 714, x3: 72, y3: 698, x4: 449, y4: 698 }))
      .toEqual({ x: 72, y: 698, w: 377, h: 16 });
  });

  it('is robust to corner-order quirks (min/max of all four points)', () => {
    expect(quadToRect({ x1: 449, y1: 698, x2: 72, y2: 698, x3: 449, y3: 714, x4: 72, y4: 714 }))
      .toEqual({ x: 72, y: 698, w: 377, h: 16 });
  });
});

describe('reconstructHighlightedText', () => {
  /** A text run box: baseline-left origin (x,y), advance width w, font height h
   *  — the PDF.js `TextItem` geometry the viewer feeds in. */
  function run(str: string, x: number, w: number, y = 700, h = 12): PdfTextBox {
    return { str, x, y, w, h };
  }

  // A line-rect whose band ([y-6 … y+h+6]) contains baseline y=700.
  const line = { x: 72, y: 696, w: 200, h: 14 };

  it('concatenates the runs a single line-rect covers, left to right', () => {
    const items = [run('world', 112, 48), run('Hello ', 72, 40)];
    expect(reconstructHighlightedText(items, [line])).toBe('Hello world');
  });

  it('inserts a space across a visible horizontal gap between bare runs', () => {
    const items = [run('foo', 72, 20), run('bar', 120, 20)]; // gap 28 ≫ h*0.25
    expect(reconstructHighlightedText(items, [line])).toBe('foo bar');
  });

  it('does not double-space when a run already carries whitespace', () => {
    const items = [run('foo', 72, 20), run(' bar', 120, 20)];
    expect(reconstructHighlightedText(items, [line])).toBe('foo bar');
  });

  it('orders multi-line rects top-to-bottom regardless of input order', () => {
    const top = { x: 72, y: 718, w: 200, h: 12 };    // band [712 … 736]
    const bottom = { x: 72, y: 694, w: 200, h: 12 };  // band [688 … 712]
    const items = [run('two', 72, 30, 700), run('line', 72, 40, 724)];
    // Pass the lower rect first to prove the sort, not input order, wins.
    expect(reconstructHighlightedText(items, [bottom, top])).toBe('line two');
  });

  it('drops runs whose baseline falls outside every line band', () => {
    const items = [run('on', 72, 20, 700), run('off', 72, 20, 760)];
    expect(reconstructHighlightedText(items, [line])).toBe('on');
  });

  it('drops a run barely clipped at the edge (under 30% horizontal overlap)', () => {
    // rect spans x [72 … 272]. 'edge' is 20 wide at x=270 → only 2px overlap,
    // below the 0.3·width = 6px threshold, so it's not part of the highlight.
    const items = [run('in', 100, 20), run('edge', 270, 20)];
    expect(reconstructHighlightedText(items, [line])).toBe('in');
  });

  it('assigns each run to at most one line (no duplication on overlapping bands)', () => {
    const top = { x: 72, y: 718, w: 200, h: 12 };
    const bottom = { x: 72, y: 694, w: 200, h: 12 };
    const items = [run('word', 72, 40, 724)]; // matches only the top band
    expect(reconstructHighlightedText(items, [top, bottom])).toBe('word');
  });

  it('returns empty string for empty rects or items', () => {
    expect(reconstructHighlightedText([run('x', 72, 10)], [])).toBe('');
    expect(reconstructHighlightedText([], [line])).toBe('');
  });
});

describe('formatAnnotColor', () => {
  it('formats RGB 0–255 as #rrggbb', () => {
    expect(formatAnnotColor([255, 0, 128])).toBe('#ff0080');
    expect(formatAnnotColor(new Uint8ClampedArray([0, 17, 34]))).toBe('#001122');
  });

  it('returns undefined for null / short arrays', () => {
    expect(formatAnnotColor(null)).toBeUndefined();
    expect(formatAnnotColor([1, 2])).toBeUndefined();
    expect(formatAnnotColor(undefined)).toBeUndefined();
  });
});
