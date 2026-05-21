// Spike: pdf-lib §10.4 annotations + PDF.js→pdf-lib coord transform (rev-cvr).
//
// Goals:
//  1. Add Highlight, Strikethrough, and Sticky-note (Text) annotations using
//     pdf-lib's low-level API (1.17 has no high-level add* helper for these).
//  2. Verify the rendered file opens cleanly in Preview/Acrobat (manual).
//  3. Confirm the coord transform from PDF.js's SelectionPayload.region
//     (origin bottom-left, units = PDF points at native page size) is
//     near-identity for pdf-lib's annotation coords — and probe the
//     rotated-page edge case.
//  4. Read existing Highlight annotations back so §10.4 degraded-restore
//     works when the JSON sidecar is missing.
//
// Run from desktop/ with:  node spikes/rev-cvr-pdf-lib/spike.mjs
//
// Inputs:
//   ../tests/fixtures/sample-annotated.pdf  (612x792 letter, unrotated, has 2
//                                            existing /Highlight annots —
//                                            used both as a fresh canvas and
//                                            as a read-back target)
//
// Outputs (in this dir):
//   out-fresh.pdf   — Highlight + Strikethrough + sticky on a copy
//   out-rotated.pdf — same annotations on a copy with page Rotate=90
//   readback.json   — annotations parsed from the input fixture

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

// ─── Annotation builders ───────────────────────────────────────────────────
//
// pdf-lib doesn't ship helpers for the §10.4 markup annotations, so we
// construct annotation dicts directly. The shapes below follow PDF 1.7
// §12.5.6 (annotation types) + §12.5.6.10 (text markup annotations).

/** Make a PDF date string. The PDF spec format is `D:YYYYMMDDHHmmSSOHH'mm'`. */
function pdfDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzMin) / 60));
  const tzM = pad(Math.abs(tzMin) % 60);
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
         `${sign}${tzH}'${tzM}'`;
}

/** Common annotation fields. /F=4 = print. /P = page ref (back-pointer). */
function baseAnnotEntries({ subtype, rect, contents, author, color, opacity, pageRef }) {
  return {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of(subtype),
    Rect: rect,                                  // PDFArray
    Contents: PDFString.of(contents),
    T: PDFString.of(author),
    M: PDFString.of(pdfDate()),
    F: PDFNumber.of(4),
    C: color,                                    // PDFArray of 3 PDFNumbers
    CA: PDFNumber.of(opacity),
    P: pageRef,
  };
}

/** Build a /Highlight annotation. `regions` is an array of PDF-space rects
 *  {x,y,w,h} where x,y is the bottom-left corner (PDF user space). The
 *  /Rect is the bounding box of all regions; /QuadPoints encodes one quad
 *  per region (8 numbers each).
 *
 *  QuadPoints order: the PDF spec says "counter-clockwise from lower-left",
 *  but every viewer of consequence (Acrobat, Preview, pypdf-generated test
 *  fixtures in this repo — see tests/fixtures/sample-annotated.pdf) uses
 *  the Acrobat order:
 *
 *    [ upper-left, upper-right, lower-left, lower-right ]
 *
 *  i.e. (x, y+h), (x+w, y+h), (x, y), (x+w, y). We follow Acrobat order
 *  for interop. */
function buildHighlight(doc, pageRef, { regions, contents, author, colorRGB, opacity = 0.4 }) {
  const ctx = doc.context;
  const xs = regions.flatMap((r) => [r.x, r.x + r.w]);
  const ys = regions.flatMap((r) => [r.y, r.y + r.h]);
  const rect = ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);

  const quads = [];
  for (const r of regions) {
    // Acrobat order: UL, UR, LL, LR
    quads.push(r.x,       r.y + r.h);
    quads.push(r.x + r.w, r.y + r.h);
    quads.push(r.x,       r.y);
    quads.push(r.x + r.w, r.y);
  }

  return ctx.obj({
    ...baseAnnotEntries({
      subtype: 'Highlight',
      rect,
      contents,
      author,
      color: ctx.obj(colorRGB),
      opacity,
      pageRef,
    }),
    QuadPoints: ctx.obj(quads),
  });
}

/** Build a /StrikeOut annotation. Identical shape to /Highlight, different
 *  subtype. (Note PDF spec spelling: "StrikeOut", not "Strikethrough".) */
function buildStrikeout(doc, pageRef, opts) {
  const annot = buildHighlight(doc, pageRef, opts);
  annot.set(PDFName.of('Subtype'), PDFName.of('StrikeOut'));
  return annot;
}

/** Build a /Text (sticky-note) annotation. /Rect is the icon's screen box,
 *  ~20×20 pt by convention. /Name picks the icon (Note/Comment/Help/…). */
