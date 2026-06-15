// §10.4 bundle writer — main-process side.
//
// Lays Highlight annotations onto a copy of the source PDF and writes the
// JSON sidecar to the source directory. Annotation construction follows
// the rev-cvr spike (spikes/rev-cvr-pdf-lib/spike.mjs): pdf-lib 1.17 ships
// no high-level helper for /Highlight, so we build the annotation dict by
// hand. Coords are PDF user space — the renderer captures them via
// `viewport.convertToPdfPoint` (see pdf-viewer.ts), which is identity for
// unrotated pages with MediaBox origin (0,0).
//
// v1 emits Highlight only. Strikethrough + sticky-note paths are deferred
// to v2 (tracking spec §5.1's tool deferral; see bd rev-6nr).

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicWrite, atomicWriteJson } from './atomic-write.js';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFNumber,
  PDFArray,
  PDFDict,
  PDFRef,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type {
  BundleJsonFile,
  BundleWriteRequest,
  BundleWriteResult,
  CommentPayload,
  PdfQuadAnchor,
} from '@shared/types';
import {
  ENGAGEMENT_PALETTE,
  buildBundleFilename,
  mintBundleId,
  parseSourceName,
} from '@shared/bundle';

/** PDF date format: `D:YYYYMMDDHHmmSSOHH'mm'`. UTC; offset always +00'00'. */
function pdfDateUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `+00'00'`
  );
}

/** Build the /Highlight annotation dict for one comment. /Rect is the
 *  bounding box, /QuadPoints encodes one quad (Acrobat order: UL/UR/LL/LR
 *  — see spike notes for why we deviate from the spec's CCW wording).
 *
 *  /Contents carries the comment text, with an appended `\n[redraft] …`
 *  block when the comment has a user-supplied redraft. /T (author) is
 *  the bundle author. /NM is the annotation name, set to the minted
 *  annotation id (stamped into the sidecar comment's `native.comment_id`)
 *  so the JSON sidecar's per-comment link is resolvable from inside the PDF
 *  too (round-trip safety). */
function buildHighlight(
  doc: PDFDocument,
  pageRef: PDFRef,
  comment: CommentPayload,
  anchor: PdfQuadAnchor,
  annotationId: string,
  date: Date,
): PDFDict {
  const ctx = doc.context;
  const r = anchor.region;
  const palette = ENGAGEMENT_PALETTE[comment.engagement_level];

  // /Rect = bbox of the highlight in PDF user space.
  const rect = ctx.obj([r.x, r.y, r.x + r.w, r.y + r.h]);

  // QuadPoints: Acrobat order UL, UR, LL, LR. Single-region quad in v1
  // (renderer captures a bbox, not per-line rects); multi-line highlights
  // would push 8 numbers per line. Acceptable v1 fidelity — multi-line
  // selection capture is tracked in spec §5 (not in this bead).
  const qp = ctx.obj([
    r.x,       r.y + r.h,  // UL
    r.x + r.w, r.y + r.h,  // UR
    r.x,       r.y,        // LL
    r.x + r.w, r.y,        // LR
  ]);

  const contents = comment.redraft
    ? `${comment.comment}\n[redraft] ${comment.redraft}`.trim()
    : (comment.comment || '');

  const color = ctx.obj([
    palette.pdfC[0],
    palette.pdfC[1],
    palette.pdfC[2],
  ]);

  return ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Highlight'),
    Rect: rect,
    Contents: PDFString.of(contents),
    T: PDFString.of(comment.author),
    M: PDFString.of(pdfDateUtc(date)),
    F: PDFNumber.of(4),       // /F=4 = print
    C: color,
    CA: PDFNumber.of(palette.pdfCA),
    NM: PDFString.of(annotationId),
    QuadPoints: qp,
    P: pageRef,
  });
}

/** Attach annotation refs to a page's /Annots, appending to any existing
 *  array. */
function appendAnnotsToPage(
  doc: PDFDocument,
  page: PDFPage,
  annots: PDFDict[],
): void {
  const ctx = doc.context;
  const annotRefs = annots.map((a) => ctx.register(a));
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) {
    for (const r of annotRefs) existing.push(r);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj(annotRefs));
  }
}

/** Main entry point — wired into the IPC handler in main/index.ts.
 *
 *  Steps:
 *    1. Read the source PDF off disk.
 *    2. Load into pdf-lib, layer Highlight annotations grouped per page.
 *       Each annotation gets a freshly-minted `annot-<n>` id; the same id
 *       is written into the JSON sidecar's comment so a reader can pair
 *       PDF annot ↔ JSON comment without coordinate matching.
 *    3. Serialize the PDF, compute its sha256, write atomically.
 *    4. Build the JSON sidecar with refreshed per-comment annotation IDs
 *       (`pdf_annotation_id` overwrites any prior value — the bundle PDF
 *       is regenerated from scratch on every write, so old IDs are stale).
 *    5. Atomic-write the JSON sidecar.
 *    6. Return paths + annotation ID mapping so the renderer can mirror
 *       the IDs onto its in-memory drafts (saves a draft round-trip).
 */
