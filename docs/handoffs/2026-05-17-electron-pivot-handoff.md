---
type: handoff
status: research-pending
created: 2026-05-17
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: pre-pivot consolidation
predecessors:
  - docs/handoffs/2026-05-17-first-run-cota-feedback.md
  - docs/handoffs/2026-05-17-first-run-cota-feedback-run-2.md
  - docs/handoffs/2026-05-17-post-v1-next-steps.md
---

# review-pdf-to-latex — Electron pivot handoff

This session pushed the v1 sidecar architecture as far as it can go. Real-PDF verification (python419/anthony, two runs) surfaced that the sidecar UX collapses under the obvious failure mode: a user opens the viewer, clicks buttons, and the clicks vanish because no `wait-event` consumer is attached. AJB called the direction at the end of the session: **the embedded terminal needs to drive the UX; we're going Electron**. This document captures what's already shipped, the open research that gates the rebuild, and where to resume.

## Status of the engine

All of today's engine work is on `main` (origin/main HEAD = `3aa8541`). 14 beads closed in this session. **Three new beads filed at end-of-session, not yet slung:**

| ID      | P  | Title                                                              |
|---------|----|--------------------------------------------------------------------|
| rev-3pm | P0 | viewer: button clicks silently no-op when no wait-event consumer is attached |
| rev-cav | P2 | engine/viewer: `--order surface-first` doesn't reorder viewer entry point |
| rev-2mq | P3 | extract: post-run summary counts don't match resulting state.json  |

**rev-3pm is the bead that triggered the pivot decision.** Read its description — it lays out the three fix shapes (auto-dispatch status-neutral actions server-side; surface "no consumer attached" warning; built-in lightweight consumer) and notes that the third path is the major architectural call. AJB picked something further: not "add a built-in consumer" but "the viewer IS the embedded Claude session." That's the Electron pivot.

### Beads closed today (for context, not action)

- rev-8ox (P0) — viewer `_render_frame` only passed two kwargs; full Jinja context now assembled
- rev-is6 (P1) — SURFACE trigger broadened from `claude surface this` to `surface this`; `.review-config.toml` override
- rev-fv6 (P1) — bbox text recovery via pdfplumber; first ship used `within_bbox` (broken on tight quads), re-fixed to `crop` with raw-orientation fallback
- rev-dyn (P1) — embedded xterm.js terminal pane + WebSocket + pty bridge; toggle drawer in topbar
- rev-mvd (P1) — `bootstrap_state` routes empty-`highlighted_text` non-trigger_match annotations to `surfaced_pending` at extract time
- rev-16m (P1) — `--project-dir` accepted before or after the subcommand; subcommand-level wins
- rev-ze1 (P2) — corrupt PDF surfaces human-readable error with re-save guidance instead of bare `AssertionError`
- rev-fpe (P3) — pdfannots `Missing text` warning deduplication via logging filter
- rev-9m5 (P2) — sticky-note → highlight spatial association (within 72pt, runner-up ratio ≥ 1.5)
- rev-bwi (P2) — `review-pdf bulk-surface` CLI promotes pending+trigger_match → surfaced_pending atomically
- rev-bus (P2) — `set-current` CLI + Prev/Next viewer buttons for status-neutral navigation
- rev-s1o (P2) — viewer counter + frame default to unresolved annotations; `?include=terminal` for full walks
- rev-hgj (P3) — `extract --quiet`/`--json`; status reformat to compact 4-line summary; pdfminer log noise silenced
- rev-ee2 (P3) — `~/.claude/skills/review-pdf-to-latex/SKILL.md` polish: corrupt-PDF guidance + venv install block + `--project-dir` clarification

Plus one upstream bug filed against `gt` itself: **hq-l19zn** (P1) — `gt sling` session-start race causes "deferred" polecat sessions to never boot. Today's recovery required hand-committing from 3 polecat worktrees.

## What python419/anthony's run-2 verified

