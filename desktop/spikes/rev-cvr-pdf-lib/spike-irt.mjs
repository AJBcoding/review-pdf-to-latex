// Spike S-1 (rev-n7): PDF /IRT reply chains — READ and WRITE halves.
//
// Companion to spike.mjs (rev-cvr), which proved the §10.4 markup-annotation
// shapes + the PDF.js→pdf-lib coord transform but did NOT exercise /IRT
// (reply threading). A fresh grep over that spike's artifacts found zero
// /IRT hits, so even read-only display of reply threads was unproven. The
// unified-comment-model spec gates `native.in_reply_to` on this spike
// (docs/specs/2026-06-12-unified-comment-model-and-roundtrip.md §8, S-1).
//
// This spike resolves both halves programmatically:
//
//  WRITE (pdf-lib):  build a /Text reply annotation carrying /IRT (a ref to a
//                    parent /Highlight) + /RT /R (reply type), plus a
//                    depth-2 reply (reply-to-reply), and save. PDF 1.7
//                    §12.5.2 (/IRT, /RT) territory.
//  READ #1 (pdf-lib walk):  reload the written file, resolve each /IRT ref to
//                    its parent annotation, and reconstruct the thread. This
//                    is the authoritative structural proof.
//  READ #2 (pdf.js getAnnotations):  the path the RENDERER actually uses
//                    (spec §8: "READ + DISPLAY (renderer) — page.getAnnotations()").
//                    pdf.js exposes `.id`, `.inReplyTo` (parent id string),
//                    and `.replyType` ('R'|'Group') on each annotation —
//                    confirm the chain is visible through that API.
//  ROUND-TRIP:       re-save the written file with pdf-lib (a structural
//                    re-save, the kind any editor performs) and re-read both
//                    ways — confirm the /IRT chain survives.
//
// What this spike CANNOT do headless: open the file in Adobe Acrobat and
// eyeball the thread in its comment panel. That is the manual verification
// step inherent to the spike (see the dated note in
// docs/research/2026-06-13-pdf-irt-reply-chains-spike/). The programmatic
// proof here — well-formed /IRT dicts that pdf.js parses as replies and that
// survive a re-save — is strong evidence the WRITE half is viable; the README
// records the manual Acrobat confirmation as the remaining checkbox.
//
// Run from desktop/ with:  node spikes/rev-cvr-pdf-lib/spike-irt.mjs
//
// Inputs:
//   ../tests/fixtures/sample-annotated.pdf  (612x792 letter, 2 /Highlight annots)
//
// Outputs (in this dir):
//   out-threaded.pdf          — fixture + a Highlight with a 2-deep reply chain
//   out-threaded-resaved.pdf  — out-threaded.pdf re-saved (round-trip survival)
//   threaded.readback.json    — reconstructed thread (pdf-lib walk + pdf.js)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFRef,
} from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../../tests/fixtures/sample-annotated.pdf');

// ─── shared builders (mirrors spike.mjs shapes; see that file's comments) ───

function pdfDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Build + register a /Highlight. Returns its PDFRef so replies can /IRT it. */
function addHighlight(doc, page, { regions, contents, author, colorRGB, opacity = 0.4, nm }) {
  const ctx = doc.context;
  const xs = regions.flatMap((r) => [r.x, r.x + r.w]);
  const ys = regions.flatMap((r) => [r.y, r.y + r.h]);
  const quads = [];
  for (const r of regions) {
    quads.push(r.x, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y);
  }
  const dict = ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Highlight'),
    Rect: ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]),
    QuadPoints: ctx.obj(quads),
    Contents: PDFString.of(contents),
    T: PDFString.of(author),
    M: PDFString.of(pdfDate()),
    NM: PDFString.of(nm),                 // stable annotation name → maps to native.comment_id
    F: PDFNumber.of(4),
    C: ctx.obj(colorRGB),
    CA: PDFNumber.of(opacity),
    P: page.ref,
  });
  const ref = ctx.register(dict);
  pushAnnot(doc, page, ref);
  return ref;
}

/** Build + register a /Text reply.
 *
 *  The load-bearing fields (PDF 1.7 §12.5.2):
 *    /IRT — "In Reply To": a REFERENCE (PDFRef) to the annotation being
 *           replied to. NOT a string id — an indirect object reference.
 *    /RT  — "Reply Type": /R = a threaded reply (the comment-panel thread
 *           we want). /Group = grouped-but-not-threaded (do not use here).
 *
 *  Acrobat additionally expects a reply to be a /Text (or other markup)
 *  annotation; we use /Text. The reply's /Rect conventionally overlaps the
 *  parent so the icon lands on the same anchor; thread order is by /IRT +
 *  /M (mod date), not geometry. */
