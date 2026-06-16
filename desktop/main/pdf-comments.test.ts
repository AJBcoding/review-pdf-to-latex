// Safety net for the §5.2 / L4 PDF comments adapter (pdf-comments.ts). The
// load-bearing invariants:
//   - CREATE emits Highlight/StrikeOut/Text dicts that read back with the same
//     subtype, contents, and per-line /QuadPoints (rev-n8 full fidelity);
//   - the §5.2 duplicate-prevention rule: only `app-draft` comments become new
//     annotations, `native-*` rows are never re-emitted;
//   - reply chains round-trip through /IRT, and the read side resolves the /IRT
//     ref back to the parent's commentId (rev-n7);
//   - EDIT stamps a /NM on the first edit of a foreign (un-named) annot so later
//     edits are id-addressed; DELETE removes the ref (and its reply subtree).
//
// Round-trips go through `doc.save()` → `PDFDocument.load()` so we assert what a
// re-opened file actually carries, not just in-memory dict state.

import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFNumber, PDFArray, PDFDict } from 'pdf-lib';
import type { CommentPayload, PdfQuadAnchor, Quad } from '@shared/types.js';
import {
  PDF_CAPABILITIES,
  addCommentsToDoc,
  editAnnotInDoc,
  deleteAnnotFromDoc,
  readAnnotsFromDoc,
  nativeAnnotToPayload,
} from './pdf-comments.js';

const DATE = new Date('2026-06-15T12:00:00.000Z');

// ─── fixture helpers ───────────────────────────────────────────────────────

/** A one-page (612×792 letter) PDF with no annotations. */
async function blankDoc(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return doc;
}

/** Save → reload, so assertions see a genuinely re-opened file. */
async function roundTrip(doc: PDFDocument): Promise<PDFDocument> {
  const bytes = await doc.save();
  return PDFDocument.load(bytes);
}

function pdfQuadAnchor(over: Partial<PdfQuadAnchor> = {}): PdfQuadAnchor {
  return {
    kind: 'pdf-quad',
    page: 1,
    region: { x: 72, y: 698, w: 377, h: 16 },
    ...over,
  };
}

function comment(over: Partial<CommentPayload> = {}): CommentPayload {
  return {
    id: 'c1',
    doc_id: 'doc',
    doc_version: 'v1',
    anchor: pdfQuadAnchor(),
    highlighted_text: 'the quick brown fox',
    comment: 'tighten this',
    redraft: null,
    redraft_suggestion: null,
    engagement_level: 'comment',
    author: 'AJB',
    kind: 'comment',
    status: 'open',
    created_at: DATE.toISOString(),
    origin: 'app-draft',
    native: null,
    ...over,
  };
}

/** Find the first annot dict on a page (post-reload). */
function annotsOnPage(doc: PDFDocument, pageIndex: number): PDFDict[] {
  const page = doc.getPage(pageIndex);
  const arr = page.node.lookup(PDFName.of('Annots'));
  if (!(arr instanceof PDFArray)) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const a = arr.lookup(i, PDFDict);
    if (a) out.push(a);
  }
  return out;
}

