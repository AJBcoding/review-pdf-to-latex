// Spike rev-n8 / S-2: per-line /QuadPoints write-back surviving an Acrobat
// open/annotate/save cycle without bbox-collapse — including on a
// restored/degraded PDF (domain trap #8: broken-quad re-saved PDFs).
//
// Roadmap N8. Spec: docs/specs/2026-06-12-unified-comment-model-and-roundtrip.md §8 (S-2).
//
// ── What's being proven ──────────────────────────────────────────────────
// The shipped writer (desktop/main/bundle.ts:73-105) emits a SINGLE /QuadPoints
// quad (the selection bbox), even for a multi-line highlight. A 2-line wrapped
// selection therefore over-covers: the bbox spans the full width of the widest
// line plus the inter-line gap, shading whitespace the reviewer never selected.
//
// The capture side already has what we need to do better: SelectionPayload
// carries per-span `screenRects` (pdf-viewer.ts:60), merged per visual line by
// `mergeRectsByLine` (pdf-viewer.ts:486). One PDF-space quad per merged line =
// faithful multi-line highlight. The prior spike's buildHighlight already
// accepted a `regions[]` array (rev-cvr-pdf-lib/spike.mjs:97) and emitted one
// quad per region — so the WRITE shape is known. What was UNPROVEN, and what
// this spike settles, is the round-trip question:
//
//   When a viewer (Acrobat/Preview) opens a multi-quad highlight, lets the user
//   annotate, and SAVES, do the per-line quads survive — or does the save
//   collapse /QuadPoints back to a single bbox quad?
//
// And the harder domain-trap-#8 variant:
//
//   Does the answer still hold when the BASE pdf is a restored/degraded file
//   (re-saved through a lossy pipeline, object streams regenerated, xref
//   rebuilt) rather than our clean fixture?
//
// ── Why qpdf + ghostscript stand in for Acrobat ─────────────────────────
// Acrobat is not available headless. We use two re-save engines as proxies for
// the "...save" half of the cycle, chosen to bracket the real risk:
//
//   * qpdf --object-streams=generate  → a *structure-preserving* re-save that
//     rebuilds the xref as a cross-reference STREAM and packs objects into
//     object streams — exactly the PDF-1.5+ structure Acrobat writes. This is
//     the faithful "Acrobat re-save" proxy: it rewrites the file's plumbing
//     while a conformant writer must leave annotation /QuadPoints semantically
//     intact.
//   * ghostscript -sDEVICE=pdfwrite   → a *reinterpreting* re-save (the file is
//     parsed to a graphics model and re-emitted). This is the harsh
//     restored/degraded proxy and the most likely place a naive pipeline would
//     drop or rewrite annotations. It models domain trap #8's "annotations
//     re-injected from a corrupted source" failure mode.
//
// Ground truth is read back two independent ways: pdf-lib's object model (this
// script) and `qpdf --qdf` literal QuadPoints (see check.sh / the research
// note), so the verdict does not depend on a single parser.
//
// Run:  node spikes/rev-n8-quads/spike-n8.mjs   (from desktop/)
// Outputs land in this dir; a JSON verdict prints to stdout.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFArray,
  PDFDict,
  PDFNumber,
} from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../../tests/fixtures/sample-annotated.pdf');
const PAGE_H = 792; // letter; fixture MediaBox [0 0 612 792]

// ── Per-line regions for the real 2-line wrapped Introduction sentence ────
// Derived from `pdftotext -bbox` (top-left origin) → PDF user space
// (bottom-left origin): y_pdf = PAGE_H - yMax_topleft, h = yMax - yMin.
//
//   line A "The College of the Arts experienced a substantial increase"
//          xMin 72  xMax 382.812  yMin 81.384  yMax 92.484
//   line B "in enrollment between 2019 and 2024."
//          xMin 72  xMax 276.120  yMin 99.384  yMax 110.484
//
// Note the widths differ by ~107 pt — this is precisely the fidelity a single
// bbox quad destroys (it would stretch line B to line A's width).
const LINE_A = { x: 72, y: PAGE_H - 92.484, w: 382.812 - 72, h: 92.484 - 81.384 };
const LINE_B = { x: 72, y: PAGE_H - 110.484, w: 276.120 - 72, h: 110.484 - 99.384 };
const REGIONS = [LINE_A, LINE_B];

// ── Annotation builders (per-line quads) ─────────────────────────────────

