---
type: handoff
status: milestone #2 (project-open) done + verified; ready for milestone #3 (bottom input + tool palette)
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: build day 2 — project-open flow
predecessors:
  - docs/handoffs/2026-05-20-electron-build-day-1-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§4.2 tool palette, §4.3 bottom input, §11 engagement levels)
---

# Milestone #2 done — handoff to milestone #3 (tool palette + bottom input)

## What got done this session (two commits)

1. **`7a7d9ec` — feat(desktop): milestone #2 — project-open flow (spec §5.2).**
   Replaced the hardcoded `PROBE_PDF` auto-load with a real project-open flow:
   - "Open…" button at the start of the nav strip (⌘O/Ctrl+O accelerator)
   - Empty state in the document pane until a PDF is picked
   - Native picker → `readPdfBytes` + `pdfHealth` run **in parallel** via `Promise.all`
   - §5.2 load-time banner driven by the pdf-health report, with distinct copy per failure mode: open-error / encrypted / all-unreadable / partial / ligature-loss; clean PDFs hide the banner entirely
   - Document-pane title shows the loaded filename
   - Page-nav / Fit page / Fit width / dark-mode buttons disabled until a PDF loads
   - Dropped the startup pdf-health diagnostic probe (now exercised per-document)

2. **`48c0103` — fix(desktop): empty-state DOM clobbered viewer mount; soften §5.2 copy.**
   Two issues caught during verification:
   - **Bug:** Empty state was rendered inside the viewer's mount, but `PdfViewer`'s constructor calls `container.replaceChildren(stage)`. Re-rendering the empty state on top of the stage detached the viewer's canvas/textLayer from the DOM, so the first picked PDF never appeared. **Fix:** keep the empty state and the viewer mount as *siblings* under `.document-area` and toggle visibility via `[hidden]` instead of `replaceChildren`.
   - **Copy:** Banner for the all-unreadable + partial cases said "no readable text", which overstates the problem. The engine's `pdf-health` uses poppler/pdftotext semantics — CID-only pages with missing ToUnicode maps are flagged "unreadable" even though PDF.js's TextLayer *can* still surface glyphs from them (just with ligature corruption). The COTA PDF hits this: all 10 pages marked unreadable, yet pp.1–2 are selectable. Reframed the copy as "corrupted text encoding" / "text extraction is unreliable" — accurate to what the user sees and actionable (rebuild from source for clean capture).

## State of the app right now

`npm run dev` from `desktop/` launches a window that:

- Boots into an empty-state placeholder ("No PDF loaded — Click **Open…** above to choose a PDF.")
- Two top-right diagnostics: IPC bridge ✓ + engine ✓ (the prior pdf-health probe line was removed)
- Click **Open…** (or ⌘O/Ctrl+O) → native PDF picker
- On pick: parallel `readPdfBytes` + `pdfHealth`; banner appears between header and document area iff the report flags problems; title shows filename; nav/fit/dark buttons enable
- Drag-select still emits the §5.2 payload to the bottom-input echo
- Reopening swaps to the new file; canceling the picker leaves current state untouched

**Verified manually against:**
- `tests/fixtures/sample-annotated.pdf` → clean load, no banner. Selection echo works. Nav + dark mode work.
- `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` → red "corrupted text encoding" banner; pp.1–2 still selectable (with ligature loss); pp.3–10 blank.

Not yet verified: partial-damage case (a PDF with *some* readable + *some* unreadable pages). The page-range formatter (`pages 3–10, 12, 15–17`) hasn't been exercised against a real partial-damage file.

## Where to pick up next: milestone #3 — tool palette + bottom input

**Spec sources:** `docs/specs/2026-05-19-electron-app-ux-spec.md` §4.2 (tool palette) + §4.3 (bottom input) + §11 (engagement levels).

### Scope

