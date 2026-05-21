---
type: handoff
status: milestone #5 shipped (commit e2549ba). next up — see "Suggested next session" for milestone #6 options.
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: build day 4 — §9.1/§15 cleanup pass
predecessors:
  - docs/handoffs/2026-05-20-milestone-4-done-milestone-5-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§9.1 comment cards,
    §10.3 drafts persistence, §15 keyboard table)
---

# Milestone #5 done — right-drawer cleanup pass

## What landed this session (commit e2549ba)

Bundled four milestone-4 follow-ups so the right drawer feels done rather
than mostly-there. The prior handoff scoped this as "Option A" and noted
that flush-on-quit alone was worth shipping (only data-loss risk in the
prior milestone).

**End-to-end shape — what the user sees:**

- Submitting a comment then hitting `Cmd+Q` within 250ms no longer loses
  the comment.
- The right drawer is now grouped: a labeled `L1 Comment` / `L2 Redraft` /
  `L3 Surface` section heading sits above each bucket, in level order
  (so you can scan "all my redrafts" without your eye filtering).
- `Tab` lands on the first card. `j`/`k` (or `↓`/`↑`) walk between cards.
  `Enter` on a focused card jumps to its anchor and repaints the highlight
  — same outcome as click.
- Hovering a card reveals two small action buttons (`✎` edit, `×` delete)
  in its top-right corner. Edit loads the body back into the bottom input
  ("Editing L1 Comment — Enter to save · Esc to cancel"); Submit updates
  in place. Delete confirms first.

## Issues closed

| ID        | Title                                                                    |
|-----------|--------------------------------------------------------------------------|
| rev-cm6   | desktop: flush drafts on app quit + window unload                        |
| rev-6vc   | desktop: group §9.1 comment cards by engagement level                    |
| rev-680   | desktop: keyboard navigation in comment stream (j/k/Enter)               |
| rev-b8t   | desktop: edit / delete affordances on comment cards                      |

## Implementation notes

### rev-cm6 — flush handshake

The renderer's 250ms drafts debounce (§10.3) opened a small data-loss
window: `Cmd+Q` before the timer fires would tear down the renderer with
the comment still in memory. Fix is a two-message IPC handshake:

1. Main's `before-quit` handler (and per-window `close` handler for macOS
   `Cmd+W`) calls `event.preventDefault()`, then sends `drafts:flushRequest`
   with a random id to each renderer.
2. Renderer listens for the request, cancels its debounce timer if pending,
   awaits `flushDraftsWrite`, then sends `drafts:flushAck` with the id.
3. Main awaits the ack (2s timeout — generous; the debounce + atomic
   write is well under 100ms in practice) and only then re-issues
   `app.quit()` / `win.destroy()`.

Tightness detail: the renderer-side handler only writes when
`writeTimer !== null`. Without that guard, opening a PDF then closing
without commenting would write an empty drafts file next to every PDF
the user even peeks at. A `beforeunload` handler is also wired as a
best-effort fallback for unload paths the main-side hook can't intercept
(devtools reload, navigation) — best-effort because async work in
`beforeunload` isn't reliably awaited.

The window-close handler skips its own flush when an app-level flush is
already in flight — otherwise `app.quit()` would trigger a redundant
second round of requests as it closes windows. Single source of truth.

### rev-6vc — grouped sections

`renderAllCards` now buckets `docState.comments` by `engagement_level`
into three sections (`LEVEL_ORDER = ['comment', 'redraft', 'surface']`),
omitting empty buckets so a Comment-only session shows one section header
rather than three stubs. Within a bucket, the original chronological
newest-first ordering is preserved. Section header text picks up the
same accent color as each card's left-border so the heading and its
cards read as one visual group (`#4a9eff` / `#c084fc` / `#38bdf8`).

### rev-680 — keyboard navigation

Cards are `tabindex=0` + `role=button` + `aria-label` (level + page) so
they're native focus targets and screen readers hear the right semantics.
A keydown listener on `#commentStream` handles `j`/`↓` (next), `k`/`↑`
(prev), and `Enter` (revealAnchor). Movement clamps at edges; no wrap
(wrap surprises in lists this small).

Focus survives `renderAllCards` rebuilds via a module-level
`focusedCommentId` saved on the card's `focus` event — after the DOM is
replaced, the matching card (if it still exists) is re-focused with
`preventScroll: true` so a submit-while-focused doesn't yank the viewport.

The spec's "only when comment stream focused" focus discipline (§15)
falls out structurally: the listener is bound to `#commentStream`, so
keystrokes typed in the bottom input never reach it.

### rev-b8t — edit / delete

Per-card `✎` / `×` buttons live in the card head, hidden until hover/focus
via CSS opacity so the resting state stays clean. `stopPropagation` on
both prevents the click bubbling to the card-level `revealAnchor`.

- **Delete** uses `window.confirm(...)` with a body-preview snippet so the
  user knows what they're nuking (no undo yet; an explicit confirm beats
  a one-key accidental loss). Removes from `docState.comments`, clears
  `focusedCommentId`/`editingCommentId` if either pointed at the card,
  re-renders, schedules the write.
- **Edit** sets `editingCommentId` at module scope, loads the body field
  (`redraft` for Redraft cards, `comment` for the rest) into the textarea,
  matches the active tool to the card's level so Cmd+1/2/3 stays coherent,
  and flips the anchor meta to `Editing L1 Comment · Enter to save · Esc
  to cancel`. `handleSubmit` checks `editingCommentId` first and mutates
  the existing comment in-place — anchor / id / engagement_level / created_at
  are untouched. `Esc` cancels (clears input + restores normal meta). Doc
  switch (`loadPdf`) clears both `focusedCommentId` and `editingCommentId`
  so leftover state from the prior doc can't leak.

