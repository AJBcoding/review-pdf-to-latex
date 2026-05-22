---
type: handoff
status: B1 + B2 diagnostics shipped (commit 9e24833); both bugs still open pending verification walk; bd-state landmine in this checkout (mayor's hq-gheez)
created: 2026-05-22
audience: AJB resuming the M7 dev-server verification walk, or the next agent picking up where the 2026-05-21 handoff left off
predecessors:
  - docs/handoffs/2026-05-21-m7-shipped-dev-server-verification-in-flight-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§9.2.3 priming, §10.4 bundle/drafts)
related-bd:
  - rev-gkl (B2 — priming invisible at first spawn — still open)
  - rev-a2f (B1 — comments don't restore on doc reopen — still open)
  - hq-gheez (bd workspace uninitialized — mayor's territory)
---

# B1 + B2 diagnostics shipped (Phase B / critical-path)

## What's done as of this handoff

Critical path from the 2026-05-21 handoff was:
```
A1 (reload) → A2 (walk steps 7-11) → B1 (comments-restore) → B2 (priming visibility) → A3 (real round end-to-end)
```

A1/A2/A3 need a human at the keyboard. This session worked B1 + B2 solo.

### B2 (rev-gkl) — priming-delay bump + console.log diagnostic

`desktop/main/claude-pty.ts:256` — bumped the slash-command priming `setTimeout` from 500ms to 1500ms, and added a `console.log` immediately before the `p.write('/review-pdf-to-latex\r')` call.

**Hypothesis** (in the code comment): claude-code 2.1.146 prints a banner and clears the screen during boot. At 500ms the priming write lands during that clear, so the `/review-pdf-to-latex` line gets erased from visible scrollback even though the skill itself activates (the rest of the conversation behaves as if it primed). 1500ms lands after the boot render completes on a modern Mac.

**Fallback if the line is still missing at 1500ms**: write a visible marker to xterm directly from the renderer (decoupled from the pty's stdin), shape suggested in the code comment. Not implemented this session — the simpler timing-bump should be tried first because the cost is one line of code and a `console.log` will confirm whether the priming actually fires.

### B1 (rev-a2f) — diagnostic only

`desktop/renderer/index.ts:loadDraftsForCurrentDoc` (around line 1150) — added a `console.log` covering `path`, `sha256` prefix, `reason` (`ok` vs `not_found`), and `commentCount` on every drafts load. No behavior change.

**Analysis**: the bundle writer (rev-1md.1) produces a new PDF with annotations baked in (pdf-lib spike rev-cvr) — and that new PDF has a different sha256 from the source. Drafts are keyed on the loaded PDF's sha256 (`<dir>/.review-state/drafts/<sha256>.json`). If AJB reopened the *bundle* PDF rather than the *source* PDF, the drafts lookup misses → `comments = []` → empty right-drawer. PDF-side highlights "come back" because they're embedded in the bundle PDF as native pdf-lib annotations.

If on the next verification walk the `[drafts] load` log shows `reason: not_found` on a doc that should have drafts, the bundle-vs-source hypothesis is confirmed and the fix shape becomes a UX call:

- **Cross-bundle lookup**: when drafts file isn't found, scan sibling `.bundle.json` files for one whose `rendered_pdf.sha256` matches; load the source's drafts via `source.sha256` from that JSON.
- **Educational banner**: detect bundle PDFs on open (via filename grammar or sibling JSON), surface a banner offering to switch to the source.

If the log shows `reason: ok` and a non-zero `commentCount` but the UI is still empty, the bug is in `renderAllCards` or the render path — different fix shape, file under "regression introduced by rev-1md.2 pane refactor."

## Open follow-ups (not addressed this session)

**P2 from yesterday's handoff — still open after this session:**
- rev-gkl (B2) — priming visibility: shipped a defensive fix + diagnostic, awaiting verification.
- rev-a2f (B1) — comments restore: shipped a diagnostic only, awaiting verification → fix shape.

**P3 polish cluster from yesterday's handoff** — still untouched:
- rev-5mw / rev-g96 / rev-3dw §9.2 polish trio (theme / doc-switch quiet / Reviewer rig-entry mechanism)
- Diag strip auto-hide, Ralph-loop button placement, Cmd+P palette scope counter, tree refresh, Settings UI for `--dangerously-skip-permissions`
- rev-khz / rev-u6j §9.2 spike follow-ups

**Phase D pre-M7 backlog** — still untouched:
- rev-cav engine `--order surface-first` doesn't reorder viewer entry
- rev-axy `test_extract.py` missing `pdfannots` dependency

## bd-state landmine in this checkout

This session hit a destructive bd-hook interaction. Capturing it here so the next agent doesn't repeat the same back-and-forth.

**State observed:**
- `.beads/embeddeddolt/rev/` exists but contains only an empty `.lock` file — the dolt db is gone.
- `bd ready` / `bd show` etc. all error with "no beads database found".
- BUT — `bd hooks run pre-commit` runs successfully and exports "0 issues" to `.beads/issues.jsonl`, *destroying* the on-disk 73-issue export.
- A background bd process (transient, fires every ~20s, name `(beads)` in `ps`) also re-wipes `issues.jsonl` whenever you write it.

**Consequence**: any normal `git commit` that runs the pre-commit hook will silently auto-stage a 73-line deletion of `.beads/issues.jsonl`. The previous session's commit `a7db36c` avoided this (docs-only, somehow); subsequent commits won't.

**Workaround** (used this session): `git commit -o <paths>` scopes the commit to only the listed pathspecs, ignoring other staged changes. The pre-commit hook still runs and still destroys issues.jsonl on disk, but the deletion doesn't make it into the commit. Example:

```bash
git commit -o desktop/main/claude-pty.ts desktop/renderer/index.ts -m "..."
```

Do not try `git checkout HEAD -- .beads/issues.jsonl` to restore — the post-checkout hook will re-trigger the deletion. Do not bypass with `--no-verify` (the project rule forbids it, and the underlying state issue needs mayor's fix anyway).

**Long-term fix**: mayor is on it via hq-gheez. Their dolt restore will repopulate `.beads/embeddeddolt/rev/` and the hooks will stop destroying issues.jsonl.

## Where the dev-server verification picks up

The 2026-05-21 critical path resumes at A1:

1. **Cmd+Q the Electron window AND kill any old `npm run dev` process**. The B2 fix is a main-process change — Cmd+R alone won't pick it up. Restart with `cd desktop && npm run dev` from the project root.
2. **Open the dev-tools console** so the new logs are visible:
   - `[claude-pty] firing slash-command priming /review-pdf-to-latex (rev-gkl diagnostic)` — confirms the priming fires (timestamp tells you when relative to spawn).
   - `[drafts] load { path, sha256, reason, commentCount }` — fires on every PDF open including the AppState-restore reopen.
3. **B2 verification**: open a PDF for the first time, watch the Claude pane. Does the `/review-pdf-to-latex` line now appear in scrollback? If yes → ship and close rev-gkl. If no → the visibility issue isn't a timing race; pivot to the renderer-visible-marker fix described in the code comment.
4. **B1 verification**: open a PDF, make 2-3 highlight+comment cards (note the file path you opened — source or bundle?), Cmd+Q, relaunch. Watch the `[drafts] load` log on reopen. Three branches:
   - `reason: ok, commentCount > 0` and UI empty → render-path regression; investigate `renderAllCards`.
   - `reason: not_found` → bundle-sha256 hypothesis confirmed; pick the fix shape (cross-bundle lookup or banner).
   - `reason: ok, commentCount: 0` → drafts file is empty; check whether the write debounce flushed before quit. Could indicate a regression in `flushDraftsWrite` on close.
5. **A2 walk** (steps 7-11 from yesterday): toolbar buttons, Cmd+Return Submit, concurrent-round lock, quit + relaunch.
6. **A3**: end-to-end round on a real PDF.

## Reference

- This session's commit: `9e24833`
- Previous handoff: `docs/handoffs/2026-05-21-m7-shipped-dev-server-verification-in-flight-handoff.md`
- Mail thread: `hq-wisp-3pu` (self-addressed status mail with the same content abbreviated)
- Spec: `docs/specs/2026-05-19-electron-app-ux-spec.md` (§9.2.3 for priming, §10.4 for bundle/drafts coupling)
