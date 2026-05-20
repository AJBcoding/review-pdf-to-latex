---
type: handoff
status: milestone #3 mostly wired (tool palette + bottom input + payload echo); blocked on persistent PDF.js text-selection bug
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: build day 2 — tool palette + bottom input + selection-trap regression hunt
predecessors:
  - docs/handoffs/2026-05-20-milestone-2-done-milestone-3-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§4.2 tool palette, §4.3 bottom input, §11 engagement levels, §5.2 highlight-must-capture-underlying-text)
files-touched:
  - desktop/renderer/index.html
  - desktop/renderer/index.ts
  - desktop/renderer/pdf-viewer.ts
  - desktop/renderer/styles.css
not-committed: true  # uncommitted at handoff; see "State of the repo" below
---

# Milestone #3 — tool palette + bottom input + the selection bug we can't shake

## What got done this session (not yet committed)

**Milestone #3 UX surface (spec §4.2, §4.3, §11).** All landed and working:

- **Tool palette** between document viewer and bottom input: 💬 Comment / ✏️ Redraft / 🌊 Surface as small icon-pill buttons. Active tool gets accent-color border. Single-select. ⌘1 / ⌘2 / ⌘3 also activate the corresponding tool.
- **Bottom input** replaces the old `#selectionEcho`. Plain textarea with an anchor-status meta line above it (`p.N · x,y w×h · "snippet"` when a selection is cached, or `No selection — highlight text in the PDF to anchor a comment.` otherwise) and a `✗ Clear` button.
- **Submit semantics (§4.3):** plain `Enter` submits, `Shift+Enter` is a soft return, `Esc` clears the buffer. After submit, the active tool **stays active** and the cached selection **stays cached** so the user can submit Comment + Redraft against the same highlight in one fluid motion. Only the input buffer is cleared.
- **Tool ↔ field mapping (§11.1):**
  - Comment / Surface → buffer becomes `comment`; `redraft = null`
  - Redraft → buffer becomes `redraft`; `comment = ""`. On selection while Redraft is active, the input is auto-populated with `highlighted_text` as the editing starter; switching *into* Redraft with a live selection does the same populate.
- **Right-drawer comment stream** (`#commentStream`): each submit prepends a color-coded card (blue/purple/cyan for L1/L2/L3) showing the level chip, anchor coords, quoted `highlighted_text`, and either the comment body or the redraft text. This is the milestone #3 "echo to right drawer" — milestone #4 swaps it for the real §9.1 cards + `.review-state/drafts/<doc-version>.json` persistence.
- **Payload built per §8:** `id` (UUID), `doc_id` (path), `doc_version: "1.0"` stub, `anchor: {page, region}`, `highlighted_text`, `comment`, `redraft`, `redraft_suggestion: null`, `engagement_level`, `author: "AJB"`, `kind: "comment"`, `status: "open"`, `created_at` (ISO).
- **Standalone (no-anchor) comments** are explicitly out of scope for milestone #3 — submit with text + no cached selection flashes "Select text in the PDF first to anchor this comment." on the anchor meta line for ~2s.

`npm run typecheck` and `npm run build` are clean. Verified manually against `tests/fixtures/sample-annotated.pdf` (Comment / Redraft / Surface submits all produce correct cards in the right drawer; auto-populate-on-Redraft works; Cmd-1/2/3 work; Esc clears).

## The bug we couldn't fix — PDF.js text-selection anchors on a distant text node

### Symptom

On a real PDF with bulleted content (test file: `~/Downloads/2026 Management fellow Job Description.pdf`), clicking in the **right margin** of the bulleted "GENERAL RESPONSIBILITIES" section consistently grabs a large contiguous block of text — typically "Managing Director and General Manager…" + all 7 sub-bullets + "Fellow will have a chance…" — *regardless of where exactly the user clicks*. The selection appears not to relate to the cursor position at all:

- User reported clicking **several lines above** the highlighted area and the selection still captured the same Managing-Director-through-Fellow block. The first bullet "Collaborate with Managing Director…" was **skipped**, which strongly suggests the browser's selection-extension is walking PDF.js's DOM in **stream order, not visual reading order**, and anchoring on a text node that's near the cursor in *stream order* but visually far away.
- The "phantom" selection survives a tiny click; it doesn't require a long drag. Even barely-visible mouse movement is enough for the browser to extend a selection from the phantom anchor across many spans.
- It's reproducible: click in the right margin of the bulleted block on this PDF → same block grabbed every time.

Screenshots in the prior conversation make this explicit — the captured persistent-yellow overlay covers the bullet block exactly, even though the user clicked above it.

### Why it matters

This is the §5.2 load-bearing requirement: highlights must capture *the text under the cursor*, not text the browser inferred from DOM order. The whole point of the §5.2 spec is to address ready-bugs `rev-9m5`/`rev-fv6` where highlights drifted off the words. The current behavior fails that requirement on any PDF with non-sequential text streams — and that's a very large class of PDFs (Word exports, LaTeX with floats, multi-column journal articles, anything with marked content that isn't pure top-to-bottom).

### What was tried (in order, each ruled out)

1. **Capture on `mouseup` instead of debounced `selectionchange`.**
   First the `selectionchange` debounce was firing *mid-drag* whenever the user paused, focusing the textarea and collapsing the selection. Switched capture to `mouseup` + `requestAnimationFrame` for finalization. **Fixed mid-drag collapse.** Did not address the phantom-anchor bug.

2. **Persistent highlight overlay (drawing screen-space rects ourselves).**
   Browser native `::selection` styling vanishes the moment the textarea takes focus. Added a `.pdf-highlight-layer` sibling inside the stage and drew rects from the captured `screenRects`. **Fixed the "highlight disappears on submit-focus" UX.** Unrelated to phantom-anchor.

3. **Merge overlapping rects per line.**
   `Range.getClientRects()` returns one rect per span; adjacent spans on the same line overlap and `mix-blend-mode: multiply` double-tinted the overlap zone. Added a `mergeRectsByLine` step. **Fixed visual stripes.** Unrelated to phantom-anchor.

4. **Reintroduce PDF.js's `endOfContent` selection-trap sentinel.**
   PDF.js v5's bare `TextLayer` (what we use) does not render the `endOfContent` div that `pdf_viewer.css` expects — only the full `TextLayerBuilder` in PDF.js's own viewer does. Added the div + toggled the `.selecting` class on mousedown/mouseup. **Fixed end-of-line "jump to a glyph on the other side of the page" when the cursor crosses gaps.** Did not address phantom-anchor on the *start* of a selection.

5. **Reposition `endOfContent` during `selectionchange`** (port of PDF.js's `TextLayerBuilder.#enableGlobalSelectionListener`).
   On every selection change during drag, walk the selection's current endpoint, insert `endOfContent` right after it in DOM order so the browser's selection-extension always lands on the sentinel for *gaps near the endpoint* — but lets the user extend through legitimate paragraph gaps without hesitation. **Fixed cross-paragraph drag stalls.** Did not address phantom-anchor.

6. **`document.getSelection().removeAllRanges()` on mousedown when target is the textLayer container or `endOfContent`.**
   Theory: the browser is extending a previous selection. Clearing it on mousedown should force a fresh anchor. **Did not help.** The phantom anchor reappears immediately on the next selection.

7. **4 px drag-distance threshold; treat anything below as a click and drop the selection on mouseup.**
   Theory: the bug fires on a near-zero drag and we just shouldn't capture in that case. **Did not help.** The phantom selection sweeps the block on tiny but >4 px movements, well within the user's normal click jitter.

8. **`includeMarkedContent: true` + `disableNormalization: true` on text-content extraction.**
   PDF.js's reference `TextLayerBuilder` passes these options to `streamTextContent(...)`; our code was using `getTextContent()` with no options. Theory: marked-content wrappers give the browser's selection algorithm reading-order boundaries (list groups, paragraph groups) instead of flat spans. Switched to `streamTextContent({includeMarkedContent: true, disableNormalization: true})`. **Did not help on this PDF.** Possibly because the PDF in question doesn't actually contain marked-content tags, or because the bug isn't fundamentally about marked content.

9. **`preventDefault()` on mousedown when target is the textLayer container or `endOfContent`.**
   Most aggressive: if the click isn't on a text span, suppress the browser's caret placement entirely. **Stopped phantom anchors.** Broke the legitimate "click between two lines of body text and drag" case — the user couldn't start a selection in any vertical gap.

10. **Per-line body rects: compute body extent after each render, expand each line vertically by half its height, only `preventDefault` outside those rects.**
    Designed to keep margin-clicks suppressed *and* allow clicks in vertical line-gaps. Implemented via the same `mergeRectsByLine` we already use for the overlay. **Per the user's most recent report: still misbehaves.** Either the body-rect math is off (the rects don't actually cover where the user is clicking) or the `targetIsLayer` guard isn't catching every case (maybe the click is landing on a span that PDF.js positioned in the wrong place).