function subtypeOf(a: PDFDict): string {
  const s = a.lookup(PDFName.of('Subtype'));
  return s instanceof PDFName ? s.asString().replace(/^\//, '') : '';
}

function quadPointsOf(a: PDFDict): number[] {
  const v = a.lookup(PDFName.of('QuadPoints'));
  if (!(v instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) out.push(v.lookup(i, PDFNumber)!.asNumber());
  return out;
}

// ─── capabilities ──────────────────────────────────────────────────────────

describe('PDF_CAPABILITIES', () => {
  it('declares replies=true (rev-n7 spike passed) and bodyEditable=false', () => {
    expect(PDF_CAPABILITIES.replies).toBe(true);
    expect(PDF_CAPABILITIES.bodyEditable).toBe(false);
    expect(PDF_CAPABILITIES.writeNative).toBe(true);
  });
});

// ─── CREATE ──────────────────────────────────────────────────────────────

describe('addCommentsToDoc — create', () => {
  it('emits a Highlight with stamped /NM and the redraft block in /Contents', async () => {
    const doc = await blankDoc();
    const res = addCommentsToDoc(
      doc,
      [comment({ comment: 'tighten', redraft: 'make it tight' })],
      DATE,
    );
    expect(res.idMap.c1).toBe('annot-1');

    const reloaded = await roundTrip(doc);
    const annots = annotsOnPage(reloaded, 0);
    expect(annots).toHaveLength(1);
    expect(subtypeOf(annots[0])).toBe('Highlight');
    const contents = annots[0].lookup(PDFName.of('Contents'));
    expect(contents instanceof PDFString && contents.decodeText()).toBe('tighten\n[redraft] make it tight');
    const nm = annots[0].lookup(PDFName.of('NM'));
    expect(nm instanceof PDFString && nm.decodeText()).toBe('annot-1');
  });

  it('writes per-line /QuadPoints when the anchor carries quads (rev-n8 fidelity)', async () => {
    // Two visual lines: line 2 is narrower (the rev-n8 collapse trap).
    const quads: Quad[] = [
      { x1: 72, y1: 714, x2: 449, y2: 714, x3: 72, y3: 698, x4: 449, y4: 698 },
      { x1: 72, y1: 698, x2: 300, y2: 698, x3: 72, y3: 682, x4: 300, y4: 682 },
    ];
    const doc = await blankDoc();
    addCommentsToDoc(doc, [comment({ anchor: pdfQuadAnchor({ quads }) })], DATE);

    const reloaded = await roundTrip(doc);
    const annot = annotsOnPage(reloaded, 0)[0];
    const qp = quadPointsOf(annot);
    expect(qp).toHaveLength(16); // 2 quads × 8 numbers — no bbox collapse
    expect(qp).toEqual([
      72, 714, 449, 714, 72, 698, 449, 698,
      72, 698, 300, 698, 72, 682, 300, 682,
    ]);
    // /Rect is the union bbox enclosing both lines.
    const rect = annot.lookup(PDFName.of('Rect'), PDFArray)!.asRectangle();
    expect(rect.x).toBe(72);
    expect(rect.y).toBe(682);
    expect(rect.x + rect.width).toBe(449);
    expect(rect.y + rect.height).toBe(714);
  });

  it('single-region anchor produces one quad (8 numbers) — backward compatible', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(doc, [comment()], DATE);
    const reloaded = await roundTrip(doc);
    expect(quadPointsOf(annotsOnPage(reloaded, 0)[0])).toHaveLength(8);
  });

  it('honors native.subtype for StrikeOut and Text(sticky)', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(
      doc,
      [
        comment({ id: 'strike', native: { comment_id: 'strike', subtype: 'StrikeOut' } }),
        comment({ id: 'note', native: { comment_id: 'note', subtype: 'Text' } }),
      ],
      DATE,
    );
    const reloaded = await roundTrip(doc);
    const annots = annotsOnPage(reloaded, 0);
    const byNm = (nm: string) =>
      annots.find((a) => {
        const v = a.lookup(PDFName.of('NM'));
        return v instanceof PDFString && v.decodeText() === nm;
      })!;
    expect(subtypeOf(byNm('strike'))).toBe('StrikeOut');
    const sticky = byNm('note');
    expect(subtypeOf(sticky)).toBe('Text');
    // Sticky carries no /QuadPoints; it has an icon /Name instead.
    expect(quadPointsOf(sticky)).toHaveLength(0);
    expect(sticky.lookup(PDFName.of('Name'))).toBeInstanceOf(PDFName);
  });

  it('skips out-of-range pages without failing the whole write', async () => {
    const doc = await blankDoc();
    const res = addCommentsToDoc(
      doc,
      [
        comment({ id: 'ok' }),
        comment({ id: 'bad', anchor: pdfQuadAnchor({ page: 99 }) }),
      ],
      DATE,
    );
    expect(res.idMap.ok).toBeDefined();
    expect(res.idMap.bad).toBeUndefined();
    expect(res.skipped).toEqual([{ id: 'bad', reason: 'out-of-range page 99' }]);
  });

  it('duplicate-prevention: native-pdf rows are never re-emitted (§5.2)', async () => {
    const doc = await blankDoc();
    const res = addCommentsToDoc(
      doc,
      [
        comment({ id: 'app' }),
        comment({ id: 'native', origin: 'native-pdf', native: { comment_id: 'foreign-1' } }),
      ],
      DATE,
    );
    expect(Object.keys(res.idMap)).toEqual(['app']);
    const reloaded = await roundTrip(doc);
    expect(annotsOnPage(reloaded, 0)).toHaveLength(1);
  });
});

