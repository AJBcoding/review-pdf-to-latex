# Spike — per-line /QuadPoints write-back surviving an Acrobat cycle

**Bead:** rev-n8 (roadmap N8 / spec S-2). **Blocks:** rev-l4 (L4 PDF round-trip WRITE half).
**Date:** 2026-06-13. **Status:** done — **PASS** (writer upgrade is GO).
**Artifact:** `desktop/spikes/rev-n8-quads/` — committed: `spike-n8.mjs`,
`report.json` (deterministic verdict), `render-rt-clean-gs-1.png` (visual
snapshot). The round-trip PDFs are git-ignored (non-deterministic bytes);
regenerate them with `node spike-n8.mjs`.

## Question

The shipped bundle writer (`desktop/main/bundle.ts:73-105`) emits a **single**
`/QuadPoints` quad — the selection bounding box — even for a multi-line
highlight. A two-line wrapped selection therefore *over-covers*: the bbox spans
the full width of the widest line plus the inter-line gap, shading whitespace
the reviewer never selected. The writer's own comment calls this an
"[a]cceptable v1 fidelity" limit and defers the upgrade (bundle.ts:73-76).

The capture side already carries what a faithful writer needs: a
`SelectionPayload` has per-span `screenRects` (`renderer/pdf-viewer.ts:60`),
merged per visual line by `mergeRectsByLine` (`pdf-viewer.ts:486`). One PDF-space
quad per merged line = a highlight that traces the text. The prior spike's
`buildHighlight` already accepted a `regions[]` array and emitted one quad per
region (`spikes/rev-cvr-pdf-lib/spike.mjs:97`), so the *write shape* was known.

What was **unproven**, and what this spike settles, is the round-trip:

> When a viewer (Acrobat/Preview) opens a multi-quad highlight, the user
> annotates, and the viewer **saves**, do the per-line quads survive — or does
> the save **collapse** `/QuadPoints` back to a single bbox quad?

…and the domain-trap-#8 variant:

> Does the answer still hold when the **base PDF is restored/degraded** (re-saved
> through a lossy pipeline, xref/object structure regenerated) rather than a
> clean fixture? Trap #8 is the "annotations re-injected from a corrupted
> source, quads no longer line up" case the engine guards with its pdfplumber
> bbox-crop fallback (`src/review_pdf_to_latex/extract.py:112-156`).

## Result — PASS on every axis tested

Per-line quads **survive** every re-save engine, on both a clean and a
restored/degraded base. No bbox-collapse observed anywhere.

| Base PDF | Re-save engine | Our highlight found? | Quad count (expected 2) |
|---|---|---|---|
| clean fixture | none (as written) | yes | 2 |
| clean fixture | `qpdf --object-streams=generate` | yes | 2 |
| clean fixture | `gs -sDEVICE=pdfwrite` | yes | 2 |
| **gs-degraded** fixture | none (as written) | yes | 2 |
| **gs-degraded** fixture | `qpdf --object-streams=generate` | yes | 2 |
| **gs-degraded** fixture | `gs -sDEVICE=pdfwrite` | yes | 2 |

Read back two independent ways — pdf-lib's object model **and** `qpdf --qdf`
literal source — agreeing in every cell. Full machine output: `report.json`.

### Why these stand in for Acrobat

Acrobat is not available headless. Two re-save engines bracket the real risk:

- **`qpdf --object-streams=generate`** — a *structure-preserving* re-save that
  rebuilds the xref as a cross-reference **stream** and packs objects into
  object streams: exactly the PDF-1.5+ plumbing Acrobat writes. The faithful
  "Acrobat re-save" proxy.
- **`gs -sDEVICE=pdfwrite -dPrinted=false`** — a *reinterpreting* re-save (the
  file is parsed to a graphics model and re-emitted). The harsh
  restored/degraded proxy and the most likely place a naive pipeline would drop
  or rewrite annotations — it models trap #8 directly. `-dPrinted=false` keeps
  screen (non-print) annotation appearances so we test preservation, not the
  print-flag escape hatch.

Ghostscript is the worst case and it **still** preserved our annotation as a
`/Subtype /Highlight` with the complete 16-number (2-quad) `/QuadPoints` array,
**including the second line's narrower width** (382.81 pt line 1 vs 276.12 pt
line 2). A bbox-collapse would have rewritten both lines to the same width.

### Visual confirmation

