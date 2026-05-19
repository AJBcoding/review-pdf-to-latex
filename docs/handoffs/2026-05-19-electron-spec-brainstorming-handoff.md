---
type: handoff
status: spec-resolved, awaiting AJB review + pre-build picks
created: 2026-05-19
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: post-brainstorming consolidation
predecessors:
  - docs/handoffs/2026-05-17-electron-pivot-handoff.md
  - docs/handoffs/2026-05-18-ux-research-and-bug-screenshots-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (resolved spec, commit 30e32b4)
---

# review-pdf-to-latex — Electron spec brainstorming handoff

This session ran `/superpowers:brainstorming` against the dictated electron-app UX spec to surface and resolve underspecified areas. Spec went from ~261 to ~430 lines; 17 decisions landed across §3–§11 + §15. Six items from §13 carried over from the pivot handoff remain open — those are the pre-build picks for the next session.

## What got resolved (commit 30e32b4)

Full ledger is in the spec itself; one-line summaries:

1. **Agent boundary (§10.1, §10.3)** — embedded Claude pty owns batch redrafts. File + pty injection: app writes `.review-state/submit-<ts>.json`, injects `/review-pdf process <path>` into the running Claude session.
2. **Results round-trip (§8.5, §10.3)** — agent writes `.review-state/results-<ts>.json` with per-comment `status: applied | deferred | needs-followup | rejected` + optional `new_anchor`.
3. **Pre-submission drafts (§10.3)** — `.review-state/drafts/<doc-version>.json`, debounced 250ms writes; `.gitignore`d by default but visible.
4. **Comment lifecycle (§8.5)** — `open → submitted → terminal`. Deferred + needs-followup items seed next-version draft with `derived_from` chain back to the v1.0 origin.
5. **Buffer-until-Enter (§4.3)** — no half-typed persisted state; input buffer is in-memory until Enter.
6. **MD inline syntax (§6.3)** — HTML comments `<!-- agent-note id=<uuid> L<1|2|3>: ... -->`; `id=` links inline anchor to draft JSON.
7. **MD save-as (§6.4)** — same versioning as PDF (`notes.md → notes-v1.1.md`); original sacred.
8. **Engagement levels (§11.1–.3)** — tool == level (coupled); mutable pre-submit via clickable chip; agent honors user's level (returns `needs-followup` if it disagrees, never reclassifies).
9. **Live-redraft display (§9.3)** — comment carries the answer (`redraft_suggestion` field + "Accept as redraft" button); Claude pane carries the thinking.
10. **File tree (§3.1–.5)** — single-root Obsidian style; show all + dim unsupported; hide `.git/`/`node_modules/`/dotfiles; `Cmd+P` quick-open palette.
11. **Launch + external handoff (§3.3, §3.4)** — remember root + last doc + tree state; CLI shim `review-pdf-app open <path>` + URL scheme `reviewpdf://open?path=...`; single-instance enforced via `requestSingleInstanceLock` + `second-instance`.
12. **Keyboard surface (§15)** — `Cmd+P`, `Cmd+S`, `Cmd+1/2/3`, `j/k`, `Cmd+\`, `Cmd+J`, etc.
13. **Filter chips (§9.1)** — multi-axis (kind / status / level).
14. **Data model additions (§8)** — `doc_version`, `redraft_suggestion`, `status`, `submitted_at`, `derived_from`.
15. **§13.7, §13.8 marked RESOLVED**; §13.12 added (search inside doc/across comments deferred to v2).

## What's still open (pre-build picks)

From §13.1–§13.4 of the spec — carried from the pivot handoff and **not** resolved this session. These are the next session's pre-build work:

1. **Python engine bundling (§13.1).** pyinstaller / PATH-discovery / bundled wheel. Spec recommendation: PATH-discovery for prototype, pyinstaller for distribution.
2. **First-scope cut (§13.2).** Minimal wrapper vs. ground-up renderer. Spec leans strongly toward ground-up — the existing Jinja viewer doesn't fit the file-tree + comment-stream + Claude-pane layout. Worth confirming explicitly.
3. **Repo strategy (§13.3).** Same repo (`desktop/` subdir) vs. new repo. Spec recommendation: same repo until distribution starts.
4. **Electron vs Tauri vs Wails (§13.4).** Tauri is smaller (Rust + system webview) but complicates Python engine embedding. Lock the choice up front.

Plus three spike items:

5. **§13.6 — Dark mode for PDF + Word.** Feasibility spike — render to canvas with color matrix invert? PDF.js plugin?
6. **§13.10/.11 — PDF highlight → underlying-text capture.** Single-page PDF.js prototype validating §5.2 against corrupted/multi-column/rotated PDFs. Load-bearing for the whole spec.

And one tidy:

7. **§13.5 — Rewrite obsolete §10** of `docs/specs/2026-05-16-review-pdf-to-latex-design.md` to remove sidecar UX text that contradicts the new spec.

## Resumption steps

1. **Read the spec** at `docs/specs/2026-05-19-electron-app-ux-spec.md`. Start with §1, then §3, §8.5, §10 (those are the structural pieces; §11/§15 are detail).
2. **AJB final review** — anything in §3–§11 or §15 wrong, missing, or worth pushing back on. The agent should ask before changing anything in the resolved sections.
3. **Make the four pre-build picks** (§13.1–§13.4). Each has a recommendation in the spec; confirm or revise.
4. **File bd issues** for the spikes (§13.6, §13.10/.11) and the §13.5 tidy. Pre-pivot ready bugs (rev-3pm, rev-cav, rev-2mq) should be re-scoped or closed-as-superseded once the rebuild direction is locked. Note: upstream `f1f1086` landed `fix(viewer): auto-dispatch navigate + surface no-consumer state (rev-3pm)` between sessions — `rev-3pm` may already be addressed in the sidecar context; verify before closing.
5. **Start the spike work** or do a visual mockup (Figma / hand-drawn UI from §2 ASCII).

## State on disk

- `origin/main` head: `30e32b4 docs(spec): resolve 17 underspecified areas in electron-app-ux-spec`
- This session's commits: one (the spec rewrite). A second commit lands this handoff doc.
- Pre-existing working-tree dirty state from session start (`.beads/*` + modified `docs/specs/2026-05-16-review-pdf-to-latex-design.md`) is **untouched** — same as it was at session start. Not this session's to clean up; mentioned for context only.
- No bd issues filed or closed this session.
- Inbox: two old handoffs (2026-05-18, 2026-05-17), 0 unread.

## What NOT to do in the next session

- Do not re-open the 17 resolved decisions unless AJB pushes back on a specific one. They're committed to the spec; downstream work assumes them.
- Do not start Electron code before §13.1–§13.4 are picked. Mocking the wrong tech stack first burns a week (same warning as the pivot handoff).
- Do not delete or modify pre-existing `.beads/*` dirty state without understanding what it represents — it's not from this session.

---

This handoff is paste-into-fresh-session ready. The next session can start from cold context and pick up at "Resumption steps."
