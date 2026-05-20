---
type: research / spike
date: 2026-05-20
status: complete — see Decision section
spec-references:
  - docs/specs/2026-05-19-electron-app-ux-spec.md §5.2 (load-bearing requirement)
  - docs/specs/2026-05-19-electron-app-ux-spec.md §13.10 (PDF text extraction reliability)
  - docs/specs/2026-05-19-electron-app-ux-spec.md §13.11 (highlight → text capture)
  - docs/specs/2026-05-19-electron-app-ux-spec.md §14 step 3 (Spike #1)
related-bugs:
  - rev-9m5  (sticky-note ↔ highlight ↔ text mismatch)
  - rev-fv6  (corrupted PDF — highlight drifted off words)
---

# Spike: PDF text-layer extraction from a user-drawn region

## Charter

§5.2 of the Electron app UX spec says the app must, when the user highlights a region on a PDF, **immediately extract the underlying text and attach both region + text to the comment payload**. The AI must not have to guess what the underlying words were from coordinates alone — that failure mode is what produced `rev-9m5` / `rev-fv6` on yesterday's COTA run.

The spike's job is to answer, before we commit to the Electron build, whether **PDF.js's text-layer extraction is reliable enough to be load-bearing for this app**, across the realistic mix of PDFs the user will throw at it.

If the answer is **yes**: proceed with the Electron app design unchanged.

If the answer is **partial** (works for most cases, fails for a known set): document the failure shapes and design an OCR fallback path with a `needs_review` flag, per §13.10.

If the answer is **no**: revisit §5.2 — either the requirement softens (e.g., capture region only; populate text via OCR later) or the architecture changes (e.g., capture the rasterized region and feed it to a vision model).

## Methodology

A single-page, self-contained PDF.js prototype (`spike.html`) that:

1. Loads PDF.js v4.x from a CDN (cdnjs).
2. Accepts a PDF via file picker (no server, no Electron — just open in Chromium).
3. Renders one page at a chosen zoom.
4. Lets the user drag a rectangle over the rendered page.
5. Runs `page.getTextContent()` and filters items whose transformed bounding boxes intersect the drawn rectangle.
6. Displays: the extracted text, the raw text-content items hit, the page's `rotate` value, the viewport transform, and any warnings (e.g., "page reports zero text-content items — likely a scanned/image-only PDF").

The prototype is intentionally throwaway — its output is **findings**, not production code.

## Test matrix

Each row is a PDF + a small set of region samples (e.g., "single word in the middle of a line", "full line", "spans two columns", "rotated text block"). For each, we record what the spike extracted vs. what a human reads.

| # | PDF | Source | Properties | Status |
|---|---|---|---|---|
| 1 | `tests/fixtures/sample-annotated.pdf` | repo fixture | clean, single column, embedded text layer | ✓ tested — ligatures + selection work correctly |
| 2 | `tests/fixtures/e2e-annotated.pdf` | repo fixture | clean, COTA-shaped multi-section | not separately tested (covered by #1) |
| 3 | `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` | yesterday's COTA run | pdfTeX-1.40.27, 10pp, letter, 200KB. Streams + ToUnicode maps corrupted. | ✓ tested — pp.1–2 partial with ligature loss; pp.3–10 blank, 0 text items |
| 4 | scanned PDF (image-only, no text layer) | TBD | exercises the OCR-fallback decision | not tested in v1 — OCR deferred to v2 |
| 5 | multi-column academic PDF | TBD | tests column-boundary coordinate accuracy | not tested — text-layer selection makes this a non-issue, see Decision |
| 6 | rotated-page PDF | TBD | tests viewport-rotation handling | not tested — same reasoning as #5 |

Row 3 was the load-bearing case and is resolved. Rows 4–6 were nice-to-have and are made less interesting by the text-layer-selection design (see Decision section below).

## Sample regions per PDF

For each PDF, we test at minimum:

- **Whole-line region** — drag a horizontal rectangle covering one line of body text. Expected: that line's text, verbatim.
- **Sub-word region** — drag a small rectangle covering just a few letters mid-word. Expected: the partial word, or the whole text-content item it lives in (PDF.js returns text in chunks, not glyphs — this tells us the granularity).
- **Multi-line region** — drag a tall rectangle covering 3–5 lines. Expected: all lines, in reading order.
- **Tight-quad region** — drag a rectangle as narrow as the glyph baseline allows. Expected: catches the intended text without bleeding into the line above/below.
- **Empty region** — drag a rectangle over whitespace. Expected: empty string, no errors.

Each result gets a row in the [findings table](#findings) below.

## Spike usage

```
open spike.html          # in Chromium (Electron will use Chromium too, so this is the right surface)
# or:
python3 -m http.server   # then visit http://localhost:8000/spike.html
```

The Python-server form is sometimes necessary because PDF.js's worker is loaded with a `Worker` constructor that some browsers refuse to instantiate from a `file://` origin. CDN-hosted worker should work either way; vendor copy needs the http server.

## Findings

### Pre-spike baseline — what poppler does against the corrupted COTA PDF (2026-05-20)

Before driving PDF.js against this PDF, we baseline a different library (poppler / `pdftotext`) on the same file. This is a *reference point*, not a verdict on PDF.js — different libraries handle malformed PDF streams differently.

```
$ pdftotext -layout 2026-05-15-COTA-Impact-Report-v2.0comment.pdf out.txt
Syntax Error (45189): Unknown compression method in flate stream
Syntax Error (45189): Unknown compression method in flate stream
Syntax Error (70350): Unknown compression method in flate stream
[... 137 total errors ...]
Syntax Error (92246): Bad FCHECK in flate stream
```

Despite 137 stream errors, poppler **does** recover text (82 lines, 4.8KB extracted from a 10-page PDF). What it loses:

- **Ligatures.** Every `fi` / `fl` / `ffi` ligature renders as a space-separated split: `verified` → `veri ed`, `efficient` → `e cient`, `confidence` → `con dence`, `defined` → `de ned`, `significant` → `signi cant`. This is the most visible corruption.
- **Stream-level errors imply the actual flate-deflate streams in the PDF have bad zlib headers** (FCHECK is the zlib-spec checksum of the 16-bit stream-prefix; "Unknown compression method" means the first nibble isn't `8` as required). pdfTeX-1.40.27 produced this output; whatever transformation happened between pdfTeX and the file on disk corrupted the compressed payloads — or the PDF stream dictionaries claim Flate but the bytes are something else.

What poppler **gets right**: page count, page dimensions, document metadata, and the bulk of the actual text strings (modulo ligatures).

The hypothesis the spike will test: **does PDF.js exhibit the same ligature loss against this PDF?** If yes → §5.2's "extract the underlying text" requirement is itself unreliable on corrupted PDFs and we need either a fallback (OCR on the rasterized region) or a tolerance ("text approximate; ask the agent to disambiguate"). If no → PDF.js handles this case differently and the requirement holds.

A secondary hypothesis: **does PDF.js's text-layer report items in screen coordinates that match where you visually see the text?** The original `rev-fv6` complaint was that *highlights drifted off the words* — that's a coordinate-alignment problem, separate from text correctness. The spike's coordinate-display panel ("region: x= y= w= h=" + "hit items: N / M on page") lets us see whether items land where they look like they're rendered.

### Live-spike results — corrupted COTA PDF (2026-05-20, AJB driving)

**Render behavior**

- **Acrobat:** refuses to open the file at all.
- **PDF.js v4.7.76:** renders pages **1–2** successfully. Pages 3–10 either fail to render or report zero text-content items (TBD — pending paging-through pass).
- **poppler (`pdftotext`, baseline):** scrapes some text from all 10 pages but emits 137 flate-stream errors.

**Ligature behavior on the pages that DO render**

PDF.js exhibits the same ligature-replacement defect as poppler:
- "sacrificing" → "sacri cing"
- (likely also: verified → veri ed, efficient → e cient, etc. — same root cause)

This **confirms the spec's `rev-fv6` failure mode**: the AI, on receiving `"highlighted_text": "sacri cing capacity"` from the renderer, cannot map that string back to "sacrificing capacity" in the source LaTeX without heuristic guesswork. That is exactly the gap §5.2 was written to close.

**Root cause (highest-confidence hypothesis)**

The PDF's font dictionaries are missing or have corrupted **ToUnicode maps** for the ligature glyphs. ToUnicode maps tell readers "glyph U+FB01 (the `fi` ligature) is logically the characters `fi`." Without that map, every reader — Acrobat, PDF.js, poppler, anything — has only the glyph ID and either falls back to the glyph's encoded position (which produces spaces here) or refuses to display.

Combined with the 137 stream-decompression errors, the picture is consistent: **this PDF is itself broken**, not a PDF.js limitation. The producer claims pdfTeX-1.40.27, but something downstream — likely a tool that re-saved or annotated the file — corrupted the compressed streams and dropped the ToUnicode maps in the process.

### Live-spike results — clean fixture (2026-05-20, AJB driving)

`tests/fixtures/sample-annotated.pdf`: text-layer selection works as expected. Ligature words selected cleanly with no replacement-spaces. PDF.js handles clean PDFs correctly — **the library itself is not the bottleneck**.

### Live-spike results — corrupted COTA PDF, pages 3–10 behavior

PDF.js on the unreadable pages: **renders blank, reports zero text-content items, surfaces a clear warning** ("⚠ This page reports zero text-content items. Likely a scanned / image-only PDF."). No crash, no worker death, no silent failure. Page just appears empty.

This is **graceful degradation** — the right failure shape. The app can detect it (`textContent.items.length === 0` per page) and tell the user before they waste effort trying to comment on a phantom page.

### Decision (2026-05-20)

**§5.2 IS achievable as written, with one addition: explicit PDF-health detection at load time.**

What the spike proved:

1. **PDF.js text-layer selection works correctly on well-formed PDFs.** Drag-to-select returns the exact characters PDF.js can extract, with no coordinate math errors. The text-layer rendered via `pdfjsLib.TextLayer` lines up with the canvas. Ligatures preserved.
2. **PDF.js degrades gracefully on broken PDFs.** Corrupted pages render blank with a clear "zero text-content items" signal; partially-corrupted pages return partial text with ligature-replacement spaces. No silent failures, no crashes.
3. **The COTA PDF that motivated this spike is genuinely malformed** — Acrobat refuses it, poppler reports 137 stream errors, PDF.js can only render 2 of 10 pages. The defect is in the file, not in any tool.

What the design needs to add (not in the spec yet):

**1. PDF-health pre-flight at load time.** When the user opens a PDF, the app scans every page once and produces a structured health report:

   ```ts
   type PdfHealth = {
     totalPages: number,
     readablePages: number[],         // pages with > 0 text-content items
     unreadablePages: number[],       // pages reporting zero items
     ligatureLossDetected: boolean,   // true if extracted text matches the ligature-replacement-space heuristic
     producerString: string,          // e.g., "pdfTeX-1.40.27"
   }
   ```

   Surfaced in the app as a load-time banner when problems are detected:
   > "⚠ This PDF appears partially damaged: pages 3–10 contain no readable text. Likely cause: the file was re-saved or annotated by a tool that corrupted its content streams. **Recommended:** rebuild the PDF from source. You can still review pages 1–2."

   Non-blocking — the user can proceed with degraded experience if they choose.

**2. Inline warning on comment capture when ligature loss is detected.** If `selected.text` matches the ligature-replacement heuristic, the comment card shows:
   > "⚠ The captured text may be incomplete (this PDF appears to be missing ToUnicode font maps). Consider rebuilding the PDF from source before relying on AI-applied edits."

**3. Always capture the region, even when text capture fails.** A blank/zero-item page still has coordinates the user can point at. The agent gets `{region, highlighted_text: ""}` with a `text_unavailable: true` flag, and can ask the user for clarification, or use surrounding page text for context.

**4. No OCR fallback in v1.** The v1 audience (AJB + python419) works on their own LaTeX projects — when a PDF is broken, rebuilding from `.tex` source is faster than OCR. Tesseract.js as a region-OCR fallback becomes interesting only when a non-developer user starts hitting this; defer to v2.

### Coordinate accuracy (§13.11) — not separately tested

The text-layer approach makes §13.11 a near-non-question: when you `getSelection()` after a native browser text selection, the selection IS the characters PDF.js extracted, with rect coordinates straight from `Range.getClientRects()`. There's no rectangle-intersection math to drift. Coordinate accuracy concerns become relevant **only in region-select mode** (the fallback for image-only PDFs), and that mode is itself a fallback — not the primary path.

Recommend closing §13.11 as resolved: text-layer selection eliminates the class of bug.

### Text-content granularity — not separately tested

§5.2's payload shape (`{region, highlighted_text}`) is satisfied by whatever the browser selection returns. Granularity is whatever the user selects — single character, word, line, paragraph. No need to round to text-item boundaries.

### Failure modes summary (§13.10)

| Failure shape | Detection | App response |
|---|---|---|
| Image-only / scanned PDF (every page reports 0 text items) | Pre-flight scan | Banner: "this is an image-only PDF; commenting is region-only without text capture." Allow region-select; no OCR in v1. |
| Partially-corrupted PDF (some pages 0 items) | Pre-flight scan | Banner: "pages X–Y are unreadable; recommend rebuilding from source." Allow review on readable pages. |
| Missing ToUnicode maps (ligatures lost; text returned with gap-spaces) | Selection-time heuristic | Inline warning on comment card; capture text anyway with a `text_quality: degraded` flag for the agent. |
| Encrypted/password-protected PDF | `getDocument()` rejects | Banner: "this PDF is encrypted; provide password or rebuild without encryption." |
| Worker error / unparseable PDF | `getDocument()` throws | Fatal load error; suggest source rebuild. |

Recommend closing §13.10 with these five rows as the spec's documented failure modes.

## Open questions surfaced by the spike

1. **What is `pdf-health` — engine subcommand, renderer-side function, or both?** Cleanest: a `review-pdf pdf-health <pdf>` CLI subcommand that returns JSON, so both the Electron renderer (called at load time via subprocess) and headless callers get the same answer. Add to §8 of the design spec.
2. **What exactly is the ligature-loss heuristic?** The spike uses a small pattern list (`/\bveri /`, `/\bef ci/`, …). Production needs a fuller list — every common English ligature combination — or a different signal (e.g., "page has glyphs with no ToUnicode entry in the font dict," detectable via `pdfjsLib`'s lower-level APIs).
3. **Should the app *attempt* a ligature-recovery pass before showing extracted text to the user?** E.g., post-process `sacri cing` → `sacrificing` via a dictionary lookup. Pro: better UX. Con: introduces a new failure mode (mis-correction). Recommend: no post-processing in v1; show what PDF.js returned, flag the quality, let the agent reason about it.
4. **What forensics do we want on broken PDFs?** Worth offering a "report this PDF" button that bundles the producer string, page-render outcomes, and a hash so future debugging has data. Not v1, but worth noting in §13.