### Working theory at handoff

The most consistent thread across the data:

- The PDF in question has bulleted content where PDF.js's processed text stream produces a DOM order that **does not** match visual reading order. (Plausible for Word-exported PDFs with marked-content that PDF.js v5's bare `TextLayer` may be ignoring or flattening despite `includeMarkedContent: true`.)
- The browser's selection-extension walks the DOM. With wrong DOM order, the "nearest text node to the cursor" can be visually far from the cursor.
- Adding the `endOfContent` sentinel + repositioning it on `selectionchange` solves the **end-of-line jump** because the sentinel is always near the current endpoint *after* the first valid selection. But on the **first click** in a gap area, there's no prior selection to anchor the sentinel near the cursor, so the sentinel is still parked at the textLayer root — and the browser's caret-placement runs first, picks a distant text node, and that becomes the anchor.
- Our `preventDefault`+body-rect approach is the right *shape* of fix but the body-rect math may not be picking up sub-bullet line rects correctly (e.g., if PDF.js wraps sub-bullets in markedContent divs and our `node.matches('span')` traversal misses them, or if there's an `inset` we're not accounting for).

## What the research agent(s) should investigate

### Primary question

**Does Mozilla's reference PDF.js viewer (https://mozilla.github.io/pdf.js/web/viewer.html) exhibit the same bug on the same PDF?**

Open `~/Downloads/2026 Management fellow Job Description.pdf` in the reference viewer and try to reproduce: click in the right margin of the "GENERAL RESPONSIBILITIES" bulleted list, observe whether the selection grabs the whole block. If **yes, the reference viewer has the same bug**, this is a PDF.js limitation and the realistic v1 fix is "don't allow margin clicks; require click-on-glyph." If **no, the reference viewer is fine**, we're missing some piece of their selection setup beyond the `endOfContent` + `.selecting` + DOM-insertion + `includeMarkedContent` work we've already done.

### Secondary questions

1. **What's in the DOM that PDF.js v5's `TextLayer` produces for this specific PDF?** Specifically the bulleted-list region. Is it:
   - Flat spans in stream order, with stream order ≠ visual reading order? (Most likely.)
   - `markedContent` divs that wrap groups? (Would help selection scoping.)
   - Something else?

   The answer determines whether we need to fix PDF.js options, post-process the rendered text layer, or accept the limitation.

2. **What does PDF.js's `TextLayerBuilder` do that our bare `TextLayer` consumer doesn't?**
   We've ported `endOfContent` + `.selecting` + the selectionchange repositioning. What else is in `pdf_viewer.mjs` ~L6200–L6380? Is there an `accessibilityManager` or `highlighter` step that affects selection? Is there a setup we're missing?

3. **Is there a known PDF.js issue / Stack Overflow thread / GitHub issue** describing "click in margin grabs whole block" or "drag selection picks distant text"? The PDF.js bug tracker likely has prior art.

4. **Are there any existing well-behaved electron-PDF-annotation projects** (PDFTron, Apryse, react-pdf, pdf-annotate.js, etc.) whose source we could study for how they handle this exact case? The goal is **not** to adopt them — just to see if their solution is more aggressive than the `endOfContent` pattern.

