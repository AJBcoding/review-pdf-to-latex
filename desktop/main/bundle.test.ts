// Safety net for the §10.4 bundle writer (rev-x1). writeBundle is the single
// path that lays /Highlight annotations onto the source PDF — a quad-point
// ordering regression or a lost out-of-range guard corrupts every exported
// bundle silently. We round-trip through a real pdf-lib document: build a
// source PDF, run writeBundle, re-load the rendered bundle, and assert the
// annotation geometry + the JSON sidecar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFNumber,
  PDFDict,
} from 'pdf-lib';
import { writeBundle } from './bundle.js';
import { ENGAGEMENT_PALETTE } from '@shared/bundle.js';
import type {
  BundleJsonFile,
  BundleWriteRequest,
  CommentPayload,
  EngagementLevel,
} from '@shared/types.js';

let testDir: string;
let projectRoot: string;
let sourcePath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectRoot = join(testDir, 'project');
  sourcePath = join(projectRoot, 'report-1.0.pdf');
  await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write a fresh source PDF with `pageCount` letter-size pages. */
async function writeSourcePdf(pageCount: number): Promise<void> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  await writeFile(sourcePath, await doc.save());
}

let idCounter = 0;
function makeComment(overrides: Partial<CommentPayload> = {}): CommentPayload {
  idCounter += 1;
  return {
    id: `c${idCounter}`,
    doc_id: sourcePath,
    doc_version: 'sha-abc',
    anchor: { page: 1, region: { x: 100, y: 200, w: 50, h: 20 } },
    highlighted_text: 'text',
    comment: 'a comment',
    redraft: null,
    redraft_suggestion: null,
    engagement_level: 'comment',
    author: 'AJB',
    kind: 'comment',
    status: 'open',
    created_at: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

function bundleReq(comments: CommentPayload[], pageCount: number): BundleWriteRequest {
  return {
    sourcePath,
    sourceSha256: 'sha-abc',
    pageCount,
    comments,
    appVersion: '0.0.1',
    author: 'AJB',
  };
}

/** Pull the /Annots array off a 0-indexed page of a rendered bundle PDF. */
function pageAnnots(doc: PDFDocument, pageIndex: number): PDFArray | undefined {
  const node = doc.getPage(pageIndex).node;
  const annots = node.lookup(PDFName.of('Annots'));
  return annots instanceof PDFArray ? annots : undefined;
}

function numbersOf(arr: PDFArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    out.push(arr.lookup(i, PDFNumber).asNumber());
  }
  return out;
}

async function loadBundle(path: string): Promise<PDFDocument> {
  return PDFDocument.load(await readFile(path));
}

describe('writeBundle — QuadPoints geometry', () => {
  it('emits one quad in Acrobat UL/UR/LL/LR order with a matching /Rect', async () => {
    await writeSourcePdf(1);
    const region = { x: 100, y: 200, w: 50, h: 20 };
    const res = await writeBundle(
      bundleReq([makeComment({ id: 'q1', anchor: { page: 1, region } })], 1),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const doc = await loadBundle(res.bundlePdfPath);
    const annots = pageAnnots(doc, 0);
    expect(annots).toBeDefined();
    const annot = annots!.lookup(0, PDFDict);

    const qp = numbersOf(annot.lookup(PDFName.of('QuadPoints'), PDFArray));
    const { x, y, w, h } = region;
    expect(qp).toEqual([
      x, y + h, // UL
      x + w, y + h, // UR
      x, y, // LL
      x + w, y, // LR
    ]);

    const rect = numbersOf(annot.lookup(PDFName.of('Rect'), PDFArray));
    expect(rect).toEqual([x, y, x + w, y + h]);
  });

  it('colors the highlight from the engagement palette and sets /CA opacity', async () => {
    await writeSourcePdf(1);
    const level: EngagementLevel = 'surface';
    const res = await writeBundle(
      bundleReq([makeComment({ id: 'colored', engagement_level: level })], 1),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const doc = await loadBundle(res.bundlePdfPath);
    const annot = pageAnnots(doc, 0)!.lookup(0, PDFDict);

    const color = numbersOf(annot.lookup(PDFName.of('C'), PDFArray));
    const palette = ENGAGEMENT_PALETTE[level];
    color.forEach((channel, i) => expect(channel).toBeCloseTo(palette.pdfC[i], 5));
    expect(annot.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBeCloseTo(palette.pdfCA, 5);
  });

  it('stamps the minted annotation id into /NM so the JSON link round-trips', async () => {
    await writeSourcePdf(1);
    const res = await writeBundle(bundleReq([makeComment({ id: 'nm' })], 1));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const mapped = res.annotationIds.find((a) => a.commentId === 'nm');
    expect(mapped).toBeDefined();

    const doc = await loadBundle(res.bundlePdfPath);
    const annot = pageAnnots(doc, 0)!.lookup(0, PDFDict);
    const nm = annot.lookup(PDFName.of('NM'));
    // PDFString — toString wraps the literal in parens; assert it carries the id.
    expect(nm?.toString()).toContain(mapped!.pdfAnnotationId);
  });
});

describe('writeBundle — out-of-range page skip', () => {
  it('skips comments whose page exceeds the page count without failing the write', async () => {
    await writeSourcePdf(1); // only page 1 exists
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await writeBundle(
      bundleReq(
        [
          makeComment({ id: 'on-page-1', anchor: { page: 1, region: { x: 1, y: 1, w: 2, h: 2 } } }),
          makeComment({ id: 'out-of-range', anchor: { page: 5, region: { x: 1, y: 1, w: 2, h: 2 } } }),
        ],
        1,
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Only the in-range comment got an annotation id.
    expect(res.annotationIds.map((a) => a.commentId)).toEqual(['on-page-1']);
    expect(warn).toHaveBeenCalled();

    // The rendered PDF page 1 carries exactly one annotation.
    const doc = await loadBundle(res.bundlePdfPath);
    expect(pageAnnots(doc, 0)!.size()).toBe(1);

    // The JSON sidecar freezes both comments but leaves the skipped one's
    // pdf_annotation_id null (no annotation exists for it).
    const json: BundleJsonFile = JSON.parse(await readFile(res.bundleJsonPath, 'utf8'));
    const byId = new Map(json.comments.map((c) => [c.id, c.pdf_annotation_id]));
    expect(byId.get('on-page-1')).toBeTruthy();
    expect(byId.get('out-of-range')).toBeNull();
  });

  it('skips page 0 and negative pages (below the 1-indexed floor)', async () => {
    await writeSourcePdf(2);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await writeBundle(
      bundleReq(
        [
          makeComment({ id: 'page-0', anchor: { page: 0, region: { x: 1, y: 1, w: 2, h: 2 } } }),
          makeComment({ id: 'page-neg', anchor: { page: -1, region: { x: 1, y: 1, w: 2, h: 2 } } }),
          makeComment({ id: 'page-2', anchor: { page: 2, region: { x: 1, y: 1, w: 2, h: 2 } } }),
        ],
        2,
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.annotationIds.map((a) => a.commentId)).toEqual(['page-2']);
  });
});

describe('writeBundle — guards', () => {
  it('rejects comments carrying md_anchor (C5 PDF-only guard)', async () => {
    await writeSourcePdf(1);
    const res = await writeBundle(
      bundleReq(
        [
          makeComment({
            id: 'md',
            md_anchor: { char_start: 0, char_end: 1, prefix: '', suffix: '', quoted_text: 'x' },
          }),
        ],
        1,
      ),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('render_failed');
    expect(res.error).toContain('md_anchor');
  });

  it('returns source_not_found when the source PDF is missing', async () => {
    // No writeSourcePdf() call — sourcePath does not exist.
    const res = await writeBundle(bundleReq([makeComment()], 1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('source_not_found');
  });
});