Pulled from msg `hq-wisp-pp0lbh` and the second-run report at `docs/handoffs/2026-05-17-first-run-cota-feedback-run-2.md`. Key signals against the COTA RESTORED PDF:

- **needs_review: 9 → 1.** The 8 originally-empty-text annotations gained usable recovered text. The remaining 1 is `ann-013` (sticky note with no nearby highlight that fell outside rev-9m5's 72pt threshold).
- **Extract time: 3.87s → 1.88s** (~2× faster, rev-fpe dedup carrying its weight).
- **40/40 annotations terminal** at end of their manual Phase 2b walk (32 deferred + 8 surfaced_resolved). 8 .tex files modified; build passes; commit landed at `88de112` in their downstream repo.
- Dark theme readable; embedded terminal opens; `claude` runs in it (verified by AJB).
- `--order surface-first` is recorded in state.json but doesn't actually reorder the viewer entry point (filed as rev-cav).
- Extract summary line reports `8 surfaced_pending` but `status` reports `1` (filed as rev-2mq).

**The headline negative finding:** AJB clicked buttons in the viewer; nothing visibly happened. HTTP 204 returned, events landed in `state-events.jsonl`, but no consumer was attached so state.json never changed. From the user's perspective the viewer is broken when used standalone. This is the bead that drove the pivot (rev-3pm).

## The pivot decision

Locked in this session:

1. **Electron app.** Not HTML+localhost sidecar. The earlier argument for HTML was Gas Town/Gas City embedding, but if the viewer IS the app and not a sidecar in someone else's shell, that argument weakens enough that Electron's native menus / dock presence / native file dialogs / single-binary distribution matter more.
2. **Embedded Claude auto-starts on launch.** Opening the app spawns a `claude` pty pre-loaded with the skill against the chosen project. No "you must have Claude running in another window." The terminal is guaranteed present.
3. **Button semantics TBD.** Two possible builds: (a) buttons trigger conversation prompts in the embedded terminal (e.g., Approve → Claude says "ann-004 approved, advancing to ann-005, ready for next action"); (b) buttons remain silent state transitions and the embedded Claude is for SURFACE conversations + free-form input only. **Deferred to research.**

## Open research that gates the rebuild

These are the load-bearing decisions the next session needs to make before writing Electron code. None are urgent today — the engine works, python419 verified the workflow ships outcomes against real PDFs. The pivot is about UX, not capability.

### 1. Python engine bundling

- **Option A — pyinstaller.** Bundle the Python engine into a self-contained binary that ships inside the Electron app. Real distribution path; users don't need Python installed. Cost: pyinstaller toolchain, larger app, slower iteration.
- **Option B — PATH-discovery.** Assume `review-pdf` is on PATH; the Electron app shells out. Faster to prototype; only works for developers with the engine installed. Acceptable for v1-internal.
- **Option C — bundled Python wheel inside the app, invoked via subprocess.** Halfway. Avoids pyinstaller but ships a Python interpreter with the app.

Recommended starting point: **Option B for the first prototype**, **Option A for distribution**. But if the prototype is the only build we're doing for a while, A may be worth the up-front cost.

### 2. First-scope cut

- **Option A — minimal wrapper.** Electron shell with a single window, renderer loads the existing HTML viewer (now served by the Electron main process directly from disk instead of via the HTTP server, or kept as localhost for simplicity). Main process spawns `review-pdf serve` (or replaces it) and the Claude pty. ~3–5 days of work. We already proved the HTML viewer works; this is the smallest pivot.
- **Option B — ground-up renderer.** Throw away the Jinja templates; build a fresh React/Svelte/vanilla-JS renderer that natively integrates the Claude terminal as a load-bearing element. ~2–3 weeks. Cleaner long-term; expensive.

Recommended: **Option A**, with an explicit roadmap to refactor the renderer incrementally inside Electron later.

### 3. Repo strategy

- **Option A — same repo, `desktop/` subdirectory.** Python engine and Electron app live together; refactors stay coordinated.
- **Option B — new repo.** `review-pdf-to-latex-app` or similar; engine becomes a dependency.

Recommended: **Option A** for as long as the engine and the app are co-evolving. Split later when distribution starts mattering.

### 4. Layout

Three concrete sketches were drafted but not picked. Reproduced here so the next session can pick or extend:

#### Option L1 — three columns, terminal as third pane

```
┌─ Phase 2a · ann-004 of 8 unresolved ─────────────────────────────────────┐
├──────────────────┬───────────────────────┬──────────────────────────────┤
│ PDF page 4       │ enrollment_growth.tex │ Claude                       │
│                  │   47  The college...  │ > /review-pdf                │
│  [highlight ░░]  │   48  experienced a.. │ Phase 2a started.            │
│                  │   49  substantial...  │ ann-004: "tighten this"      │
│                  │ ──── proposed ──────  │ Proposed: COTA enrollment    │
│ ──────────────   │ COTA enrollment grew  │ grew 12% YoY.                │
│ Page 4 · @AJB    │ 12% YoY.              │ Approve / Reject?            │
│ "tighten this"   │                       │ _                            │
│                  │ [✓][✗][↻][👁][⤳][💬]  │                              │
│ [PDF][Build]     │                       │                              │
└──────────────────┴───────────────────────┴──────────────────────────────┘
```

Closest to current shape; preserves visual context; demotes "live PDF preview" to a tab in column 1.

#### Option L2 — terminal as bottom half

```
┌─ Phase 2a · ann-004 of 8 unresolved ─────────────────────────────────────┐
├──────────────┬───────────────────────┬───────────────────────────────────┤
│ PDF page 4   │ enrollment_growth.tex │ Build preview                     │
│              │   47  The college...  │                                   │
│ [highlight]  │   48  experienced...  │  ←-→ page 4                       │
│              │ Before │ Proposed     │                                   │
│              │ ───    │ COTA enroll  │                                   │
├──────────────┴───────────────────────┴───────────────────────────────────┤
│ [Approve] [Reject] [Redraft] [Preview] [Skip] [Surface]  [← Prev][Next →]│
├─────────────────────────────────────────────────────────────────────────┤
│ Claude                                                                  │
│ > /review-pdf                                                           │
│ Phase 2a started. ann-004: "tighten this paragraph"                    │
│ Proposed: COTA enrollment grew 12% YoY. Approve / Reject? _            │
└─────────────────────────────────────────────────────────────────────────┘
```

Visual content on top, conversation always-visible on bottom. Buttons live at the seam.

#### Option L3 — IDE-style with left activity rail

```
┌─ Phase 2a · ann-004 of 8 unresolved ─────────────────────────────────────┐
├────┬──────────────┬──────────────────────┬───────────────────────────────┤
│ 📋 │ Annotations  │ enrollment_growth.tex│ Claude                        │
│ 🔍 │ ──────────── │   47  The college... │ > /review-pdf                 │
│ 📐 │ ✓ ann-001    │   48  experienced..  │ Phase 2a started.             │
│ 🗂 │ ✓ ann-002    │   49  substantial..  │ ann-004: "tighten this"       │
│ ⚙  │ ✗ ann-003    │ ──── proposed ────── │ Proposed: COTA enrollment     │
│    │ ▶ ann-004    │ COTA enrollment grew │ grew 12% YoY.                 │
│    │   ann-005    │ 12% YoY.             │ Approve / Reject?             │
│    │ 💬 ann-006   │                      │ _                             │
│    │   ann-007    │ [✓][✗][↻][👁][⤳][💬] │                               │
└────┴──────────────┴──────────────────────┴───────────────────────────────┘
```

Annotation list color-coded by status in a left sidebar; main work area in the middle; Claude on the right. Closest to a VS Code feel.

**Layout is the visual call the next session should make once the build scope is locked.** Mockups above are ASCII; ship to Figma or hand-draw for color/typography decisions.

### 5. Gas Town / Gas City integration under the new model

The earlier "HTML composes; Electron doesn't" argument assumed Gas Town would embed our viewer as an iframe / webview. Under the new model, the Electron app is a sibling to Gas Town, not embedded inside it. Gas Town can still orchestrate via the bd/mail layer and OS-level process spawn. **Open question:** does Gas City want to embed review-pdf-to-latex's UI somewhere (e.g., a remote browser session), and if so, what's the bridge? Probably defer until Gas City exists.

### 6. Spec §10 needs a rewrite

The current spec at `docs/specs/2026-05-16-review-pdf-to-latex-design.md` §10.2 ("the author does not type in the viewer") is now obsolete. §10.5 ("Click→engine path") describes the sidecar consumer model that this pivot abandons. Update the spec early in the next session so the pivot is recorded, not implicit.

## Resumption steps for the next session

1. Read this handoff in full.
2. Read python419/anthony's second-run report at `docs/handoffs/2026-05-17-first-run-cota-feedback-run-2.md` for the empirical grounding of the pivot.
3. Read rev-3pm's description (`bd show rev-3pm`) — the bead that triggered the pivot decision.
4. Pick the three load-bearing decisions from §"Open research":
   - Python engine bundling (recommended: Option B for prototype)
   - First-scope cut (recommended: Option A minimal wrapper)
   - Repo strategy (recommended: same repo `desktop/`)
5. Pick the layout (L1, L2, L3, or sketch a fourth).
6. Update the spec doc to record the pivot.
7. Start building.

## What NOT to do in the next session

- Do not unwind any of today's 13 closed beads. The engine work stands. The pivot is about UX, not capability.
- Do not delete the existing HTML viewer. It still works; it becomes the renderer for the minimal-wrapper Electron build, or migration scaffolding if a ground-up rebuild is chosen.
- Do not file new beads for the issues already filed (rev-3pm, rev-cav, rev-2mq) — they pre-date the pivot decision and will be re-scoped or closed-as-superseded depending on which Electron path is picked.
- Do not start with Electron without first picking the three decisions above and the layout. Mocking the wrong thing first burns a week.

## State on disk

- `origin/main` head: `3aa8541 chore(beads): close rev-ee2 (skill polish)`
- Local working tree: clean except for this handoff being created, plus the usual untracked `docs/handoffs/2026-05-17-first-run-cota-feedback.md` (python419's first report) and `.runtime/`, `state.json` (Gas Town worker scratch — gitignored).
- python419/anthony's preserved `.review-state/` is at `~/gt/python419/crew/anthony/reports/cota-impact/` — their Phase 2b session captured 8 surface_chat_log audit trails at `/tmp/cota-review-state-backup-20260517-183253/`.
- Inbox: 8 messages, 0 unread. Most recent: `hq-wisp-pp0lbh` from python419/anthony (verification report).

## Open external dependencies / tools to evaluate

For the Electron build, the next session will need to evaluate:

- **Electron vs Tauri vs Wails.** Tauri is dramatically smaller (Rust + system webview) and could justify revisiting "we picked Electron." But Tauri is single-binary distribution territory and may complicate the embedded Python engine. Lock the choice up front.
- **Terminal library inside Electron.** xterm.js works (rev-dyn shipped it). The pty bridge moves from a custom WebSocket impl to Electron IPC (node-pty in the main process, xterm.js in the renderer, IPC between them).
- **Process spawning for `claude`.** Same node-pty; nothing exotic.
- **Auto-update.** If we ship to AJB and python419, auto-update mechanics need a story. Squirrel.Mac, electron-updater, or "you re-download and reinstall" for v1-internal.

---

This handoff is paste-into-fresh-session ready. The next session can start from a cold context and pick up at "Resumption steps" above.