export async function writeBundle(req: BundleWriteRequest): Promise<BundleWriteResult> {
  // C5 guard (§4.4 step 0): bundle writer is PDF-only. Under the anchor union
  // this is now keyed on the per-comment anchor KIND (the truthful
  // discriminator) rather than the legacy md_anchor sniff — reject any comment
  // whose anchor is not `pdf-quad`, since text-quote / html-selector-hint
  // anchors carry no PDF region and would produce garbage annotations.
  const nonPdfComment = req.comments.find((c) => c.anchor.kind !== 'pdf-quad');
  if (nonPdfComment) {
    return {
      ok: false,
      reason: 'render_failed',
      error: `comment '${nonPdfComment.id}' has a non-pdf-quad anchor (${nonPdfComment.anchor.kind}) — writeBundle is PDF-only (C5 guard)`,
      bundlePdfPath: null,
      bundleJsonPath: null,
    };
  }

  const date = new Date();
  const sourcePath = resolve(req.sourcePath);
  const sourceDir = dirname(sourcePath);
  const sourceBasename = basename(sourcePath);
  const parsed = parseSourceName(sourceBasename);

  const bundlePdfName = buildBundleFilename({
    parsed,
    fallbackBase: sourceBasename,
    date,
    ext: 'pdf',
  });
  const bundleJsonName = buildBundleFilename({
    parsed,
    fallbackBase: sourceBasename,
    date,
    ext: 'json',
  });
  const bundlePdfPath = join(sourceDir, bundlePdfName);
  const bundleJsonPath = join(sourceDir, bundleJsonName);

  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(sourcePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      reason: e.code === 'ENOENT' ? 'source_not_found' : 'source_read_failed',
      error: e.message,
      bundlePdfPath: null,
      bundleJsonPath: null,
    };
  }

  let pdfBytes: Uint8Array;
  const annotationIds: { commentId: string; pdfAnnotationId: string }[] = [];
  try {
    const doc = await PDFDocument.load(sourceBytes);
    // Group comments by 1-indexed page so we only walk the /Annots array
    // once per page. Pages outside [1, pageCount] are skipped with a soft
    // warning — happens when a draft references a deleted page. Don't
    // fail the whole write for one stale anchor.
    // Every comment is pdf-quad by the C5 guard above; narrow once here.
    const pdfComments: { comment: CommentPayload; anchor: PdfQuadAnchor }[] = [];
    for (const c of req.comments) {
      if (c.anchor.kind !== 'pdf-quad') continue; // unreachable post-guard; satisfies TS
      pdfComments.push({ comment: c, anchor: c.anchor });
    }
    const byPage = new Map<number, { comment: CommentPayload; anchor: PdfQuadAnchor }[]>();
    for (const pc of pdfComments) {
      const p = pc.anchor.page;
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p)!.push(pc);
    }
    const totalPages = doc.getPageCount();
    let annotCounter = 0;
    for (const [pageNum, group] of byPage) {
      if (pageNum < 1 || pageNum > totalPages) {
        console.warn(`[bundle] skipping ${group.length} annot(s) on out-of-range page ${pageNum}`);
        continue;
      }
      const page = doc.getPage(pageNum - 1);
      const annots: PDFDict[] = [];
      for (const { comment, anchor } of group) {
        annotCounter += 1;
        const annotationId = `annot-${annotCounter}`;
        annots.push(buildHighlight(doc, page.ref, comment, anchor, annotationId, date));
        annotationIds.push({ commentId: comment.id, pdfAnnotationId: annotationId });
      }
      appendAnnotsToPage(doc, page, annots);
    }
    pdfBytes = await doc.save();
  } catch (err) {
    return {
      ok: false,
      reason: 'render_failed',
      error: err instanceof Error ? err.message : String(err),
      bundlePdfPath,
      bundleJsonPath,
    };
  }

  const bundlePdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');

  try {
    await atomicWrite(bundlePdfPath, pdfBytes);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      reason: e.code === 'ENOENT' ? 'mkdir_failed' : 'write_failed',
      error: e.message,
      bundlePdfPath,
      bundleJsonPath,
    };
  }

  // Stamp the freshly-minted annotation IDs onto a copy of the comments
  // before writing the JSON sidecar. The map covers everything we just
  // rendered; comments whose anchor was out-of-range get null (no annot
  // exists in the bundle PDF for them). Under v2 the id lands in
  // `native.comment_id` (folds in the old `pdf_annotation_id`); the comment is
  // app-written so origin stays `app-draft`.
  const idMap = new Map(annotationIds.map((x) => [x.commentId, x.pdfAnnotationId]));
  const stampedComments: CommentPayload[] = req.comments.map((c) => {
    const annotId = idMap.get(c.id) ?? null;
    if (!annotId) return { ...c, native: c.native ?? null };
    return { ...c, native: { ...(c.native ?? {}), comment_id: annotId } };
  });

  const bundleId = mintBundleId(date);
  const json: BundleJsonFile = {
    schema_version: 1,
    bundle_id: bundleId,
    created_at: date.toISOString(),
    app_version: req.appVersion,
    author: req.author,
    source: {
      filename: sourceBasename,
      absolute_path: sourcePath,
      sha256: req.sourceSha256,
      source_file_version: parsed?.source_version ?? null,
      page_count: req.pageCount,
    },
    rendered_pdf: {
      filename: bundlePdfName,
      sha256: bundlePdfSha256,
    },
    comments: stampedComments,
  };

  try {
    await atomicWriteJson(bundleJsonPath, json);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      reason: e.code === 'ENOENT' ? 'mkdir_failed' : 'write_failed',
      error: e.message,
      bundlePdfPath,
      bundleJsonPath,
    };
  }

  return {
    ok: true,
    bundleId,
    bundlePdfPath,
    bundleJsonPath,
    bundlePdfSha256,
    annotationIds,
  };
}
