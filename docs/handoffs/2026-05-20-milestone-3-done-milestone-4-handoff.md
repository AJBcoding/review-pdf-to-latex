---
type: handoff
status: milestone #3 shipped (committed 266a99b, pushed). next up — milestone #4 (drafts persistence + real §9.1 cards).
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: build day 2 close — milestone #3 commit + push
predecessors:
  - docs/handoffs/2026-05-20-milestone-3-selection-bug-research-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§4.2 tool palette,
    §4.3 bottom input, §5.2 selection accuracy, §8 payload, §9.1 comment
    cards, §11 engagement levels)
---

# Milestone #3 done — TextLayerBuilder port shipped, milestone #4 next

## What landed this session (commit 266a99b, pushed)

**Milestone #3 UX surface** — already done in the prior session but never
committed; bundled into 266a99b alongside the selection-bug fix because
the handoff said the two should land together:

- Tool palette (§4.2): 💬 Comment / ✏️ Redraft / 🌊 Surface as small
  icon-pill buttons between the document viewer and bottom input. Active
  tool gets accent-color border. ⌘1 / ⌘2 / ⌘3 keyboard shortcuts.
- Bottom input (§4.3): plain textarea with anchor-status meta line above
  + ✗ Clear button. Enter submits, Shift+Enter soft return, Esc clears.
  After submit, the active tool and cached selection STAY active so
  Comment+Redraft on the same highlight is one fluid motion.
- Tool ↔ field mapping (§11.1): Comment/Surface → buffer becomes
  `comment`; Redraft → buffer becomes `redraft` and auto-populates with
  `highlighted_text` as the editing starter when activated on a live
  selection.
- Right-drawer comment stream: color-coded L1/L2/L3 cards (blue/purple/
  cyan) prepended on submit. Stub for milestone #4 — gets replaced by
  real §9.1 cards + persistence.
- §8 payload built per spec (id, doc_id, doc_version stub, anchor,
  highlighted_text, comment, redraft, engagement_level, author, kind,
  status, created_at).
- "Standalone (no-anchor) comments" are explicitly out of scope —
  submit with text + no cached selection flashes a 2s "Select text in
  the PDF first to anchor this comment" on the meta line.

**Selection-bug fix** — the real work of this session:

The prior session hand-ported PDF.js's selection-trap machinery
(`endOfContent` sentinel, `selectionchange` repositioning, `.selecting`
class toggle) on top of the bare `TextLayer` class. That port carried a
margin-click phantom-selection bug that Mozilla's reference viewer
(https://mozilla.github.io/pdf.js/web/viewer.html) demonstrably did
**not** have on the same PDF. AJB confirmed by loading the bug PDF in
the reference viewer.

The fix was to stop hand-porting and instead **import the actual
`TextLayerBuilder` + `StructTreeLayerBuilder`** from
`pdfjs-dist/web/pdf_viewer.mjs`. These classes are publicly exported
(see the `export { ... }` statement at the bottom of pdf_viewer.mjs)
and importable directly. `TextLayerBuilder` now owns:

- `.selecting` class on mousedown
- `endOfContent` sentinel placement
- `selectionchange` repositioning of the sentinel
- `pointerup` / `blur` / `keyup` global resets
- abort-signal teardown lifecycle

`StructTreeLayerBuilder` walks the PDF's tagged structure tree and
appends a parallel DOM of structure-shaped `<span>`s into the canvas
element, with `aria-owns` linkages back to the textLayer spans.

What was deleted from `pdf-viewer.ts` (~150 lines): the bespoke
`endOfContent` management, our `onSelectionChangeForEndOfContent`
handler, `resetEndOfContent`, the body-line-rect margin gate
(`bodyLineRects`, `computeBodyLineRects`, `isInTextBody`), the
4px-drag-distance threshold, the `prevSelectionRange` field, the
mousedown `.selecting` toggle. All of that is owned by
`TextLayerBuilder` now. File went from ~625 lines to ~470.

What we lost: `TextAccessibilityManager` is defined inside
`pdf_viewer.mjs` but NOT in its public export list, so we cannot
construct one. The practical effect is no `aria-owns` decoration on
text spans (accessibility only — not selection-relevant). Zero impact
on the review use case.

What we kept: canvas page rendering, the persistent §5.2 highlight
overlay (load-bearing — survives focus shift to the comment input
that collapses native ::selection), `SelectionPayload` shape,
navigation/zoom/fit/dark-mode, capture-on-mouseup.

## State of the repo at handoff

- **Branch:** `main`, at commit `266a99b`, pushed to `origin/main`.
  Working tree dirty only with `.beads/*` tooling state (untracked
  files + a deletion of `.beads/metadata.json`) — intentionally not
  committed because beads isn't initialized in this checkout.
- **Quality gates:** `npm run typecheck` + `npm run build` clean.
- **Beads workspace:** `bd where` errors in this checkout (database
  isn't initialized). Tooling problem, not project problem. The
  follow-up TODO list below should be filed in bd once it's reachable.

## Known residual limitation (PDF.js #17191)

On the bug PDF (`~/Downloads/2026 Management fellow Job Description.pdf`):

- ✅ **Margin-click phantom-block bug is fixed.** Clicking in the right
  margin of the bulleted "GENERAL RESPONSIBILITIES" block now does
  nothing (or places a caret precisely), matching Mozilla's behavior.
- ⚠️ **Backward-drag on bulleted PDFs still extends through sub-bullets.**
  Dragging backward from the end of the first bullet line ("…to focus")
  picks up every span between the new endpoint and the fixed anchor in
  DOM order — including sub-bullets that are visually far from the
  cursor path. This is the classic stream-order ≠ visual-order issue:
  PDF.js's `streamTextContent` emits spans in PDF stream order, which
  for this Word-exported bulleted PDF does NOT match visual reading
  order. Mozilla's reference viewer exhibits the same behavior
  ("a little glitchy" per AJB's empirical test). Mozilla issue
  [#17191](https://github.com/mozilla/pdf.js/issues/17191), open and
  unresolved.

Our setup is at feature parity with the reference viewer. The remaining
glitch is below us in the stack.

The visual difference between Mozilla and our app on the residual case
comes from our persistent §5.2 highlight overlay (which Mozilla doesn't
have). When the selection captures a structurally-wrong run, our
overlay paints rects across all the affected lines, making the mistake
very visible. Mozilla shows only native `::selection` which is more
ephemeral. The overlay behavior is correct per §5.2; the underlying
selection is what's noisy.

## Things that are NOT broken (regression sanity check before any change)

- Margin click in the bulleted region does nothing (fixed in 266a99b).
- Normal mid-paragraph drag-select on `tests/fixtures/sample-annotated.pdf`
  captures correctly.
- Cross-paragraph drags flow smoothly.
- End-of-line drag doesn't jump to a distant glyph.
- The persistent yellow overlay renders cleanly (no double-shaded
  middle lines — `mergeRectsByLine` is preserved).
- §5.2 banner still shows on damaged PDFs (the COTA file: red
  "corrupted text encoding" banner; pp.1–2 still selectable).
- Cmd+O / Open… button still loads PDFs; nav / fit / dark-mode buttons
  still work post-load.
- New selection clears the persistent highlight overlay (mousedown
  listener on the textLayer div calls `clearHighlight()`).

## Suggested next session — milestone #4

**Goal:** swap the milestone-#3 "echo to right drawer" stub for real
§9.1 comment cards backed by `.review-state/drafts/<doc-version>.json`
persistence.

Order of operations:

1. **Persistence layer.** Define the on-disk schema in
   `.review-state/drafts/<doc-version>.json` (one file per doc version
   per the spec's path scheme). Use the §8 payload shape we already
   build. Decide: append-only journal vs full-state snapshot? Spec
   §9.x doesn't mandate.
2. **Main-process IPC for read + write.** Renderer should not touch
   the filesystem directly. Add `electronAPI.readDrafts(docId)` and
   `electronAPI.appendDraft(docId, payload)` to the preload bridge.
3. **Real §9.1 comment cards** in the right drawer:
   - Group by engagement level (Comment / Redraft / Surface).
   - Show the quoted `highlighted_text`, the comment/redraft body, an
     anchor pill (`p.N · x,y w×h`).
   - Click on a card scrolls the PDF to that anchor + re-renders the
     persistent highlight at that location.
   - Maybe: edit / delete actions on each card.
4. **Doc-version stub.** Right now we hardcode `doc_version: "1.0"`.
   Decide how to derive this — file content hash? mtime?
   Open question; spec doesn't pin it down.

Out of scope for milestone #4 (per spec, deferred to later milestones):
LaTeX export, multi-user merge, comment threading.

## Follow-up TODOs (file in bd when reachable)

- "Selection on bulleted PDFs extends through sub-bullets in DOM order
  on backward drag (PDF.js #17191 limitation; matches Mozilla's
  reference viewer; documented in milestone-3-selection-bug-research
  handoff)."
- "bd workspace not initialized in main checkout (`bd where` errors).
  Investigate whether to `bd init` or whether the beads/ tree is meant
  to live elsewhere."
- Possible future mitigation for the residual selection issue: use the
  structTree's `aria-owns` linkages to detect when a captured selection
  crosses too many structural groups (paragraph / list item) and trim
  or warn. Defers to a later milestone.
- Possible future mitigation: lighten the persistent overlay's opacity
  / drop `mix-blend-mode: multiply` so when the selection IS noisy, the
  rendering is less aggressive.

## Files touched this session

- `desktop/renderer/pdf-viewer.ts` — full rewrite to use TextLayerBuilder
  + StructTreeLayerBuilder.
- `desktop/renderer/vite-env.d.ts` — module declaration for
  `pdfjs-dist/web/pdf_viewer.mjs` (pdfjs-dist 5.x ships no .d.ts at
  that subpath; declaration points to the type files under
  `pdfjs-dist/types/web/`).
- `docs/handoffs/2026-05-20-milestone-3-selection-bug-research-handoff.md`
  — appended an Outcome section recording the resolution + residual
  limitation.
- This doc.

(The prior session's milestone-#3 UI work — `index.html`, `index.ts`,
`styles.css` — was already on disk uncommitted at the start of this
session and rode in on the same commit.)