`render-rt-clean-gs-1.png` (the gs-reinterpreted output, 150 dpi) shows line 2
"in enrollment between 2019 and 2024." shaded **only to the end of "2024."** —
not stretched to line 1's right edge. That right-edge gap is the per-line
fidelity a single bbox quad destroys, and it survived the harshest re-save.

## The transform L4 needs: `screenRects` → per-line PDF quads

The capture side hands the host CSS-pixel `screenRects` (one per text span).
The writer wants one PDF-space quad per *visual line*. Two steps, both already
present in the codebase — they just need to be wired into the writer path:

1. **Merge spans to lines.** Reuse `mergeRectsByLine` (`pdf-viewer.ts:486`) so
   each visual line becomes one rect. (Today it is used only for the on-screen
   overlay, `drawHighlight`, `pdf-viewer.ts:447`.)
2. **Convert each merged line rect to a PDF-space region**, the same way the
   current bbox is converted — `screenBboxToPdf` (`pdf-viewer.ts:465`) applied
   **per line** instead of once over the union. The transform is the established
   identity for unrotated MediaBox-origin pages (rev-cvr spike), with
   `viewport.convertToPdfPoint` absorbing zoom and the y-axis flip.

That means extending `SelectionPayload` to carry the per-line PDF regions (a
`regions: {x,y,w,h}[]` alongside the existing single `region`), then having
`buildHighlight` emit one quad per region — the loop this spike uses:

```js
// Acrobat order per quad: UL, UR, LL, LR  (matches bundle.ts:73 precedent)
const quads = [];
for (const r of regions) {
  quads.push(r.x,       r.y + r.h);   // UL
  quads.push(r.x + r.w, r.y + r.h);   // UR
  quads.push(r.x,       r.y);         // LL
  quads.push(r.x + r.w, r.y);         // LR
}
// /Rect stays the union bbox of all regions.
```

`/Rect` remains the union bbox (PDF 1.7 §12.5.6.10 requires `/Rect` to bound all
quads); only `/QuadPoints` gains the extra lines. The single-line case is
unchanged (one region → one quad → byte-identical to today's output), so the
upgrade is backward-compatible and the model's `quads[]` (spec §3) is simply the
read-back of what we now write.

## Scope notes / what this spike did NOT do

- **No production code changed.** This is a spike; the writer upgrade lands in
  L4 (`rev-l4`, the PDF round-trip WRITE half), which owns `bundle.ts` →
  `pdf-comments.ts`. The transform above is the drop-in.
- **Literal Acrobat GUI cycle not run** (unavailable headless). The two re-save
  engines bracket it and the harsher one passed; residual confirmation is a
  5-minute manual check (below). Engineering verdict does not wait on it.
- **Rotated / non-zero-MediaBox pages** inherit the rev-cvr spike's identity-
  transform analysis; per-line conversion uses the same `convertToPdfPoint`, so
  no new geometry risk is introduced by going from one region to many.

## Manual confirmation step (optional, ~5 min)

Run `node spikes/rev-n8-quads/spike-n8.mjs` to (re)generate the PDFs, then open
`out-clean.pdf` in Acrobat, add any annotation, Save, reopen, and confirm the
yellow highlight still traces the two lines with line 2 ending at "2024." Then
re-read the Acrobat-saved file's `/QuadPoints` with
`qpdf --qdf out-clean.pdf - | grep -A17 "NM (spike-n8-clean)"` and confirm a
16-number array remains on the annotation.

## Reproduce

```bash
cd desktop
npm install pdf-lib            # if node_modules absent (spike used a local install)
node spikes/rev-n8-quads/spike-n8.mjs   # prints + writes report.json
# Parser-independent check on the worst-case re-save:
qpdf --qdf spikes/rev-n8-quads/rt-clean-gs.pdf - | grep -A17 "NM (spike-n8-clean)"
```

Requires `qpdf` and `ghostscript` on `PATH` (both already system deps per README
for `pdftoppm`/`pdflatex` adjacency; qpdf + gs are standard on the dev box).

## Verdict

**GO** — upgrade the writer from single-bbox to per-line `/QuadPoints`. The
kill criterion (Acrobat misalignment on the restored-PDF case) did **not** fire:
multi-quad highlights survive structure-preserving *and* reinterpreting re-saves,
on clean and degraded bases, with per-line widths intact. L4 may build the
multi-quad writer; the capture-side `screenRects` + `mergeRectsByLine` +
per-line `screenBboxToPdf` give it everything it needs.