function addReply(doc, page, { irtRef, contents, author, colorRGB = [0, 0.5, 1], nm }) {
  const ctx = doc.context;
  // Anchor the reply icon near the parent's rect; harmless if it overlaps.
  const dict = ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: ctx.obj([500, 700, 520, 720]),
    Contents: PDFString.of(contents),
    T: PDFString.of(author),
    M: PDFString.of(pdfDate()),
    NM: PDFString.of(nm),
    F: PDFNumber.of(4),
    C: ctx.obj(colorRGB),
    CA: PDFNumber.of(1),
    Name: PDFName.of('Note'),
    Open: false,
    IRT: irtRef,                          // ← the reply pointer (indirect ref)
    RT: PDFName.of('R'),                  // ← threaded-reply type
    P: page.ref,
  });
  const ref = ctx.register(dict);
  pushAnnot(doc, page, ref);
  return ref;
}

function pushAnnot(doc, page, ref) {
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

// ─── WRITE half ─────────────────────────────────────────────────────────────

async function writeThreaded() {
  const doc = await PDFDocument.load(readFileSync(FIXTURE));
  const page = doc.getPages()[0];

  const parentRef = addHighlight(doc, page, {
    regions: [{ x: 72, y: 698, w: 377, h: 16 }],
    contents: 'spike: parent highlight — the comment being replied to',
    author: 'AJB',
    colorRGB: [1, 1, 0],
    nm: 'spike-irt-parent',
  });

  const reply1Ref = addReply(doc, page, {
    irtRef: parentRef,
    contents: 'spike: reply #1 — /IRT points at the parent highlight',
    author: 'Reviewer-2',
    nm: 'spike-irt-reply-1',
  });

  // Depth-2: a reply to the reply. Acrobat threads /IRT chains transitively;
  // our reader must follow the chain, not just one hop.
  addReply(doc, page, {
    irtRef: reply1Ref,
    contents: 'spike: reply #2 — /IRT points at reply #1 (depth-2 chain)',
    author: 'AJB',
    nm: 'spike-irt-reply-2',
  });

  const bytes = await doc.save();
  const out = resolve(__dirname, 'out-threaded.pdf');
  writeFileSync(out, bytes);
  console.log(`[write] wrote ${out} (${bytes.length} bytes) — 1 highlight + 2-deep reply chain`);
  return out;
}

// ─── READ #1: pdf-lib walk (authoritative structural read) ──────────────────
//
// For each annot we record its own ref-key, /NM, /Subtype, and — if it has
// /IRT — the ref-key + /NM of the annotation it replies to. The /IRT value is
// retrieved with .get() (NOT .lookup()) so we see the raw PDFRef and can map
// it to the parent's identity without the resolver collapsing it.

function refKey(ref) {
  return ref instanceof PDFRef ? `${ref.objectNumber}R` : null;
}

function readThreadPdfLib(srcPath) {
  const doc = PDFDocument.load(readFileSync(srcPath), { updateMetadata: false });
  return doc.then((d) => {
    const records = [];
    for (let i = 0; i < d.getPageCount(); i++) {
      const page = d.getPage(i);
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (!(annots instanceof PDFArray)) continue;
      for (let j = 0; j < annots.size(); j++) {
        const ownRef = annots.get(j);                 // PDFRef to this annot
        const a = annots.lookup(j, PDFDict);
        if (!a) continue;
        const subtype = a.lookup(PDFName.of('Subtype'));
        const nm = a.lookup(PDFName.of('NM'));
        const rt = a.lookup(PDFName.of('RT'));
        const irt = a.get(PDFName.of('IRT'));         // raw — PDFRef if present
        let parentNm = null;
        if (irt instanceof PDFRef) {
          const parentDict = d.context.lookup(irt, PDFDict);
          const pnm = parentDict?.lookup(PDFName.of('NM'));
          parentNm = pnm instanceof PDFString || pnm instanceof PDFHexString ? pnm.decodeText() : null;
        }
        records.push({
          refKey: refKey(ownRef instanceof PDFRef ? ownRef : null),
          subtype: subtype instanceof PDFName ? subtype.asString().slice(1) : null,
          nm: nm instanceof PDFString || nm instanceof PDFHexString ? nm.decodeText() : null,
          replyType: rt instanceof PDFName ? rt.asString().slice(1) : null,
          inReplyToRef: irt instanceof PDFRef ? refKey(irt) : null,
          inReplyToNm: parentNm,          // ← native.in_reply_to maps to THIS
        });
      }
    }
    return records;
  });
}

// ─── READ #2: pdf.js getAnnotations (the renderer's actual path) ────────────

async function readThreadPdfjs(srcPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(srcPath));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const records = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    for (const a of await page.getAnnotations()) {
      records.push({
        id: a.id,
        subtype: a.subtype,
        // pdf.js surfaces the parent as `inReplyTo` (parent id string) and
        // `replyType` ('R'|'Group'). These are exactly what the renderer needs
        // to populate native.in_reply_to + thread the card stream.
        inReplyTo: a.inReplyTo ?? null,
        replyType: a.replyType ?? null,
      });
    }
  }
  await doc.destroy?.();
  return records;
}