function pdfDateUtc(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}+00'00'`
  );
}

/** Build a /Highlight whose /QuadPoints carries ONE quad per region (per line).
 *  /Rect is the union bbox of all regions. QuadPoints order is Acrobat order
 *  UL, UR, LL, LR — matching bundle.ts:73 and the repo's pypdf fixtures. */
function buildMultilineHighlight(doc, pageRef, { regions, contents, author, colorRGB, annotId, opacity = 0.4 }) {
  const ctx = doc.context;
  const xs = regions.flatMap((r) => [r.x, r.x + r.w]);
  const ys = regions.flatMap((r) => [r.y, r.y + r.h]);
  const rect = ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);

  const quads = [];
  for (const r of regions) {
    quads.push(r.x, r.y + r.h);   // UL
    quads.push(r.x + r.w, r.y + r.h); // UR
    quads.push(r.x, r.y);         // LL
    quads.push(r.x + r.w, r.y);   // LR
  }

  return ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Highlight'),
    Rect: rect,
    Contents: PDFString.of(contents),
    T: PDFString.of(author),
    M: PDFString.of(pdfDateUtc(new Date(0))), // fixed date — spike must be deterministic
    F: PDFNumber.of(4),
    C: ctx.obj(colorRGB),
    CA: PDFNumber.of(opacity),
    NM: PDFString.of(annotId),
    QuadPoints: ctx.obj(quads),
    P: pageRef,
  });
}

function addAnnots(doc, page, annots) {
  const ctx = doc.context;
  const refs = annots.map((a) => ctx.register(a));
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) {
    for (const r of refs) existing.push(r);
  } else {
    page.node.set(PDFName.of('Annots'), ctx.obj(refs));
  }
}

/** Write a fresh multi-line highlight onto a copy of `srcBytes`. Returns saved
 *  bytes. `annotId` lets the readback find OUR annotation, not the fixture's
 *  two pre-existing single-line highlights. */
async function writeMultilineHighlight(srcBytes, annotId) {
  const doc = await PDFDocument.load(srcBytes);
  const page = doc.getPages()[0];
  const hl = buildMultilineHighlight(doc, page.ref, {
    regions: REGIONS,
    contents: 'spike rev-n8: 2-line highlight, per-line QuadPoints',
    author: 'AJB',
    colorRGB: [1, 1, 0],
    annotId,
  });
  addAnnots(doc, page, [hl]);
  return doc.save();
}

// ── Readback (reader #1: pdf-lib) ─────────────────────────────────────────

/** Pull every markup annotation's QuadPoints back out. Returns the record for
 *  the annotation whose /NM === annotId, or null. quadCount = number of 8-tuple
 *  quads = number of lines the highlight covers. */
async function readbackByName(bytes, annotId) {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let j = 0; j < annots.size(); j++) {
      const a = annots.lookup(j, PDFDict);
      if (!a) continue;
      const nm = a.lookup(PDFName.of('NM'));
      const nmStr = nm && nm.decodeText ? nm.decodeText() : null;
      if (nmStr !== annotId) continue;
      const qp = a.lookup(PDFName.of('QuadPoints'), PDFArray);
      const nums = qp ? qp.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)) : [];
      const rectArr = a.lookup(PDFName.of('Rect'), PDFArray);
      const rect = rectArr ? rectArr.asRectangle() : null;
      return {
        found: true,
        quadNumbers: nums.length,
        quadCount: nums.length / 8,
        quads: chunk8(nums),
        rect: rect ? { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) } : null,
      };
    }
  }
  return { found: false, quadNumbers: 0, quadCount: 0, quads: [], rect: null };
}

function chunk8(nums) {
  const out = [];
  for (let k = 0; k + 8 <= nums.length; k += 8) {
    out.push({
      ul: [round(nums[k + 0]), round(nums[k + 1])],
      ur: [round(nums[k + 2]), round(nums[k + 3])],
      ll: [round(nums[k + 4]), round(nums[k + 5])],
      lr: [round(nums[k + 6]), round(nums[k + 7])],
    });
  }
  return out;
}
const round = (n) => Math.round(n * 1000) / 1000;

// ── Re-save proxies (the "...save" half of the Acrobat cycle) ─────────────

function qpdfResave(inPath, outPath) {
  // Structure-preserving Acrobat-like re-save: cross-ref stream + object streams.
  execFileSync('qpdf', ['--object-streams=generate', '--', inPath, outPath], { stdio: 'pipe' });
}

function ghostscriptResave(inPath, outPath) {
  // Reinterpreting "restored/degraded" re-save. -dPrinted=false keeps screen
  // (non-print) annotation appearances; without it gs can drop annots whose /F
  // lacks the Print bit. We WANT annotations preserved if the engine is honest.
  execFileSync('gs', [
    '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dPrinted=false',
    `-sOutputFile=${outPath}`,
    inPath,
  ], { stdio: 'pipe' });
}

// ── qpdf --qdf literal QuadPoints (reader #2: parser-independent) ──────────

function qdfQuadPointsBlocks(path) {
  // Returns each /QuadPoints array as a flat number list, straight from the
  // decompressed PDF source — no PDF object model in the loop.
  const qdf = execFileSync('qpdf', ['--qdf', '--', path, '-'], { stdio: 'pipe' }).toString('latin1');
  const blocks = [];
  const re = /\/QuadPoints\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(qdf)) !== null) {
    const nums = m[1].trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
    blocks.push(nums);
  }
  return blocks;
}

// ── Test driver ───────────────────────────────────────────────────────────

async function runCase(label, baseBytes) {
  const annotId = `spike-n8-${label}`;
  const writtenPath = resolve(__dirname, `out-${label}.pdf`);
  const written = await writeMultilineHighlight(baseBytes, annotId);
  writeFileSync(writtenPath, written);

  const direct = await readbackByName(written, annotId);

  const qpdfPath = resolve(__dirname, `rt-${label}-qpdf.pdf`);
  qpdfResave(writtenPath, qpdfPath);
  const afterQpdf = await readbackByName(readFileSync(qpdfPath), annotId);

  const gsPath = resolve(__dirname, `rt-${label}-gs.pdf`);
  let afterGs;
  let gsError = null;
  try {
    ghostscriptResave(writtenPath, gsPath);
    afterGs = await readbackByName(readFileSync(gsPath), annotId);
    afterGs.qdfQuadBlocks = qdfQuadPointsBlocks(gsPath).map((b) => b.length / 8);
  } catch (err) {
    gsError = String(err.message || err).split('\n')[0];
    afterGs = { found: false, quadCount: 0, error: gsError };
  }

  return {
    label,
    expectedQuadCount: REGIONS.length,
    written: { quadCount: direct.quadCount, rect: direct.rect, quads: direct.quads },
    afterQpdfResave: { found: afterQpdf.found, quadCount: afterQpdf.quadCount, rect: afterQpdf.rect },
    afterGhostscriptResave: { found: afterGs.found, quadCount: afterGs.quadCount, error: gsError },
    // Parser-independent confirmation on the written + qpdf paths:
    qdf: {
      written: qdfQuadPointsBlocks(writtenPath).map((b) => b.length / 8),
      afterQpdf: qdfQuadPointsBlocks(qpdfPath).map((b) => b.length / 8),
    },
    verdict: {
      // "survives without bbox-collapse" = our annotation still has >1 quad
      // (one per line) after the re-save, i.e. quadCount stayed == expected.
      qpdfSurvives: afterQpdf.found && afterQpdf.quadCount === REGIONS.length,
      ghostscriptSurvives: afterGs.found && afterGs.quadCount === REGIONS.length,
    },
  };
}

async function main() {
  const cleanBytes = readFileSync(FIXTURE);

  // Domain-trap-#8 base: a restored/degraded copy of the fixture, produced by
  // round-tripping the CLEAN pdf through ghostscript BEFORE we write our quads.
  // This rebuilds the xref, regenerates object structure, and re-emits the
  // page content — the "re-saved from a corrupted/foreign source" condition
  // under which the engine's pdfplumber bbox-crop fallback exists (extract.py
  // _bbox_recover_text). If per-line quads write+survive on THIS base, the
  // write path is robust to trap #8.
  const degradedPath = resolve(__dirname, 'base-degraded.pdf');
  ghostscriptResave(FIXTURE, degradedPath);
  const degradedBytes = readFileSync(degradedPath);

  const results = [];
  results.push(await runCase('clean', cleanBytes));
  results.push(await runCase('degraded', degradedBytes));

  const report = {
    spike: 'rev-n8',
    title: 'per-line /QuadPoints write-back surviving Acrobat-cycle re-save',
    fixture: 'tests/fixtures/sample-annotated.pdf',
    regions: REGIONS.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })),
    proxies: {
      'qpdf --object-streams=generate': 'structure-preserving Acrobat-like re-save',
      'gs -sDEVICE=pdfwrite -dPrinted=false': 'reinterpreting restored/degraded re-save (domain trap #8 proxy)',
    },
    cases: results,
    summary: {
      allQpdfSurvive: results.every((r) => r.verdict.qpdfSurvives),
      allGhostscriptSurvive: results.every((r) => r.verdict.ghostscriptSurvives),
    },
  };

  writeFileSync(resolve(__dirname, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