// ─── REPLIES (rev-n7 /IRT) ─────────────────────────────────────────────────

describe('replies — /IRT chains', () => {
  it('writes a /Text reply pointing at the parent and resolves it on read', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(
      doc,
      [
        comment({ id: 'parent', native: { comment_id: 'parent-hl' } }),
        comment({
          id: 'reply',
          comment: 'I disagree',
          native: { comment_id: 'reply-1', in_reply_to: 'parent-hl' },
        }),
      ],
      DATE,
    );
    const reloaded = await roundTrip(doc);
    const natives = readAnnotsFromDoc(reloaded);
    const reply = natives.find((a) => a.commentId === 'reply-1')!;
    expect(reply.subtype).toBe('Text'); // replies forced to /Text
    expect(reply.inReplyTo).toBe('parent-hl'); // resolved IRT ref → parent id
    const payload = nativeAnnotToPayload(reply, { docId: 'doc', docVersion: 'v1' });
    expect(payload.native?.in_reply_to).toBe('parent-hl');
  });

  it('skips a reply whose parent /NM is not present', async () => {
    const doc = await blankDoc();
    const res = addCommentsToDoc(
      doc,
      [comment({ id: 'reply', native: { comment_id: 'r', in_reply_to: 'ghost' } })],
      DATE,
    );
    expect(res.skipped).toEqual([{ id: 'reply', reason: "reply parent 'ghost' not found" }]);
  });
});

// ─── READ ──────────────────────────────────────────────────────────────

describe('readAnnotsFromDoc — native ingest', () => {
  it('reads an app-written Highlight back into a native record', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(doc, [comment({ comment: 'note text' })], DATE);
    const reloaded = await roundTrip(doc);
    const [a] = readAnnotsFromDoc(reloaded);
    expect(a.subtype).toBe('Highlight');
    expect(a.commentId).toBe('annot-1');
    expect(a.hasName).toBe(true);
    expect(a.contents).toBe('note text');
    expect(a.author).toBe('AJB');
    expect(a.pageIndex).toBe(0);
    expect(a.quads).toHaveLength(1);
  });

  it('falls back to a (page,index) handle id for a foreign annot lacking /NM', async () => {
    const doc = await blankDoc();
    appendForeignHighlight(doc, 0); // hand-built, no /NM
    const reloaded = await roundTrip(doc);
    const [a] = readAnnotsFromDoc(reloaded);
    expect(a.hasName).toBe(false);
    expect(a.commentId).toBe('p0-i0');
    expect(a.pageIndex).toBe(0);
    expect(a.annotIndex).toBe(0);
  });

  it('maps a native annot to a native-pdf payload with the page+1 anchor', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(doc, [comment()], DATE);
    const reloaded = await roundTrip(doc);
    const [a] = readAnnotsFromDoc(reloaded);
    const payload = nativeAnnotToPayload(a, { docId: 'doc', docVersion: 'v1' });
    expect(payload.origin).toBe('native-pdf');
    expect(payload.anchor.kind).toBe('pdf-quad');
    expect((payload.anchor as PdfQuadAnchor).page).toBe(1);
    expect(payload.native?.page_index).toBe(0);
    expect(payload.native?.annot_index).toBe(0);
  });
});

// ─── EDIT ──────────────────────────────────────────────────────────────

