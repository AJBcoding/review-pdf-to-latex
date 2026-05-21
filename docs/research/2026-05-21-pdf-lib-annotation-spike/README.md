# Spike — pdf-lib §10.4 annotations + PDF.js→pdf-lib coord transform

**Bead:** rev-cvr. **Blocks:** rev-1md.1 (M7 bundle writer).
**Date:** 2026-05-21. **Status:** done.

## Question

The §10.4 bundle writer renders comments as PDF-native annotations
(Highlight, Strikethrough, Sticky-note) on a copy of the source PDF. Two
load-bearing risks the M7 design review (Pass 1) flagged:

1. **pdf-lib has no high-level `addHighlight` / `addStrikeOut` / `addText`
   helper** in 1.17.x. We have to build the annotation dicts ourselves.
   Off-shape dicts produce silently invisible annotations.
2. **The coord transform from PDF.js's `SelectionPayload.region` to pdf-lib
   annotation coords** is a candidate for off-by-zoom or off-by-axis-flip
   bugs.

This spike resolves both.

## Result

- pdf-lib 1.17.1 produces correct Highlight, StrikeOut, and Text
  (sticky-note) annotations using the low-level `context.obj` / `register`
  API. See `desktop/spikes/rev-cvr-pdf-lib/spike.mjs` for working code.
- The PDF.js → pdf-lib **coord transform is the identity**. No translation,
  no scale, no flip. Just pass `SelectionPayload.region` straight into
  `/Rect` and `/QuadPoints`.
- Existing /Highlight annotations can be read back from a PDF by walking
  `page.node.Annots()` — this satisfies the §10.4 degraded-restore path
  when the JSON sidecar is missing.

## Annotation dict shape (pdf-lib 1.17, low-level)

For each annotation type, build a `PDFDict` via `doc.context.obj({...})`,
register it (`doc.context.register(dict)` → `PDFRef`), and push the ref
onto the page's `/Annots` array. Field types matter — strings must be
`PDFString.of(...)`, names `PDFName.of(...)`, numeric arrays
`ctx.obj([...])`. Mixing raw JS values into the dict throws at save.

### Common fields (PDF 1.7 §12.5.2 / §12.5.6)

| Key | Type | Notes |
|---|---|---|
| `/Type` | `Name` | always `/Annot` |
| `/Subtype` | `Name` | `/Highlight`, `/StrikeOut`, `/Text` |
| `/Rect` | `Array[4]` | `[xMin, yMin, xMax, yMax]` in **PDF user space** (origin bottom-left, points). For markup annots = bbox of all quads. For sticky = the ~20×20 pt icon box. |
| `/Contents` | `String` | popup text |
| `/T` | `String` | author. §10.4 says `"AJB"` in v1. |
| `/M` | `String` | mod date, `D:YYYYMMDDHHmmSSOHH'mm'` |
| `/F` | `Number` | flags. `4` = Print. |
| `/C` | `Array[3]` | RGB in 0..1. Per §13.19 strawman: L1 yellow [1,1,0], L2 blue [0,0.5,1], L3 red [1,0,0]. |
| `/CA` | `Number` | opacity, 0..1. Highlight typically 0.4; sticky 1.0. |
| `/P` | `Ref` | back-pointer to the page object (`page.ref`). |

### `/Highlight` and `/StrikeOut` (text markup, PDF §12.5.6.10)

Add one more field:

| Key | Type | Notes |
|---|---|---|
| `/QuadPoints` | `Array[8n]` | 8 numbers per region: `[xUL, yUL, xUR, yUR, xLL, yLL, xLR, yLR]`. |

**QuadPoints ordering — interop hazard.** PDF 1.7 §12.5.6.10 says the
order is "counter-clockwise from lower-left", which would be:

```
LL, LR, UR, UL
```

**But every viewer of consequence (Adobe Acrobat, Apple Preview, the
pypdf-generated test fixtures in this repo) uses the *Acrobat* order:**

```
UL, UR, LL, LR
```

Following the spec literally produces highlights that render correctly in
some viewers and not others. We follow Acrobat order. The spike confirms
this by reading `tests/fixtures/sample-annotated.pdf` (known-good fixture
used by the engine + viewer test suites) and matching its byte-shape.

### `/Text` (sticky-note, PDF §12.5.6.4)

Add:

| Key | Type | Notes |
|---|---|---|
| `/Name` | `Name` | icon: `/Note`, `/Comment`, `/Help`, `/Insert`, `/Key`, `/NewParagraph`, `/Paragraph` |
| `/Open` | `Bool` | whether the popup is open on load. Default `false`. |