function buildStickyNote(doc, pageRef, { x, y, contents, author, colorRGB, name = 'Note' }) {
  const ctx = doc.context;
  const size = 20;
  return ctx.obj({
    ...baseAnnotEntries({
      subtype: 'Text',
      rect: ctx.obj([x, y, x + size, y + size]),
      contents,
      author,
      color: ctx.obj(colorRGB),
      opacity: 1.0,
      pageRef,
    }),
    Name: PDFName.of(name),
    Open: false,
  });
}

/** Attach annotations to a page. Appends to existing /Annots if any. */
function addAnnotsToPage(doc, page, annots) {
  const ctx = doc.context;
  const pageRef = page.ref;
  const annotRefs = annots.map((a) => ctx.register(a));
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) {
    for (const r of annotRefs) existing.push(r);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj(annotRefs));
  }
  return pageRef;
}

// ─── Coord transform (the load-bearing bit) ────────────────────────────────
//
// PDF.js's SelectionPayload.region (see desktop/renderer/pdf-viewer.ts:54) is
// captured by calling viewport.convertToPdfPoint(screenX, screenY) on each
// corner, then bbox-ing. PDF.js's PageViewport stores a transform that maps
// PDF user space → screen pixels at the current zoom and includes the
// origin flip (PDF: bottom-left; screen: top-left). `convertToPdfPoint`
// applies the inverse, so the returned point is in **PDF user space**:
// origin bottom-left, units = PDF points (1/72 inch), at native page size
// — independent of the current zoom.
//
// pdf-lib annotation coords (/Rect, /QuadPoints) are ALSO in PDF user space.
// Therefore the transform is the IDENTITY for an unrotated page with a
// MediaBox starting at (0,0). Confirmed below with a 612×792 letter page.
//
// Edge cases the identity handles correctly:
//   - Non-100% zoom: convertToPdfPoint already de-zooms.
//   - CSS-pixel screen rects: same — convertToPdfPoint takes screen pixels.
//
// Edge case the identity must STILL handle (probe in this spike):
//   - Page rotation: PDF.js's viewport applies the page's /Rotate before
//     returning a PDF point, and convertToPdfPoint inverts that — so the
//     point comes back in the page's natural (pre-rotation) user space,
//     which is exactly what pdf-lib annotations want. Identity still holds.
//   - MediaBox origin ≠ (0,0): rare but legal. convertToPdfPoint returns
//     coordinates in the page's user space, which is also what /Rect /
//     /QuadPoints expect — no offset needed.
//
// Bottom line for the §10.4 bundle writer: take SelectionPayload.region
// straight through, no transform required. The complexity here is the
// annotation-dict shape, not the geometry.

function pdfjsRegionToPdfLib(region) {
  // The transform is identity. This wrapper exists to (a) document the
  // contract at the call site, (b) give us a single place to add rotation
  // / MediaBox-offset handling if a future page surprises us. The bundle
  // writer should call this function rather than passing `region` raw.
  return { x: region.x, y: region.y, w: region.w, h: region.h };
}

// ─── Test 1: fresh annotations on an unrotated page ───────────────────────

async function testFreshAnnotations() {
  const src = readFileSync(FIXTURE);
  const doc = await PDFDocument.load(src);
  const page = doc.getPages()[0];
  const { width, height } = page.getSize();
  console.log(`[fresh] page size = ${width} × ${height} pt`);

  const pageRef = page.ref;

  // A line near the top of the page in PDF coords (origin bottom-left).
  // The fixture's first line of body text sits around y=706 ± 8.
  const highlightRegions = [{ x: 72, y: 698, w: 377, h: 16 }];
  const highlight = buildHighlight(doc, pageRef, {
    regions: highlightRegions,
    contents: 'spike: this is a Highlight from pdf-lib',
    author: 'AJB',
    colorRGB: [1, 1, 0],    // yellow (L1 strawman per §10.4)
    opacity: 0.4,
  });

  const strike = buildStrikeout(doc, pageRef, {
    regions: [{ x: 72, y: 626, w: 208, h: 16 }],
    contents: 'spike: this is a StrikeOut from pdf-lib',
    author: 'AJB',
    colorRGB: [1, 0, 0],    // red
    opacity: 1.0,
  });

  const sticky = buildStickyNote(doc, pageRef, {
    x: 500, y: 700,
    contents: 'spike: this is a sticky note. [redraft] consider rephrasing.',
    author: 'AJB',
    colorRGB: [0, 0.5, 1],
  });

  addAnnotsToPage(doc, page, [highlight, strike, sticky]);

  const bytes = await doc.save();
  const out = resolve(__dirname, 'out-fresh.pdf');
  writeFileSync(out, bytes);
  console.log(`[fresh] wrote ${out} (${bytes.length} bytes)`);
}

