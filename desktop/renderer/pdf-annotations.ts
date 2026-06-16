// L3 round-trip READ half — normalize PDF.js native markup annotations into the
// discriminated anchor union (§3.1) + provenance block (§3.2).
//
// Kept in its own module (no pdfjs / Vite side-effect imports) so the pure
// normalizer unit-tests under vitest's node environment. pdf-viewer.ts consumes
// `normalizePdfAnnotations` inside renderPage and re-exports the public types.

import type { NativeAnnotationRef, Quad } from '@shared/types';

/** A native PDF markup annotation, normalized into the union + provenance so the
 *  host can fold it straight into the comment stream as a `native-pdf` card.
 *  This is the PDF analogue of `ViewerSelection`: the viewer emits the geometry
 *  + metadata, the host builds the full `CommentPayload`. */
export interface NativePdfAnnotation {
  /** 1-indexed page the annotation lives on. */
  page: number;
  /** PDF-space bounding region (origin bottom-left, units = PDF points) — the
   *  same shape `PdfQuadAnchor.region` carries, so reveal works unchanged. */
  region: { x: number; y: number; w: number; h: number };
  /** Per-line quads (Acrobat UL/UR/LL/LR order) for text-markup annotations.
   *  Absent for non-markup kinds (e.g. a Text sticky note has only a /Rect). */
  quads?: Quad[];
  /** Annotation body text (/Contents). Becomes the card's comment body. */
  contents: string;
  /** §3.2 provenance — carries the read-time handle so re-imports dedupe and
   *  the bundle writer can tell native rows from app-authored ones. */
  native: NativeAnnotationRef;
}

/** The PDF.js `page.getAnnotations()` row fields we read. PDF.js types this
 *  surface as `any`; we narrow to the markup-annotation fields the normalizer
 *  touches. All optional — a malformed/foreign annot is skipped, never throws. */
export interface RawPdfAnnotation {
  id?: string;
  subtype?: string;
  /** Normalized `[x1, y1, x2, y2]` (min corner, max corner) in PDF points. */
  rect?: number[];
  /** Normalized flat `[x1,y1,…x4,y4]` per quad (8 numbers), Acrobat order. */
  quadPoints?: number[] | Float32Array | null;
  /** RGB 0–255 (PDF.js `setColor`), or null for the viewer default. */
  color?: Uint8ClampedArray | number[] | null;
  contentsObj?: { str?: string } | null;
  /** Markup /T (author) lands here. */
  titleObj?: { str?: string } | null;
  creationDate?: string | null;
  modificationDate?: string | null;
  inReplyTo?: string | null;
}

/** Markup annotation subtypes we surface as review cards (rev-cvr spike set).
 *  Widgets, links, and appearance-only annots are ignored. */
const READABLE_ANNOT_SUBTYPES = new Set<NonNullable<NativeAnnotationRef['subtype']>>([
  'Highlight', 'StrikeOut', 'Underline', 'Squiggly', 'Text',
]);

// ─── highlighted-text reconstruction (rev-894c) ────────────────────────────
//
// Native markup annotations carry geometry (/Rect + /QuadPoints) but NOT the
// page glyphs the highlight covers — so a native-pdf card lands with an empty
// quote. We reconstruct the covered text by hit-testing the annotation quads
// against the page's text runs (PDF.js `getTextContent`). All math is in PDF
// user space (origin bottom-left, Y up) — the same space the quads already
// live in — so it's zoom-independent and doesn't need a rendered text layer.

/** A PDF-space axis-aligned rect (origin bottom-left, Y up). */
export interface PdfRect {
  /** Left edge. */ x: number;
  /** Bottom edge. */ y: number;
  /** Width. */ w: number;
  /** Height. */ h: number;
}

/** One text run from PDF.js `getTextContent`, reduced to its PDF-space box.
 *  `x`/`y` are the run origin (baseline-left, per PDF.js `TextItem.transform`
 *  [4]/[5]); `w`/`h` are the run's advance width and font height. */
