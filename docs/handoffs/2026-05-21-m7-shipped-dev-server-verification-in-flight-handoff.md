---
type: handoff
status: M7 epic shipped (commit 077a432) + dev-server verification round in flight; 7 polish fixes landed; 3 verification bugs still open
created: 2026-05-21
audience: next agent (or AJB resuming the dev-server verification walk)
predecessors:
  - docs/handoffs/2026-05-21-m7-design-review-and-partial-implementation-handoff.md
  - docs/handoffs/2026-05-20-milestone-7-scoped-implementation-ready.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§5.1, §8.5, §9.2.3, §9.2.5, §10.1, §10.4, §10.5.3, §11.3 patched in the M7 design pass)
---

# M7 shipped + dev-server verification in flight

## What's done as of this handoff

### M7 epic — all 6 implementation children + 2 spikes + skill split

Closed at commit `077a432` (rev-1md epic close). Children:

| Bead | Title | Commit | Polecat |
|---|---|---|---|
| rev-1md.1 | Bundle writer + Cmd+S + Saved indicator | `1f6b353` | rust |
| rev-1md.2 | §9.2 embedded Claude pane (xterm.js + node-pty + Reviewer rig) | `66babfe` | nitro |
| rev-1md.3 | §9.2.6 + §9.2.7 toolbar (Create Context / Sling / Fresh Start + Ralph-loop iteration controller + β progress strip + γ tasks panel) | `a139414` | nitro |
| rev-1md.4 | §10.1 Submit flow (sling to rig + standalone picker + origin tracking) | `ef0a7b0` | rust |
| rev-1md.5 | Results-file watcher + status reflection | `ee2c888` | nitro |
| rev-amx | /review rig-side launcher (replaces rev-1md.6 half) | `6074d53` | rust |
| rev-ek3 | /review-pdf process round-based processor + engine reviewer-rig guard | `9ed1caf` | nitro |
| rev-cvr | spike: pdf-lib annotation API + coord transform | `5870475` | chrome |
| rev-a1u | spike: node-pty + xterm + claude/gt probes | (merged via review) | nitro |