// ─── ROUND-TRIP: re-save and confirm the chain survives ─────────────────────

async function resave(srcPath) {
  const doc = await PDFDocument.load(readFileSync(srcPath));
  const bytes = await doc.save();
  const out = resolve(__dirname, 'out-threaded-resaved.pdf');
  writeFileSync(out, bytes);
  console.log(`[round-trip] re-saved → ${out} (${bytes.length} bytes)`);
  return out;
}

// ─── verification helpers ───────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** A correct thread: reply-1 → parent, reply-2 → reply-1, parent has no IRT. */
function verifyChain(label, pdflibRecs) {
  const byNm = Object.fromEntries(pdflibRecs.filter((r) => r.nm).map((r) => [r.nm, r]));
  assert(byNm['spike-irt-parent'], `${label}: parent present`);
  assert(byNm['spike-irt-parent'].inReplyToNm === null, `${label}: parent has no /IRT`);
  assert(byNm['spike-irt-reply-1'], `${label}: reply-1 present`);
  assert(byNm['spike-irt-reply-1'].inReplyToNm === 'spike-irt-parent',
    `${label}: reply-1 /IRT → parent (got ${byNm['spike-irt-reply-1'].inReplyToNm})`);
  assert(byNm['spike-irt-reply-1'].replyType === 'R', `${label}: reply-1 /RT = R`);
  assert(byNm['spike-irt-reply-2'], `${label}: reply-2 present`);
  assert(byNm['spike-irt-reply-2'].inReplyToNm === 'spike-irt-reply-1',
    `${label}: reply-2 /IRT → reply-1 (got ${byNm['spike-irt-reply-2'].inReplyToNm})`);
  console.log(`[verify] ${label}: /IRT chain parent ← reply-1 ← reply-2 intact ✔`);
}

/** pdf.js read: confirm at least the two replies carry inReplyTo + replyType. */
function verifyPdfjs(label, recs) {
  const replies = recs.filter((r) => r.inReplyTo);
  assert(replies.length >= 2, `${label}: pdf.js sees ≥2 replies (got ${replies.length})`);
  for (const r of replies) {
    assert(r.replyType === 'R', `${label}: pdf.js replyType=R for ${r.id} (got ${r.replyType})`);
  }
  console.log(`[verify] ${label}: pdf.js getAnnotations exposes inReplyTo+replyType on ${replies.length} replies ✔`);
}

// ─── run all ────────────────────────────────────────────────────────────────

const threaded = await writeThreaded();

const pdflib1 = await readThreadPdfLib(threaded);
verifyChain('written (pdf-lib)', pdflib1);
const pdfjs1 = await readThreadPdfjs(threaded);
verifyPdfjs('written (pdf.js)', pdfjs1);

const resaved = await resave(threaded);
const pdflib2 = await readThreadPdfLib(resaved);
verifyChain('re-saved (pdf-lib)', pdflib2);
const pdfjs2 = await readThreadPdfjs(resaved);
verifyPdfjs('re-saved (pdf.js)', pdfjs2);

const report = {
  spike: 'rev-n7 / S-1 — PDF /IRT reply chains',
  date: '2026-06-13',
  written: { pdfLibWalk: pdflib1, pdfjsGetAnnotations: pdfjs1 },
  reSaved: { pdfLibWalk: pdflib2, pdfjsGetAnnotations: pdfjs2 },
};
const outJson = resolve(__dirname, 'threaded.readback.json');
writeFileSync(outJson, JSON.stringify(report, null, 2));
console.log(`[report] wrote ${outJson}`);

console.log('\nspike OK (programmatic). Manual step: open out-threaded.pdf in Adobe ' +
            'Acrobat, confirm the highlight shows a 2-reply thread in the comment ' +
            'panel; add a reply in Acrobat, save, re-run this script against the ' +
            'Acrobat-saved file to confirm round-trip both directions.');