export interface PdfTextBox {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Collapse a markup quad (Acrobat UL/UR/LL/LR corners) to its bounding rect.
 *  Robust to corner-order quirks by min/max-ing all four points. */
export function quadToRect(q: Quad): PdfRect {
  const xs = [q.x1, q.x2, q.x3, q.x4];
  const ys = [q.y1, q.y2, q.y3, q.y4];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Length of the overlap of two 1-D intervals `[a0,a1]` and `[b0,b1]` (≥ 0). */
function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** True when a text run is "covered" by a highlight line-rect. The run baseline
 *  (`box.y`) must sit within the rect's vertical band (expanded by a tolerance,
 *  since the baseline rides near the rect's lower third), AND the run must
 *  overlap the rect horizontally by at least 30% of its own width — so a glyph
 *  mostly under the highlight counts while a neighbour barely clipped at the
 *  edge does not. */
function runCoveredBy(box: PdfTextBox, rect: PdfRect): boolean {
  const tol = rect.h * 0.5;
  const baselineInBand = box.y >= rect.y - tol && box.y <= rect.y + rect.h + tol;
  if (!baselineInBand) return false;
  if (box.w <= 0) {
    // Zero-width run (e.g. a lone combining mark): fall back to a point test.
    return box.x >= rect.x && box.x <= rect.x + rect.w;
  }
  const xOverlap = overlap1d(box.x, box.x + box.w, rect.x, rect.x + rect.w);
  return xOverlap >= box.w * 0.3;
}

/** Reconstruct the text a set of highlight line-rects covers, in reading order.
 *  Rects are processed top-to-bottom (descending PDF Y); within each line the
 *  covered runs are ordered left-to-right and concatenated, inserting a single
 *  space across a visible horizontal gap so adjacent words don't fuse. Lines
 *  join with a space. Whitespace is collapsed and trimmed. Each run is assigned
 *  to at most one line (its best vertical match) so overlapping bands never
 *  duplicate a word. */
export function reconstructHighlightedText(items: PdfTextBox[], rects: PdfRect[]): string {
  if (rects.length === 0 || items.length === 0) return '';
  // Top-to-bottom by line center (PDF Y is up, so larger center is higher).
  const lines = [...rects].sort((a, b) => (b.y + b.h / 2) - (a.y + a.h / 2));

  const lineTexts: string[] = [];
  const used = new Set<PdfTextBox>();
  for (const rect of lines) {
    const covered = items
      .filter((it) => !used.has(it) && runCoveredBy(it, rect))
      .sort((a, b) => a.x - b.x);
    if (covered.length === 0) continue;

    let line = '';
    let prevRight: number | null = null;
    for (const run of covered) {
      used.add(run);
      if (prevRight !== null) {
        const gap = run.x - prevRight;
        const endsWs = /\s$/.test(line);
        const startsWs = /^\s/.test(run.str);
        if (gap > rect.h * 0.25 && !endsWs && !startsWs) line += ' ';
      }
      line += run.str;
      prevRight = run.x + run.w;
    }
    lineTexts.push(line);
  }
  return lineTexts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Format a PDF.js color (RGB 0–255) as `#rrggbb`. Null/short arrays yield
 *  undefined so the provenance block omits the field rather than lying. */
export function formatAnnotColor(
  color: Uint8ClampedArray | number[] | null | undefined,
): string | undefined {
  if (!color || color.length < 3) return undefined;
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(color[0])}${hex(color[1])}${hex(color[2])}`;
}

/** Normalize one page's raw `getAnnotations()` rows into the union + provenance
 *  (L3). Pure (no DOM / PDF.js objects) so it unit-tests under node. Filters to
 *  the readable markup subtypes; maps /Rect → `region`, /QuadPoints → `quads`
 *  (already in Acrobat UL/UR/LL/LR order out of PDF.js's `getQuadPoints`), and
 *  records the read-time handle (`id` as `comment_id`; `page_index`/`annot_index`
 *  as the §3.2 fallback for annots that round-trip without a stable /NM). */
export function normalizePdfAnnotations(
  raw: RawPdfAnnotation[],
  page: number,
): NativePdfAnnotation[] {
  const out: NativePdfAnnotation[] = [];
  const pageIndex = page - 1;
  raw.forEach((a, annotIndex) => {
    const subtype = a.subtype as NativeAnnotationRef['subtype'] | undefined;
    if (!subtype || !READABLE_ANNOT_SUBTYPES.has(subtype)) return;
    const rect = a.rect;
    if (!rect || rect.length < 4) return;
    const region = {
      x: Math.min(rect[0], rect[2]),
      y: Math.min(rect[1], rect[3]),
      w: Math.abs(rect[2] - rect[0]),
      h: Math.abs(rect[3] - rect[1]),
    };
    const qp = a.quadPoints;
    let quads: Quad[] | undefined;
    if (qp && qp.length >= 8 && qp.length % 8 === 0) {
      quads = [];
      for (let i = 0; i < qp.length; i += 8) {
        quads.push({
          x1: qp[i + 0], y1: qp[i + 1],
          x2: qp[i + 2], y2: qp[i + 3],
          x3: qp[i + 4], y3: qp[i + 5],
          x4: qp[i + 6], y4: qp[i + 7],
        });
      }
    }
    const native: NativeAnnotationRef = {
      comment_id: a.id ?? `p${pageIndex}-a${annotIndex}`,
      subtype,
      page_index: pageIndex,
      annot_index: annotIndex,
    };
    const author = a.titleObj?.str?.trim();
    if (author) native.author = author;
    const color = formatAnnotColor(a.color);
    if (color) native.color = color;
    const created = a.creationDate ?? a.modificationDate;
    if (created) native.created = created;
    if (a.inReplyTo) native.in_reply_to = a.inReplyTo;
    out.push({ page, region, quads, contents: a.contentsObj?.str ?? '', native });
  });
  return out;
}