5. **Is there a CSS-level fix that constrains selection within block-level boundaries?** Browsers respect `contenteditable` boundaries and `user-select: contain` (where supported). If we can mark each list-item / paragraph as a selection-containment boundary, the browser's selection extension would respect it.

### How to brief the research agent

The agent should:

1. Start by reading this handoff doc + the spec sections referenced (§4.2, §4.3, §5.2, §11).
2. Open the test PDF in Mozilla's reference PDF.js viewer (online) and the bug PDF; reproduce the bug there first.
3. If the reference viewer DOES NOT show the bug, diff its `TextLayerBuilder` setup against ours (`desktop/renderer/pdf-viewer.ts`). Identify what we're missing.
4. If it DOES show the bug, search PDF.js GitHub issues for prior reports + look for whether there's a known workaround.
5. Survey 2–3 well-regarded PDF annotation projects (open-source) for their selection-handling approach. One-line takeaways from each, not deep dives.
6. Report findings in under 600 words: what's the actual root cause, what's the minimum-viable fix, and what's the cost/benefit of each option.

The agent does **NOT** need to write code — just research and propose. A subsequent session can implement.

## State of the repo at handoff

- **Branch:** `main`. Working tree has uncommitted changes in `desktop/renderer/{index.html, index.ts, pdf-viewer.ts, styles.css}` — all the milestone #3 work + the (broken) selection-bug fixes. Nothing committed yet because the selection bug should land alongside its fix.
- **Build state:** `npm run typecheck` and `npm run build` are clean.
- **Manual verification:** Tool palette + bottom-input + right-drawer comment stream all work as specified. The PDF text-selection bug is the only blocker.
- **Dev session:** an `npm run dev` process may still be running from this session (background process `bxyypl0q1`). Kill it before re-launching.

## Suggested next session — order of operations

1. Spawn research agent(s) per the brief above.
2. Read the agent's report; decide one of:
   - **a)** the bare `TextLayer` setup is salvageable with one more API tweak → implement, verify, commit milestone #3.
   - **b)** the bare `TextLayer` is fundamentally wrong for this use case → switch to PDF.js's `TextLayerBuilder` (heavier dependency) or accept "click on glyph only" as a v1 limitation. Either way, document the call in this handoff's followup.
3. Once selection is sane: commit milestone #3 as a single coherent change (UI + selection fixes), push, file milestone #4 (`.review-state/drafts/` persistence + real §9.1 comment cards).

## Things that are NOT broken (regression sanity check before any change lands)

- Normal mid-paragraph drag-select on `tests/fixtures/sample-annotated.pdf` captures correctly.
- Cross-paragraph drags flow smoothly (the `endOfContent`-repositioning fix from this session).
- End-of-line drag doesn't jump to a distant glyph (`endOfContent` + `.selecting` fix from this session).
- The persistent yellow overlay renders cleanly (no double-shaded middle lines — `mergeRectsByLine` fix from this session).
- §5.2 banner still shows on damaged PDFs (the COTA file: red "corrupted text encoding" banner; pp.1–2 still selectable).
- Cmd+O / Open… button still loads PDFs; nav / fit / dark-mode buttons still work post-load.

Any "fix" for the selection bug must preserve all of the above.

---

## Outcome — 2026-05-20 (later that day)

**Resolved with a port to PDF.js's `TextLayerBuilder` + `StructTreeLayerBuilder`.**
Previously we hand-ported the selection-trap machinery on top of the bare
`TextLayer`. Empirically that port carried a margin-click phantom-selection
bug that Mozilla's reference viewer (https://mozilla.github.io/pdf.js/web/viewer.html)
did NOT exhibit on the same PDF. The fix was to stop hand-porting and instead
consume the actual `TextLayerBuilder` from `pdfjs-dist/web/pdf_viewer.mjs`
(plus `StructTreeLayerBuilder`, which appends the PDF's tagged-structure DOM
into the canvas element with `aria-owns` links to the textLayer spans).