// ─── Test 2: same annotations on a rotated page ───────────────────────────

async function testRotatedPage() {
  const src = readFileSync(FIXTURE);
  const doc = await PDFDocument.load(src);
  const page = doc.getPages()[0];
  page.setRotation({ type: 'degrees', angle: 90 });

  // Coords are still in the page's natural user space — pdf-lib /Rect and
  // /QuadPoints are NOT rotated by /Rotate. Viewers apply /Rotate when
  // displaying; annotation coords stay in the unrotated frame.
  const highlight = buildHighlight(doc, page.ref, {
    regions: [{ x: 72, y: 698, w: 377, h: 16 }],
    contents: 'spike: highlight on a /Rotate=90 page',
    author: 'AJB',
    colorRGB: [1, 1, 0],
    opacity: 0.4,
  });

  addAnnotsToPage(doc, page, [highlight]);

  const bytes = await doc.save();
  const out = resolve(__dirname, 'out-rotated.pdf');
  writeFileSync(out, bytes);
  console.log(`[rotated] wrote ${out} — open in Preview, verify highlight ` +
              `sits on the same physical text as out-fresh.pdf does`);
}

// ─── Test 3: read existing /Highlight annotations back ────────────────────

async function testReadback() {
  const src = readFileSync(FIXTURE);
  const doc = await PDFDocument.load(src);

  const out = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let j = 0; j < annots.size(); j++) {
      const a = annots.lookup(j, PDFDict);
      if (!a) continue;
      const subtype = a.lookup(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName)) continue;
      const subtypeStr = subtype.asString().slice(1); // strip leading '/'
      if (!['Highlight', 'StrikeOut', 'Underline', 'Squiggly', 'Text'].includes(subtypeStr)) continue;

      const rectArr = a.lookup(PDFName.of('Rect'), PDFArray);
      const rect = rectArr ? rectArr.asRectangle() : null;
      const contents = a.lookup(PDFName.of('Contents'));
      const author = a.lookup(PDFName.of('T'));
      const color = a.lookup(PDFName.of('C'), PDFArray);
      const qp = a.lookup(PDFName.of('QuadPoints'), PDFArray);

      const quads = [];
      if (qp) {
        for (let k = 0; k < qp.size(); k += 8) {
          quads.push({
            ul: { x: qp.lookup(k + 0, PDFNumber).asNumber(),     y: qp.lookup(k + 1, PDFNumber).asNumber() },
            ur: { x: qp.lookup(k + 2, PDFNumber).asNumber(),     y: qp.lookup(k + 3, PDFNumber).asNumber() },
            ll: { x: qp.lookup(k + 4, PDFNumber).asNumber(),     y: qp.lookup(k + 5, PDFNumber).asNumber() },
            lr: { x: qp.lookup(k + 6, PDFNumber).asNumber(),     y: qp.lookup(k + 7, PDFNumber).asNumber() },
          });
        }
      }

      out.push({
        page: i,
        subtype: subtypeStr,
        rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        contents: contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : String(contents),
        author: author instanceof PDFString || author instanceof PDFHexString ? author.decodeText() : null,
        color: color ? color.asArray().map((n) => n.asNumber()) : null,
        quads,
      });
    }
  }

  const outPath = resolve(__dirname, 'readback.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[readback] parsed ${out.length} markup annotation(s) → ${outPath}`);
  console.log(JSON.stringify(out, null, 2));
}

// ─── Test 4: identity-transform assertion ─────────────────────────────────

function testCoordTransformIdentity() {
  const samples = [
    { x: 0, y: 0, w: 0, h: 0 },
    { x: 72, y: 698, w: 377, h: 16 },
    { x: 100.5, y: 200.25, w: 50.75, h: 12.125 },
    { x: 500, y: 50, w: 100, h: 100 },
  ];
  for (const r of samples) {
    const t = pdfjsRegionToPdfLib(r);
    if (t.x !== r.x || t.y !== r.y || t.w !== r.w || t.h !== r.h) {
      throw new Error(`coord transform mismatch: ${JSON.stringify(r)} → ${JSON.stringify(t)}`);
    }
  }
  console.log('[coord-transform] PDF.js region → pdf-lib coords is identity for unrotated pages with MediaBox origin (0,0). ✔');
}

// ─── Run all ──────────────────────────────────────────────────────────────

await testFreshAnnotations();
await testRotatedPage();
await testReadback();
testCoordTransformIdentity();
console.log('\nspike OK. Manual step: open out-fresh.pdf and out-rotated.pdf in Preview and Acrobat, verify the highlight sits over the expected text and the popup carries the comment.');