describe('editAnnotInDoc', () => {
  it('edits by /NM and refreshes /Contents', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(doc, [comment({ native: { comment_id: 'hl-1' } })], DATE);
    const res = editAnnotInDoc(doc, { nm: 'hl-1' }, 'rewritten', DATE);
    expect(res).toEqual({ ok: true, name: 'hl-1' });
    const reloaded = await roundTrip(doc);
    const a = annotsOnPage(reloaded, 0)[0];
    const c = a.lookup(PDFName.of('Contents'));
    expect(c instanceof PDFString && c.decodeText()).toBe('rewritten');
  });

  it('stamps /NM on the first edit of a foreign annot, then is id-addressed', async () => {
    const doc = await blankDoc();
    appendForeignHighlight(doc, 0);
    const first = editAnnotInDoc(doc, { pageIndex: 0, annotIndex: 0 }, 'edited once', DATE);
    expect(first.ok).toBe(true);
    expect(first.name).toBe('annot-p0-i0'); // deterministic stamped name
    // Now addressable by that /NM.
    const second = editAnnotInDoc(doc, { nm: 'annot-p0-i0' }, 'edited twice', DATE);
    expect(second).toEqual({ ok: true, name: 'annot-p0-i0' });
    const reloaded = await roundTrip(doc);
    const c = annotsOnPage(reloaded, 0)[0].lookup(PDFName.of('Contents'));
    expect(c instanceof PDFString && c.decodeText()).toBe('edited twice');
  });

  it('returns ok:false for a missing handle', async () => {
    const doc = await blankDoc();
    expect(editAnnotInDoc(doc, { nm: 'nope' }, 'x', DATE)).toEqual({ ok: false, name: null });
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────

describe('deleteAnnotFromDoc', () => {
  it('removes the annot from /Annots', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(
      doc,
      [comment({ id: 'a', native: { comment_id: 'keep' } }), comment({ id: 'b', native: { comment_id: 'drop' } })],
      DATE,
    );
    const res = deleteAnnotFromDoc(doc, { nm: 'drop' });
    expect(res.ok).toBe(true);
    expect(res.removed).toEqual(['drop']);
    const reloaded = await roundTrip(doc);
    const names = annotsOnPage(reloaded, 0).map((a) => {
      const v = a.lookup(PDFName.of('NM'));
      return v instanceof PDFString ? v.decodeText() : null;
    });
    expect(names).toEqual(['keep']);
  });

  it('cascades to the reply subtree so no dangling /IRT survives', async () => {
    const doc = await blankDoc();
    addCommentsToDoc(
      doc,
      [
        comment({ id: 'p', native: { comment_id: 'parent' } }),
        comment({ id: 'r1', native: { comment_id: 'reply-1', in_reply_to: 'parent' } }),
        comment({ id: 'r2', native: { comment_id: 'reply-2', in_reply_to: 'reply-1' } }),
      ],
      DATE,
    );
    const res = deleteAnnotFromDoc(doc, { nm: 'parent' });
    expect(res.removed.sort()).toEqual(['parent', 'reply-1', 'reply-2']);
    const reloaded = await roundTrip(doc);
    expect(annotsOnPage(reloaded, 0)).toHaveLength(0);
  });

  it('returns ok:false when the handle does not resolve', async () => {
    const doc = await blankDoc();
    expect(deleteAnnotFromDoc(doc, { nm: 'ghost' })).toEqual({ ok: false, removed: [] });
  });
});

// ─── foreign-annot fixture (hand-built, no /NM) ────────────────────────────

/** Append a /Highlight with NO /NM to a page — simulates an annot authored in
 *  Acrobat (foreign), which the adapter must locate by (page,index) handle. */
function appendForeignHighlight(doc: PDFDocument, pageIndex: number): void {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const dict = ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Highlight'),
    Rect: ctx.obj([72, 698, 449, 714]),
    QuadPoints: ctx.obj([72, 714, 449, 714, 72, 698, 449, 698]),
    Contents: PDFString.of('a foreign comment'),
    T: PDFString.of('Acrobat User'),
    F: PDFNumber.of(4),
    C: ctx.obj([1, 1, 0]),
    CA: PDFNumber.of(0.4),
    P: page.ref,
  });
  const ref = ctx.register(dict);
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
}