`TextLayerBuilder` now owns: the `.selecting` class toggle on mousedown,
`endOfContent` sentinel placement, selectionchange repositioning,
`pointerup` / `blur` / `keyup` global resets, and abort-signal teardown.
All the bespoke code in `pdf-viewer.ts` that mirrored those concerns is
gone (~150 lines removed, file is now ~470 lines vs ~625 before). We also
dropped the body-line-rect margin gate entirely — TextLayerBuilder does not
have one and demonstrably does not need one.

What we lost: `TextAccessibilityManager` is defined inside `pdf_viewer.mjs`
but is NOT in its public export list, so we can't construct one. The
practical effect is no `aria-owns` decoration on text spans (accessibility
only — not selection-relevant). Real impact: zero, for our review use case.

### Residual limitation (known, documented)

On the bug PDF (`~/Downloads/2026 Management fellow Job Description.pdf`)
the initial-click phantom-block bug is **gone**. Margin clicks now do
nothing (caret placement falls through to the nearest legitimate glyph or
is suppressed by `endOfContent`).

However, a **backward drag** from the end of the first bullet line ("…to
focus") through earlier text still extends through every sub-bullet in the
"GENERAL RESPONSIBILITIES" block. This is the classic PDF.js stream-order
≠ visual-order issue: the textLayer's spans come out of `streamTextContent`
in PDF stream order, which for this Word-exported bulleted PDF does NOT
match visual reading order. The browser's selection-extension walks DOM
order, so a backward drag picks up everything between the new endpoint
and the fixed anchor in DOM, even spans that are visually far from the
cursor path.

Mozilla's reference viewer exhibits the same behavior on the same PDF
("a little glitchy" per AJB's empirical test). This is Mozilla issue
[mozilla/pdf.js#17191](https://github.com/mozilla/pdf.js/issues/17191) —
an open, unresolved PDF.js limitation. Our setup is now at feature parity
with the reference viewer; the remaining glitch is below us in the stack.

The visual difference between Mozilla and our app on the residual case
comes from our persistent §5.2 highlight overlay (load-bearing for the
"highlight must survive focus shift to comment input" requirement). When
the selection captures a structurally-wrong run, the overlay paints rects
across all the affected lines, making the mistake very visible. Mozilla
shows only native `::selection` which is more ephemeral. The overlay is
correct per §5.2; the underlying selection is what's noisy.

### Follow-up TODO (out of scope for milestone #3)

- File a bd issue when the bd workspace is reachable in this checkout
  (currently `bd where` errors — tooling problem, not project problem):
  "Selection on bulleted PDFs extends through sub-bullets in DOM order
  (PDF.js #17191 limitation; matches Mozilla's reference viewer)."
- Possible future mitigation: use the structTree's `aria-owns` linkages
  to detect when a captured selection crosses too many structural groups
  (paragraph / list item) and trim or warn. Defers to a later milestone.
- Possible future mitigation: lighten the persistent overlay's opacity /
  drop `mix-blend-mode: multiply` so when the selection IS noisy, the
  rendering is less aggressive.

### State of the repo at this outcome

- Branch: `main`, working tree dirty.
- Files in the milestone #3 + selection-fix commit:
  - `desktop/renderer/index.html`, `desktop/renderer/index.ts`,
    `desktop/renderer/styles.css` (tool palette §4.2, bottom input §4.3,
    engagement-level color coding §11, right-drawer comment stream — all
    from the prior session, never committed)
  - `desktop/renderer/pdf-viewer.ts` (this session's port to
    `TextLayerBuilder` + `StructTreeLayerBuilder`)
  - `desktop/renderer/vite-env.d.ts` (module declaration for
    `pdfjs-dist/web/pdf_viewer.mjs` since pdfjs-dist 5.x ships no .d.ts
    at that subpath)
  - `docs/handoffs/2026-05-20-milestone-3-selection-bug-research-handoff.md`
    (this doc, including this Outcome section)
- `npm run typecheck` + `npm run build` clean.
- Milestone #4 still TODO: `.review-state/drafts/<doc-version>.json`
  persistence + real §9.1 comment cards in place of the milestone-#3
  echo-to-right-drawer stub.