## State of the repo at handoff

- **Branch:** `main`, at commit `e2549ba`, pushed to `origin/main`.
  Working tree dirty only with the same `.beads/*` tooling state the
  prior two handoffs flagged (untracked `.beads/PRIME.md`,
  `.beads/.gt-types-configured`, `.beads/locks/`) — intentionally not
  committed, predates this milestone.
- **Quality gates:** `npm run typecheck` + `npm run build` clean.

## Verification done this session

Two Playwright/Electron scripts, both ephemeral (regenerate by re-running):

- `/tmp/verify-cm6.js` — three scenarios: (A) submit + `app.close()`
  inside the debounce window (76-91ms turnaround), (B) submit +
  `BrowserWindow.close()` inside the window, (C) clean shutdown with
  no pending writes (no spurious empty drafts file). All PASS.
- `/tmp/verify-m5.js` — drives all four follow-ups end-to-end:
  - rev-6vc: submitting 2 Comments + 2 Redrafts + 1 Surface produces
    sections in DOM order `["comment","redraft","surface"]` with counts
    `[2,2,1]` and `["cm-B","cm-A"]` newest-first within Comment.
  - rev-680: programmatic `.focus()` lands on first card; `j` advances,
    `k` returns; 10× `j` clamps at last card (index 4/4); `Enter`
    repaints highlight rects.
  - rev-b8t: edit pre-fills input with prior body, meta says "Editing",
    Submit replaces body (count unchanged); Esc discards in-flight edit;
    delete via dialog auto-accept removes one card and the deleted id
    is absent from the on-disk drafts file.
  - rev-cm6 (re-check in-session): submit + immediate `app.close()`,
    drafts file has the new comment.

## Known limitations / nits

- **Edit doesn't bump `created_at`.** Maybe it should grow an `updated_at`?
  The spec doesn't say. Filed mentally — would-be follow-up if §10.1's
  submit flow ever wants to order by "most recently touched".
- **Delete has no undo.** Confirm dialog is the only safety net. For v1
  that's probably fine; for daily-driver use, a 5s toast with "Undo"
  would be the next improvement.
- **`j`/`k` don't wrap.** Deliberate — felt less surprising in a short
  list. Reconsider if users start having 50+ cards per doc.
- **Tool switch during edit.** Switching INTO Redraft with a live
  selection (§4.3 friction reduction) will overwrite the edit buffer
  with `highlighted_text`. Edge case; not a recurring path. Left alone.
- **Standalone (no-anchor) comments still blocked** (was rev-6nh in
  the prior handoff, still open).
- **No flush-error retry beyond meta-line flash** (rev-a1x, still open).
- **Cross-page revealAnchor still unexercised** (rev-4qc — needs a
  multi-page fixture, still open).

## Suggested next session — milestone #6 options

Prior handoff's menu still applies, minus Option A (now done). Re-stating
with the cleanup in the rear-view mirror:

**Option B — §3 left drawer (file tree).** Currently the left pane
is a static empty-shell placeholder. Wire it to a configurable
working directory, list PDFs, click-to-open replaces `Cmd+O`. Opens
the door to multi-doc workflows. Spec §3 has the design — file tree,
quick-open (`Cmd+P`), per-doc state hints (already-has-drafts
indicator now that we know the sha256). Estimate: 1–2 days.

**Option C — §10.1 submit → agent handoff.** The "save" half of §10
is done (drafts persistence); the "submit to agent" half is not. This
is where the review work would actually flow to the LaTeX engine.
Significant scope — needs the engine-side contract worked out too.
Estimate: multi-day, blocks on spec gaps in §10.1.

**Option D — §9.2 embedded Claude pane.** node-pty + xterm.js per
§13.4. High UX impact but heavy lift. Estimate: 2–3 days for a usable v1.

**Option E — knock out remaining M4 P3s + new M5 nits.** rev-6nh
(standalone comments + click-to-anchor), rev-a1x (better persistence
error UI), rev-4qc (multi-page fixture + cross-page revealAnchor),
rev-4pr (backward-drag through bullets — PDF.js upstream). Smaller,
spec-edge polish. Estimate: half-day to a day.

**My recommendation:** Option B. The file picker (`Cmd+O` only, no
recent-files list, no tree) is starting to feel like a paper cut —
opening any second document means re-typing the path through a native
dialog. The left-drawer file tree unlocks the multi-doc rhythm the
spec assumes for §10.1 later. Option C blocks on spec gaps and Option D
is heavy for what it delivers right now.

## Files touched this session

- `desktop/shared/types.ts` — `ElectronAPI` gains `onDraftsFlushRequest`
  + `sendDraftsFlushAck`.
- `desktop/main/index.ts` — `attachDraftsFlushHandshake(win)` hooks
  per-window close; module-level `app.on('before-quit')` runs the
  parallel-flush-then-quit dance; `requestFlushAndAwait` helper with
  2s timeout.
- `desktop/preload/index.ts` — bridges the two new IPC channels with
  an unsubscribe-returning `on*` pattern.
- `desktop/renderer/index.ts` — `wireDraftsQuitFlush()` registers the
  flush-request listener + `beforeunload` fallback; `renderAllCards`
  buckets into sections + restores focus; `bindCommentStreamKeyboard`;
  `buildCardActions` per-card edit/delete buttons; `beginEditComment` /
  `cancelEdit` / `deleteComment` + `handleSubmit` edit-mode branch;
  `editingCommentId` + `focusedCommentId` module state.
- `desktop/renderer/styles.css` — section headers, focus-visible card
  ring, hover-revealed action buttons.
- This doc.
