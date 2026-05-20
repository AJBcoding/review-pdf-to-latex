---
type: handoff
status: milestone #4 shipped (committed cc8ccdd, pushed). next up — see "Suggested next session" for milestone #5 options.
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: build day 3 — drafts persistence + real §9.1 comment cards
predecessors:
  - docs/handoffs/2026-05-20-milestone-3-done-milestone-4-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§8 payload, §9.1
    comment cards, §10.3 drafts persistence contract, §11 engagement
    levels, §13.x pre-build picks)
---

# Milestone #4 done — drafts persistence + click-to-anchor cards

## What landed this session (commit cc8ccdd, pushed)

The §9.1 comment cards are now real (not a milestone-#3 echo stub) and
backed by an on-disk snapshot. Submitting a comment writes to
`<pdf-dir>/.review-state/drafts/<sha256>.json`; reopening the PDF
rehydrates the cards from that file; clicking a card jumps back to
the anchor and repaints the persistent highlight.

**End-to-end shape:**

1. `fs:readPdfBytes` in main now computes `sha256(bytes)` and returns
   it alongside the bytes. The renderer captures it as `docState.sha256`
   and uses it for both `doc_version` (§8) and the drafts filename.
2. Two new IPC handlers: `drafts:read` and `drafts:write`. Read returns
   `{ok:true, file:null, reason:'not_found'}` for the first-open case
   (not an error). Write is atomic — `mkdir -p` the drafts dir, write
   to `<file>.<rand>.tmp`, then `rename` into place. A mid-write crash
   can't leave a half-written drafts file.
3. The renderer keeps an in-memory mirror at `docState.comments`. On
   submit: push → `renderAllCards()` rebuilds the stream DOM → 250ms
   debounced `writeDrafts` call (per spec §10.3). On `loadPdf`: reset
   state → `readDrafts` in parallel with `readPdfBytes` → render.
4. `PdfViewer.revealAnchor(page, region)` is the new public method
   that powers click-to-anchor. It navigates via `gotoPage` then walks
   the four PDF-space corners back through `viewport.convertToViewportPoint`
   to get a current-zoom screen-space bbox, paints into the highlight
   layer, and `scrollIntoView`s the rect. Stable across zoom because
   the persisted `anchor.region` is in PDF points, not pixels.

**Decisions taken this session (with rationale, since the spec was
silent on each):**

- **Drafts location:** `<dir-of-pdf>/.review-state/drafts/<sha256>.json`.
  AJB's call — "we'll be reviewing documents, mostly, from github repos
  or from a user folder; the .json should live within those locations."
  Drafts travel with the document, not with the app install.
- **Persistence format:** snapshot (full rewrite on every debounced
  flush), not append-only journal. Simpler, naturally supports the
  edit/delete affordances §9.1 hints at, and 250ms debounce means we
  never write at journal-like frequency anyway.
- **`doc_version` derivation:** sha256 of file bytes. Stable across
  renames, copies, and `mtime`-touching tools. Computed in main
  alongside the byte read so there's no extra IPC roundtrip.
- **`doc_id`:** for v1, also the absolute path. Conceptually different
  from `doc_version` (the latter is content-derived, the former is the
  "this is the same document over time" identity), but until there's a
  project model that issues stable IDs, the path is the best we have.

## State of the repo at handoff

- **Branch:** `main`, at commit `cc8ccdd`, pushed to `origin/main`.
  Working tree dirty only with the same `.beads/*` tooling state the
  prior handoff flagged (`.beads/metadata.json` deletion + untracked
  `.beads/PRIME.md`, `.beads/.gt-types-configured`, `.beads/locks/`).
  Intentionally not committed — beads isn't initialized in this
  checkout, and the `.beads/` tree predates the rebuild.
- **Quality gates:** `npm run typecheck` + `npm run build` clean.
- **Beads workspace:** `bd where` still errors in this checkout.
  Same TODO as prior handoff; follow-ups for this milestone are
  filed below until that's resolved.

## Verification done this session

Verified end-to-end via Playwright-driven Electron (`/tmp/verify-m4.js`,
not checked in). 10 steps, all PASS:

1. App boots cleanly, IPC bridge + engine probe both green.
2. Mocked `dialog.showOpenDialog` in main (`contextBridge` freezes
   `window.electronAPI`, so renderer-side monkey-patching silently
   no-ops), clicked `#pdfOpen`, fixture loaded, text layer rendered.
3. `electronAPI.readPdfBytes(fixture)` returned `sha256` matching
   `shasum -a 256` exactly — sha256 derivation correct.
4. Injected a programmatic `Range` across textLayer spans + dispatched
   `mouseup`; anchor meta flipped to `has-selection` with the right
   PDF-space region.
5. Submitted a Comment, then switched to Redraft and submitted again
   on the same selection → 2 cards in `#commentStream`, `data-level`
   order `["redraft","comment"]` (newest first).
6. After 600ms (250ms debounce + slack), drafts file exists on disk
   at the expected path with the expected schema.
7. `electronAPI.readDrafts(fixture, sha256)` round-trips cleanly.
8. Reload PDF → cards re-render from disk (count stable at 2).
9. Click a card → `revealAnchor` repainted a highlight rect from the
   persisted PDF-space region.
10. Empty-buffer submit is a silent no-op as spec'd.

Screenshot at `/tmp/verify-m4-final.png` (ephemeral; regenerate by
re-running the verify script). Two-line yellow highlight on the
fixture, both cards in the right drawer with correct level/anchor/quote.

The fixture is single-page, so `revealAnchor`'s `gotoPage` was a no-op
in the test — the cross-page navigation path is exercised by the
coordinate transform code (which fired and rendered correctly) but
not by the page-switching code (which is a one-liner delegating to
the existing `gotoPage`). Low risk, but worth a manual cross-page
check at first opportunity.

## Known limitations (to file as follow-ups)

These are all real-but-bounded gaps, not regressions. Listed in
rough priority order.

1. **No flush-on-quit handler.** If the user submits a comment then
   `Cmd+Q`s the app within 250ms, the debounced write hasn't fired
   yet and the comment is lost. Fix: bind `window.addEventListener
   ('beforeunload', flushDraftsWrite)` in the renderer + an
   `app.on('before-quit')` channel in main to await the flush before
   the process exits. Low likelihood per-event, but cumulative if
   AJB closes a session abruptly.

2. **Cards aren't grouped by engagement level.** Spec §9.1 says
   "Group by engagement level (L1/L2/L3)." Today they're chronological
   (newest-first) with color-coded left borders. Visually clear which
   is which, but you can't scan "all my redrafts" without your eye
   doing the filtering. Easy follow-up: bucket `docState.comments`
   by `engagement_level` and render three labeled sections.

3. **No keyboard navigation in the comment stream.** Spec §15 wants
   `j` / `k` to move between cards and `Enter` to jump to the focused
   card's anchor (same as click). Currently click-only.

4. **No edit / delete affordances on cards.** Spec §9.1 marks these
   "Maybe" so they're not strictly milestone-#4 work, but they're the
   most-obvious missing card actions. The persistence layer is ready
   for them — `renderAllCards` rebuilds from `docState.comments`, so
   mutating that array + scheduling a write is the whole flow.

5. **Standalone (no-anchor) comments still blocked.** Spec §5.1
   wants a click-to-anchor affordance + ability to leave general
   document-level comments. Today the bottom input flashes "Select
   text first" on submit without a selection.

6. **`revealAnchor` cross-page path not exercised in verification.**
   The single-page fixture meant `gotoPage` was a no-op. The
   coordinate transform fired correctly, but the first real bug
   here will be in someone's multi-page review session. Worth a
   manual cross-page click at first opportunity (or add a multi-page
   fixture to `tests/fixtures/`).

7. **No retry / persistence error UI beyond the meta-line flash.**
   `writeDrafts` failures flash a 2s message in the anchor meta and
   then disappear — easy to miss. The in-memory state stays
   authoritative until the next successful write, so no data is
   lost mid-session, but the user has no way to know they should
   stop trusting that their work is saved.

8. **`bd workspace not initialized` (carried forward from prior
   handoff).** `bd where` still errors. Until resolved, all
   follow-ups live in handoff docs instead of bd.

## Follow-up TODOs (filed in bd)

Filed in bd after mayor (mail hq-gheez) restored `.beads/metadata.json`
and removed the broken `.beads/redirect` mid-session. All labeled
`milestone-4-followup`.

- [`rev-cm6`](#) P2 [bug] Flush drafts on app quit + window unload.
- [`rev-6vc`](#) P3 Group §9.1 cards by engagement level (L1/L2/L3
  sections).
- [`rev-680`](#) P3 `j` / `k` / `Enter` keyboard navigation in the
  comment stream (spec §15).
- [`rev-b8t`](#) P3 Edit / delete actions on comment cards.
- [`rev-6nh`](#) P3 Standalone (no-anchor) comments + click-to-anchor
  affordance (spec §5.1).
- [`rev-4qc`](#) P3 Add multi-page fixture; verify `revealAnchor`
  cross-page path.
- [`rev-a1x`](#) P3 Better persistence-error UI than 2s meta flash.
- [`rev-4pr`](#) P3 [bug] Backward-drag selection extends through
  sub-bullets on bulleted PDFs (PDF.js #17191 — carried from prior
  handoff).

(Prior handoff's "bd workspace not initialized" item resolved this
session by mayor.)

## Suggested next session — milestone #5 options

Spec doesn't pin a #5 sequence, so this is a menu. Pick based on
appetite + what AJB wants to feel working next.

**Option A — finish §9.1 + §15 (cleanup pass).** Bundle the
M4-followups 1–4 into one milestone: flush-on-quit, group by level,
j/k navigation, edit/delete. Smallest scope, makes the right drawer
feel "done" rather than "mostly there." Estimate: half a day.

**Option B — §3 left drawer (file tree).** Currently the left pane
is a static empty-shell placeholder. Wire it to a configurable
working directory, list PDFs, click-to-open replaces `Cmd+O`. Opens
the door to multi-doc workflows. Spec §3 has the design — file
tree, quick-open (`Cmd+P`), maybe per-doc state hints (already-has-
drafts indicator now that we know the sha256). Estimate: 1–2 days.

**Option C — §10.1 submit → agent handoff.** The "save" half of
§10 is done (drafts persistence); the "submit to agent" half is
not. This is where the review work would actually flow to the
LaTeX engine. Significant scope — needs the engine-side contract
worked out too. Estimate: multi-day, blocks on spec gaps in §10.1.

**Option D — §9.2 embedded Claude pane.** node-pty + xterm.js per
§13.4. High UX impact but heavy lift, and arguably less urgent than
making the review tools themselves feel complete (Option A or B).
Estimate: 2–3 days for a usable v1.

**My recommendation:** Option A if AJB wants to use the app for real
reviewing soon (flush-on-quit alone is worth shipping — losing a
comment to a quick Cmd+Q would erode trust fast). Option B if the
file picker is starting to feel like a paper cut.

## Files touched this session

- `desktop/shared/types.ts` — `CommentPayload` (moved here from
  renderer), `DraftsFile`, `DraftsReadResult`, `DraftsWriteResult`,
  `EngagementLevel`. `ReadPdfBytesResult.ok` carries `sha256`.
  `ElectronAPI` gains `readDrafts` + `writeDrafts`.
- `desktop/main/index.ts` — sha256 of bytes in `fs:readPdfBytes`,
  `drafts:read` + `drafts:write` handlers, `draftsPathFor` helper.
- `desktop/preload/index.ts` — bridge for the two new IPC channels.
- `desktop/renderer/pdf-viewer.ts` — new public `revealAnchor(page,
  region)` method.
- `desktop/renderer/index.ts` — drafts mirror in `docState.comments`,
  `viewerRef` module-level, debounced write + flush helpers,
  `renderAllCards` / `buildCommentCard` / `buildEmptyPlaceholder`
  helpers replace the old `appendCommentCard`, click-to-anchor
  wiring on each card.
- `desktop/renderer/styles.css` — `cursor: pointer` + hover state on
  `.comment-card`.
- This doc.