Combined typecheck passes. Dolt-lock contention recovered cleanly mid-wave (mayor's hold-and-resume strategy worked).

### Dev-server verification round — fixes landed in flight

AJB started a manual walkthrough; got stuck at the §9.2 pane area due to layout sizing. Fixes shipped since:

| Commit | What | Trigger |
|---|---|---|
| `829cbc1` | Right-drawer 360→440px + 1:1 split with min-height 320px on Claude pane + diag strip relocated to bottom-left low-opacity | "the bottom right pane needs to be larger" |
| `d1cfff3` | Collapsible left drawer — ◀/▶ chevron + Cmd+\ + persisted state | "collapse the left pane to recapture that real estate" |
| `1c4e831` | Draggable pane dividers (3 gutters: left col, right col, rd-row split) + AppStateFile.layout_widths persistence | "draggable columns and right pane divider don't seem to be reconfigurable" |
| `eafa469` | Tree search 🔎 (Cmd+F) + fit-to-width ↔ buttons | "fit-to-width icon" + "magnifying glass for search" |
| `4036db2` | Claude pane defaults to `--dangerously-skip-permissions` (opt-out via AppStateFile.claude_dangerous_skip_permissions) | "are we opening with dangerously skip — we should and this should be an option" → user: "dangerously - should be the default" |
| `416fa3f` | Enter-hang fix: worker pty multi-line priming via xterm bracketed-paste mode | "the prompt context...enter or return after we send the command - on the first round they were hanging there" |

## Open bugs / follow-ups still on the table

Filed during verification, not yet addressed:

**P2 (real bugs):**
- `rev-...` (filed mid-session): **right-drawer comments don't restore on doc reopen** even though PDF highlights do. Reproduction: open PDF, make comments, quit, reopen — highlights come back but cards in right drawer are empty. Investigation hint: `loadDraftsForCurrentDoc` may bail on sha256 mismatch (e.g., user opened the rev-1md.1-written bundle PDF rather than the original source PDF — different sha256, no drafts file under that hash). Path: `desktop/renderer/index.ts` → `loadDraftsForCurrentDoc`.
- `rev-...` (filed mid-session): **§9.2.3 slash-command priming not visible in Claude pane scrollback at first spawn.** AJB couldn't see the `/review-pdf-to-latex` line that should appear after spawn. Either fires before xterm DOM mounts (race), or fires but invisible. Worth a 50–100ms delay or a console.log near the priming write to confirm.

**P3 (polish, deferred):**
- `rev-...` Diag strip auto-hide after boot
- `rev-...` Ralph-loop modal: +/- buttons clipped by highlight container
- `rev-...` Cmd+P palette: visible scope counter + path-prefix filter ("feels like it's pulling system-wide")
- `rev-...` Manual file-tree refresh button (precursor to rev-s0b live fs watching)
- `rev-...` Settings panel UI for the dangerously-skip-permissions toggle
- `rev-5mw` / `rev-g96` / `rev-3dw` §9.2 polish trio (theme / doc-switch quiet / Reviewer rig-entry mechanism) — polecat-filed
- `rev-khz` / `rev-u6j` §9.2 spike follow-ups — capture gt version + node-pty Windows CI

## Where the dev-server verification stopped

AJB was at **step 7+** of the walkthrough — toolbar / §9.2 pane interactions. With the sizing fixes (1c4e831) and the Enter-hang fix (416fa3f), the path forward is:

1. Cmd+R in the Electron window to pick up the TS changes (the dev server itself is still running from earlier in the session)
2. Continue from step 7 of the walkthrough in the previous chat:
   - Click the 3 toolbar buttons (✨ Create Context / 🪃 Sling / 🌅 Fresh Start) — verify modals open + submitted multi-line prompts produce one user turn (not N)
   - Watch the β progress strip + γ tasks panel
3. Step 8: Cmd+Return Submit flow
4. Step 9: concurrent-round lock
5. Step 11: quit + relaunch persistence test
6. Investigate the 2 P2 bugs above

## Things to know about the running environment

- Dev server `npm run dev` was started by the previous agent in this session, output logged to `/private/tmp/claude-501/.../bu6amhu14.output`. If the Electron window has been closed, restart with `cd desktop && npm run dev`.
- Error monitor was armed against the dev-server output and will surface runtime errors via task notifications.
- `npm install` was run mid-session to pick up node-pty + xterm + pdf-lib that the polecats added to package.json without committing the lockfile install. If the typecheck regresses on a fresh clone, re-run `npm install`.
- The polecat infrastructure has been quiet for the last few hours but functional — mayor's `gt mail send` reachable, dolt locks released. Slinging more work would work; we just don't need to (no fresh impl bds queued).

## Next steps

Ordered by priority, with effort estimate + suggested route (in-session / sling-to-polecat).

### Phase A — finish the dev-server verification walkthrough (mine, this session or next)

**A1. Cmd+R the Electron window** so the post-eafa469 commits (`1c4e831`, `eafa469`, `4036db2`, `416fa3f`) take effect.
- The dev server is still running; just reload.
- If the window's been closed, `cd desktop && npm run dev` from the project root.

**A2. Walk the rest of the verification checklist** (steps 7–11):
- Step 7: ✨ Create Context / 🪃 Sling / 🌅 Fresh Start modals + Ralph-loop iteration controller + β progress strip + γ tasks panel
- Step 8: Cmd+Return Submit flow — confirm picker appears (no --from at launch), verify state-machine banners
- Step 9: concurrent-round lock — fake a `.review-state/results-*.json` with `round_status: in_progress`, confirm Submit is hard-disabled + resume banner appears
- Step 10 (optional): end-to-end via `/review` skill in a separate gt session
- Step 11: Cmd+Q + relaunch — confirm state restore (root, expanded dirs, comments, layout widths, collapse state, dangerously-skip-perms toggle)

**A3. End-to-end Submit on a real round:**
- Pick a small test PDF, make 2–3 comments at L1/L2/L3, Cmd+S to write the bundle, Cmd+Return to sling
- If running from a gt crew session via `/review`, the rig should receive the mail + invoke `/review-pdf process`
- If standalone-via-Reviewer, the local Reviewer pty handles L3 conversationally and L1/L2 get marked `needs-followup`
- Verify results-file watcher (rev-1md.5) reflects the rig's terminal statuses back into the right-drawer cards

### Phase B — fix the 2 P2 bugs (mine, ~1-2 hours each)

**B1. Comments-don't-restore-on-reopen** (filed mid-session).
- Reproduce: open a PDF, make a card, observe `.review-state/drafts/<sha256>.json` exists with comments. Close PDF (or quit + relaunch). Reopen the same PDF. Check whether `loadDraftsForCurrentDoc` fires, whether it returns the right sha256-keyed file, whether `renderAllCards()` runs.
- Suspect: the user may have opened the v1.1 revision file rather than v1.0 (different sha256), or rev-1md.2's pane refactor accidentally short-circuited the drafts load.
- File: `desktop/renderer/index.ts` → search `loadDraftsForCurrentDoc`.

**B2. §9.2.3 slash-command priming invisible at first spawn.**
- The `setTimeout(() => p.write('/review-pdf-to-latex\r'), 500)` in `claude-pty.ts:255` runs 500ms after spawn — but xterm may not have its DOM mounted yet when the data event arrives, so the priming line scrolls off-screen before render.
- Fix candidate: bump the delay to 1000ms, OR have the renderer signal main when xterm is ready, OR write to a buffer the renderer flushes on mount.

### Phase C — outstanding P3 polish (slingable to polecats)

These are slingable, mostly small. Could be done in one parallel batch:
- `rev-5mw` Claude pane theme follow toggle (dark/light)
- `rev-g96` Doc-switch line shouldn't trigger Claude response
- `rev-3dw` Exact rig-entry mechanism for Reviewer pty
- `rev-khz` Capture gt version + warn on skew
- Diag strip auto-hide-after-boot
- Ralph-loop modal +/- button placement
- Cmd+P palette scope counter + path-prefix filter
- Manual file-tree refresh button (low-cost precursor to rev-s0b)
- Settings panel UI (gear icon → toggle for `--dangerously-skip-permissions`)

Suggested sling order: do the §9.2 trio together (rev-5mw + rev-g96 + rev-3dw) since they all touch the Claude pane.

### Phase D — pre-M7 backlog (P2 engine bugs, optional)

- `rev-cav` engine/viewer `--order surface-first` doesn't reorder viewer entry point
- `rev-axy` test_extract.py missing pdfannots dependency

Pre-existing, slingable to a polecat any time.

### Phase E — v2 work (deferred)

- `rev-6nr` Strikethrough + standalone comment kinds (PDF tools + bundle annotations). Driver: when AJB hits a "delete this paragraph" or "comment with no specific anchor" need.
- `rev-8iw` Multi-user bundle author + same-day collision detection. Driver: when a second user (python419) starts using the app.
- `rev-y0r` Remove legacy 4-phase engine subcommands (post-M7 cleanup).

### Critical-path summary

The shortest path to "M7 fully verified, ready to call done":

```
A1 (reload) → A2 (walk steps 7-11) → B1 (comments-restore) → B2 (priming visibility) → A3 (real round end-to-end)
```

After that, M7 is verified. Phase C work is independent.

If you only have an hour, do A1 + A2. If you have a half-day, add B1 + B2. If you have a full day, finish through A3 and start Phase C.

## Reference

- Spec: `docs/specs/2026-05-19-electron-app-ux-spec.md` (1098 lines after M7 patches)
- Previous handoff: `docs/handoffs/2026-05-21-m7-design-review-and-partial-implementation-handoff.md`
- Spike artifacts: `desktop/spikes/rev-cvr-pdf-lib/spike.mjs` + `docs/research/2026-05-21-pdf-lib-annotation-spike/README.md`
- The full conversation that produced this handoff includes detailed decision rationale in bd notes — every closed precursor (rev-pya, rev-1s5, rev-mpe, rev-ni4, rev-2k7) has a paste-ready memo as a note on the closed bead. Run `bd show <id>` to read.

## Mail thread with mayor

Three replies sat in the inbox by close of session; all acknowledged. Mayor owns the 3 gastown infra bds (hq-3wreu, hq-rhy33, hq-5ntrd) end-to-end — out of scope for the rig.