1. **Tool palette** between the document viewer and the bottom input. Small icons, not big buttons:
   - 💬 **Comment** — L1, "fix this, here's why"
   - ✏️ **Redraft** — L2, "swap this sentence for this one" — populates the input with highlighted text as starting point
   - 🌊 **Surface** — L3, "this needs a rethink" — opens a brainstorm thread (the actual chat is milestone #5 territory, but the *tool* lands here so we can capture L3 comments)

   The active tool determines `engagement_level` on submit (§11.1: "one click, one level, no extra picker").

2. **Bottom input sub-pane** (replaces the current `#selectionEcho` placeholder):
   - Always present, always focused-target for new comments
   - **Plain Enter submits** (not Cmd+Enter — friction reduction §4.3)
   - **Shift+Enter** for soft return
   - Mode toggle indicates active tool; toggling Redraft + having a selection → populate input with `highlighted_text` as starting point
   - "✗ Clear" affordance to blank the field after a Redraft populate
   - After submit, **the active tool stays active** (one fluid motion for repeated comments)
   - **No half-typed persisted state** — the buffer is in-memory until Enter

3. **What to do on submit:** For milestone #3, the submit handler builds the comment payload (per §8 data model) and echoes it visibly somewhere (e.g. the right drawer's comment-stream placeholder, or a console panel) — full persistence to `.review-state/drafts/<doc-version>.json` is milestone #4.

### NOT in scope for milestone #3

- Persisting comments to the draft file (that's milestone #4 + §10.3)
- Comment cards in the right drawer (milestone #4)
- The actual L3 brainstorm chat surface (milestone #5)
- Strikethrough as a top-level tool — §4.2 has an AJB note about whether Strikethrough is a separate tool vs. a Redraft sub-mode; defer until AJB decides

### Files to touch

- `desktop/renderer/index.html` — tool palette element between header and document, replace `#selectionEcho` placeholder with real input
- `desktop/renderer/styles.css` — tool palette + input styling
- `desktop/renderer/index.ts` — wire tool selection state, hook into `viewer.onSelection`, implement submit handler, build comment payload
- Possibly extract `desktop/renderer/comment-input.ts` if the bottom-input logic gets big enough to warrant a module

### Suggested implementation order

1. Add tool palette UI (three buttons, active-tool state, no behavior yet)
2. Add bottom-input element with Enter/Shift+Enter handling
3. Wire `viewer.onSelection` → cache the latest selection payload; on tool=Redraft + selection, populate input with `highlighted_text`
4. Submit handler → build comment payload (id=UUID, doc_id, doc_version="1.0" stub, anchor={page,region}, highlighted_text, comment, redraft, engagement_level, kind="comment", status="open", author="AJB", created_at) → log to right-drawer placeholder for now
5. Keep tool active after submit; clear input; preserve last selection so user can submit multiple comments on the same highlight if they want

## Things the next session can rely on

- `viewer.onSelection({page, region, screenRects, highlighted_text})` fires after a debounced selectionchange (120ms) — see `desktop/renderer/pdf-viewer.ts` for the payload shape. Use `highlighted_text` for Redraft populate, `region` + `page` for the comment anchor.
- `screenRects` is renderer-internal (host highlight drawing). One of the prior session's open items is whether to filter `screenRects` out before persistence — flagged for milestone #4, not #3.
- The empty-state ↔ viewer toggle pattern (siblings under `.document-area`, `[hidden]` attr) is the load-bearing fix from this session. Don't `replaceChildren` on the viewer's mount; the viewer owns its children.
- The §5.2 banner is non-blocking and lives between the nav header and document area — the tool palette can sit between the banner and the document area, or between the document area and the bottom input. Spec §4.2 says "between viewer and input," so the latter.
- §8 data model is the canonical comment shape — see `docs/specs/2026-05-19-electron-app-ux-spec.md` line ~225.
- §11 maps tool ↔ engagement_level 1:1; no separate picker.

## Things to NOT do

- Don't wire persistence to disk yet. The submit path should build the payload and echo it; touching `.review-state/drafts/` is milestone #4's job and needs the §10.3 filesystem contract to land first.
- Don't restructure `PdfViewer`. Selection capture works; the API surface is stable.
- Don't add a `Cmd+Enter` submit shortcut as an "also allowed" — §4.3 is explicit that plain Enter is the submit, Cmd+Enter is not. Two paths confuse muscle memory.
- Don't drop the selection on submit. The user may want to submit a Comment *and* a Redraft against the same highlight back-to-back; the selection should persist until the user makes a new one or clears it explicitly.

## Open items still on AJB's plate (carried from milestone #1 handoff)

- **Diagnostic placement.** Currently top-right corner, muted/small. Final placement still deferred.
- **Selection payload schema.** `screenRects` field is renderer-internal; should be filtered before persistence (will matter for milestone #4).
- **Dark-mode validation.** CSS filter works on the clean sample; untested on multi-column PDFs and PDFs with colored figures.
- **Strikethrough tool placement** (§4.2 typo note): is it a top-level tool or a Redraft sub-mode? Defer until milestone #3 prototypes the palette and AJB can see the layout.

## Quick start for the next session

```bash
cd /Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex
git pull --rebase
cd desktop
npm run dev                  # launches the window
# in a separate terminal:
npm run typecheck            # all three composite projects
```

Spec entry points: §4.2, §4.3, §11. Comment data model in §8.