`/Rect` is the icon's screen box; convention is ~20×20 pt. The author
note text lives in `/Contents`.

## Coord transform — proof it's identity

PDF.js's `PageViewport.convertToPdfPoint(screenX, screenY)`
(`desktop/renderer/pdf-viewer.ts:462-476`) applies the inverse of the
page's viewport transform. That transform includes:

1. The page's `/Rotate` rotation
2. A Y-axis flip (PDF: bottom-left, screen: top-left)
3. The current zoom scale

`convertToPdfPoint` reverses all three. The result is in the page's
**natural (pre-rotation) user space**, in PDF points, at native page
size — independent of zoom.

pdf-lib's `/Rect` and `/QuadPoints` consume coordinates in exactly the
same space: PDF user space, points, pre-rotation (viewers apply `/Rotate`
when displaying; annotation coords stay in the unrotated frame).

So the call sequence:

```
viewport.convertToPdfPoint(stagePx, stagePy)   // PDF.js side
       ↓
SelectionPayload.region = {x, y, w, h}         // crossed renderer→main
       ↓
annotDict["/Rect"] / "/QuadPoints"             // pdf-lib side
```

is identity. The spike's `pdfjsRegionToPdfLib(region)` wrapper is a no-op
documentation hook — keep it as the single point of truth in the bundle
writer so future rotation-or-MediaBox-offset surprises have a place to
land.

### Edge cases verified

- **Non-100% zoom** — `convertToPdfPoint` de-zooms; the region is already
  zoom-independent by the time it crosses into shared state.
- **Page rotation (`/Rotate=90`)** — spike writes a /Highlight on a
  rotated copy of the fixture (`out-rotated.pdf`). Highlight lands on the
  same physical text as on the unrotated copy (`out-fresh.pdf`), because
  pdf-lib stores in the page's natural frame and Preview applies
  `/Rotate` on display.
- **MediaBox origin ≠ (0,0)** — not exercised by the fixture, but
  `convertToPdfPoint` returns coordinates in user space, which is what
  `/Rect` and `/QuadPoints` expect; no offset compensation needed.

## Degraded restore — reading annotations back

`spike.mjs:testReadback` walks `page.node.Annots()` and parses every
markup annot it finds. Output (`readback.json`) carries enough to repop
a comment list: page, subtype, rect, contents, author, color, quads. The
§10.4 §8 schema fields it CAN'T recover are spelled out in the spec:
engagement level (L1/L2/L3) and redraft text. The user re-classifies on
load; redraft is gone unless the JSON sidecar is present.

## How to run

```
cd desktop
npm install                                         # adds pdf-lib
node spikes/rev-cvr-pdf-lib/spike.mjs
open spikes/rev-cvr-pdf-lib/out-fresh.pdf           # Preview
open -a "Adobe Acrobat" spikes/rev-cvr-pdf-lib/out-fresh.pdf
```

Expected: a yellow highlight on line 1 of the body text, a red
strikethrough on the "Methods" line, and a sticky-note icon in the
upper-right margin. Clicking the highlight opens a popup with the
spike's annotation text.

## Handoff to rev-1md.1 — the bundle writer

The bundle writer should:

1. Take the source PDF bytes + draft state.
2. Load with `PDFDocument.load(srcBytes)`.
3. For each comment in the draft, build the annotation dict per the
   shapes above. Map engagement level → `/C` color via the §13.19
   palette (still TBD; placeholder yellow/blue/red).
4. If the comment has `redraft` text, prefix popup with `"[redraft] "`
   per §10.4.
5. Pass `SelectionPayload.region` directly to `/Rect` and `/QuadPoints`
   via `pdfjsRegionToPdfLib` (identity — but keep the wrapper for
   future-proofing).
6. Save and write to the dated bundle path.

The helper functions in `spike.mjs` are factored to lift cleanly into
`desktop/main/bundle.ts` (or `desktop/shared/` if the renderer ever needs
them for an in-app preview). Recommended landing spot is `main/`,
because PDF mutation should run in Node, not the renderer.

## Files

| Path | Role |
|---|---|
| `desktop/spikes/rev-cvr-pdf-lib/spike.mjs` | Working script — Highlight, StrikeOut, sticky, readback, transform check |
| `desktop/spikes/rev-cvr-pdf-lib/out-fresh.pdf` | Annotated copy (unrotated) — open in Preview/Acrobat to verify |
| `desktop/spikes/rev-cvr-pdf-lib/out-rotated.pdf` | Annotated copy with `/Rotate=90` — verifies the rotation edge case |
| `desktop/spikes/rev-cvr-pdf-lib/readback.json` | Parsed annotations from the source fixture — proof of degraded-restore path |
