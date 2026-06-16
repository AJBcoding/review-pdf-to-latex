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
