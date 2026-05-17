# Handoff — Brainstorm Complete → Write Spec

**Date:** 2026-05-16
**From:** Claude (Opus 4.7) brainstorming session with Anthony Byrnes
**To:** Next Claude Code agent started in this repo
**Status:** Design approved by user. Spec not yet written. This handoff IS the spec brief.

---

## Your job

You are starting a fresh Claude Code session in `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/`. Read this handoff plus the session doc (`docs/sessions/2026-05-16-initial-brainstorm-session.md`) and the SuperDoc research (`docs/research/2026-05-16-superdoc-fit-analysis.md`). Then:

1. Write the formal design spec at `docs/specs/2026-05-16-review-pdf-to-latex-design.md`.
2. Use the brainstorm skill's self-review checklist (placeholders / contradictions / scope / ambiguity).
3. Hand it back to Anthony for review.
4. After approval, invoke `superpowers:writing-plans` for the implementation plan.

The spec should be a comprehensive formal design memo (~400-700 lines of markdown), not a re-statement of this handoff. This handoff is *organized notes for you*; the spec is the *authoritative reference document* for implementers, reviewers, and future-you.

---

## 1. Problem statement

Anthony needs to walk every paragraph of an annotated PDF (the COTA Impact Report v2.0, 80 comments) one at a time, in context with the marked-up PDF page, and approve/edit/reject changes individually — instead of either (a) batch-applying 47 edits and re-reading 10 pages cold, or (b) ping-ponging in chat where state is lost.

Most annotations are mechanical (apply the suggested edit). A subset (~10) are flagged `SURFACE` and require focused conversation. Pagination matters: a change that lengthens a paragraph can shift page breaks downstream, and the reviewer must be able to see this.

This same workflow recurs every revision cycle and applies to other LaTeX reports Anthony authors. The tool should generalize, even though the first use case is concrete.

## 2. Goals and non-goals

### Goals
- Walk PDF annotations one-by-one with the corresponding LaTeX source visible.
- Live rebuilt-PDF preview that updates after every approval/rejection.
- Explicit surfacing of pagination drift (page-count changes; per-page diffs).
- State persistence — pause and resume across sessions, compaction-safe.
- Audit trail — git commits per approval batch.
- Generalize: same workflow for any LaTeX project + annotated PDF.

### Non-goals (explicit cuts — keep these as cuts in the spec)
- **No multi-user or collaboration features.** Single-user, local-only.
- **No in-browser LaTeX editor.** Claude does ALL LaTeX editing via the Edit tool. The browser is read-only display + button clicks.
- **No DOCX or HTML or Markdown source support.** LaTeX-only for v1.
- **No Anthropic SDK in the tool itself.** Claude Code IS the AI integration; the tool has no API key handling.
- **No auth, no hosted deployment, no database.** Files on disk.
- **No "perfect" annotation→LaTeX mapping.** Fuzzy match + explicit manual-override bucket for the cases where fuzzy fails (tables, captions, figure labels).
- **No support for non-Anthony users in v1.** The README mentions collaborator portability as a design intent for the engine layer, but no UX accommodation for it now.

## 3. First concrete use case

| Item | Path |
|---|---|
| Annotated PDF (input) | `/Users/anthonybyrnes/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` (205 KB) |
| LaTeX project root | `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/` |
| LaTeX templates | `<root>/templates/*.tex` (11 files: preamble, front_matter, headline_numbers, enrollment_growth, equity_findings, student_success, what_needs_work, advising_investment, strategic_priorities, closing, appendix) |
| Main build file | `<root>/build/full_report.tex` |
| Helper fragment | `<root>/build/fragments/cotastat-defs.tex` |
| Pre-comment PDF (for reference) | `/Users/anthonybyrnes/gt/python419/crew/anthony/2026-05-15 - impact report distribution/2026-05-15-COTA-Impact-Report-v1.9.pdf` |
| Tool repo | `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/` (this repo) |
| Skill home | `/Users/anthonybyrnes/.claude/skills/review-pdf-to-latex/SKILL.md` |

**Annotation volume:** 80 total. User estimated breakdown: ~70 mechanical, ~10 `SURFACE`. Confirm by running `pdfannots` on the source PDF as the first step of implementation.

**Note:** the LaTeX lives in a Gas Town polecat (a working-copy worktree of the Python419 academic repo). Don't hard-code the polecat path — accept it as a CLI argument or config value.

## 4. Architecture — sidecar pattern

Two artifacts, one workflow:

### The engine (this repo)
A Python package that knows nothing about Claude. Provides primitives via a CLI:

- `review-pdf extract --pdf PATH --latex-dir PATH` — extract annotations + fuzzy-map to LaTeX + render PDF pages to PNG.
- `review-pdf serve --project-dir PATH` — start the local HTTP viewer (port chosen, URL printed).
- `review-pdf apply --annotation-id ID --new-text PATH` — apply an edit to LaTeX with reverse-line-order safety + line-shift tracking.
- `review-pdf revert --annotation-id ID` — revert a previously applied edit.
- `review-pdf build --project-dir PATH` — run pdflatex; produce a new PDF + pagination diff against the prior build.
- `review-pdf status --project-dir PATH` — show counts (pending/applied/accepted/rejected/surfaced).

A collaborator without Claude Code could script against these CLI commands and accomplish the same workflow manually. That portability is the reason for the engine/skill split.

### The skill (in `~/.claude/skills/review-pdf-to-latex/`)
A SKILL.md that teaches Claude Code:
- The 4-phase workflow (sequence + conditions).
- What HTML to push for each annotation type (mechanical vs. surface).
- How to handle compile failures in Phase 1 (revert, mark `needs_review`, continue).
- How to apply edits in reverse line order to avoid line-number drift.
- How to commit a batch after a chunk of approvals.

The skill is the playbook; the engine is the toolbox. Neither has hard knowledge of the other beyond the JSON state file format + CLI surface.

## 5. Repository layout

```
PycharmProjects/review-pdf-to-latex/
├── src/review_pdf_to_latex/
│     ├── __init__.py
│     ├── cli.py              ← entry point; routes subcommands
│     ├── extract.py          ← PDF annotations + fuzzy mapping + page render
│     ├── server.py           ← HTTP server (fork of brainstorm visual-companion server)
│     ├── apply.py            ← apply/revert .tex edits with line tracking
│     ├── build.py            ← pdflatex orchestration + pagination diff
│     ├── state.py            ← JSON state read/write
│     └── templates/
│           ├── frame.html              ← page chrome (CSS, helper JS)
│           └── annotation.html         ← per-annotation render template
├── tests/                    ← pytest; integration tests against a sample PDF
├── pyproject.toml            ← deps: pdfannots, jinja2; [project.scripts] review-pdf
├── README.md
├── LICENSE                   ← MIT
└── docs/
    ├── specs/                ← formal design specs
    ├── handoffs/             ← session-to-session context transfer
    ├── sessions/             ← chronological session records
    └── research/             ← deep-dives, analyses, decisions documented in depth
```

## 6. Data model — three JSON files

All three live in a project-local `.review-state/` directory (gitignored), keyed by the absolute path of the LaTeX project root.

### `annotations.json` — immutable, written once by `extract`

```json
{
  "schema_version": 1,
  "source_pdf": "/abs/path/to/source.pdf",
  "extracted_at": "2026-05-16T20:30:00Z",
  "annotations": [
    {
      "id": "ann-001",
      "page": 4,
      "bbox": [72.0, 510.5, 540.0, 542.5],
      "highlighted_text": "The college experienced a substantial increase...",
      "author": "reviewer-name-or-anonymous",
      "comment": "Tighten this — too academic",
      "created": "2026-05-15T14:22:11Z",
      "trigger_match": false
    }
  ]
}
```

`trigger_match` is `true` if the comment text matches the SURFACE trigger phrase (default: `"Claude surface this"` — case-insensitive, exact substring; configurable per project).

### `mapping.json` — editable; written by `extract`, human/Claude can override

```json
{
  "schema_version": 1,
  "mappings": {
    "ann-001": {
      "latex_file": "templates/enrollment_growth.tex",
      "line_range": [47, 52],
      "confidence": 0.92,
      "method": "fuzzy_text",
      "needs_review": false
    },
    "ann-013": {
      "latex_file": null,
      "line_range": null,
      "confidence": 0.0,
      "method": "failed",
      "needs_review": true,
      "candidates": [
        {"file": "templates/equity_findings.tex", "line_range": [22, 28], "score": 0.34},
        {"file": "templates/student_success.tex", "line_range": [88, 91], "score": 0.31}
      ]
    }
  }
}
```

When `needs_review: true`, the viewer surfaces the annotation in a "needs human mapping" bucket before Phase 1 can run. Tables and figure captions are likely candidates.

### `state.json` — mutable, the working state

```json
{
  "schema_version": 1,
  "phase": "2a-ratify",
  "order": "mechanical-first",
  "annotations": {
    "ann-001": {
      "status": "applied",
      "before_text": "The college experienced a substantial increase...",
      "proposed_text": "COTA enrollment grew 12% YoY...",
      "applied_text": "COTA enrollment grew 12% YoY...",
      "applied_at": "2026-05-16T20:45:12Z",
      "last_build_id": "build-007",
      "surface_chat_log": null
    },
    "ann-013": {
      "status": "surfaced_pending",
      "before_text": null,
      "proposed_text": null,
      "applied_text": null,
      "surface_chat_log": [
        {"role": "user", "text": "...", "ts": "..."},
        {"role": "claude", "text": "...", "ts": "..."}
      ]
    }
  },
  "builds": [
    {"id": "build-007", "pdf_path": "...", "page_count": 24, "compiled_at": "...", "log_path": "..."}
  ]
}
```

## 7. Workflow phases

### Phase 0 — Setup (`review-pdf extract`)
One-shot CLI. Produces `annotations.json`, `mapping.json`, `pages/page-N.png`. Fuzzy-maps each annotation to a LaTeX file + line range. Flags low-confidence mappings as `needs_review`. Renders all PDF pages to PNG (cached; lazy regenerate ok).

### Phase 1 — Batch pre-apply (Claude, driven by the skill)
For each annotation tagged mechanical:
- Claude reads the LaTeX snippet (lines from `mapping.json`).
- Claude drafts a proposed edit based on the comment.
- Claude applies the edit to the .tex file (Edit tool).
- Validates by running `review-pdf build`. If compile fails: revert this edit, mark `needs_review`, continue.
- Edits applied in reverse line order across the whole batch to avoid line-number drift.
- Result: ~70 mechanical edits pre-applied; ~10 SURFACE items still pending; one validated compile.

### Phase 2a — Ratify (sidecar)
User walks each mechanical edit in the browser. Per item: 3-pane layout (PDF page · LaTeX snippet + proposed + buttons · live preview + pagination indicator).
- **Approve:** mark reviewed; no rebuild needed (edit already applied).
- **Reject:** revert this edit (`review-pdf revert`); async rebuild updates preview.
- **Redraft:** Claude proposes new text; apply; async rebuild.
- **Preview:** speculative rebuild of a hypothetical (used with Reject/Redraft before committing).
- **Skip:** defer for later (status `deferred`).
- **Surface:** promote to Phase 2b for conversation.

### Phase 2b — Surface (sidecar + terminal chat)
For each `surfaced_pending` annotation:
- Sidecar shows the context (PDF page + highlight + current LaTeX + comment).
- Conversation happens in the Claude Code terminal (the existing chat surface).
- Claude proposes an edit → applies → rebuilds → user Accepts or iterates.
- Chat log persisted to `state.json` for audit.

### Phase 2 order toggle
Default: mechanical-first (2a → 2b) — knock out the easy work, focus on hard items at the end.
Alternative: surface-first (2b → 2a) — resolve risky items first to avoid cascade-rework when mechanicals later touch the same paragraphs.
User-selectable at `serve` start time or via a UI toggle.

### Phase 3 — Final commit
- Final pdflatex run.
- Git commit of all approved edits (one commit per session, or batched commits per phase — TBD in spec).
- Optional: produce a "diff PDF" highlighting what changed vs. v2.0.

## 8. Viewer UI

3-pane layout per annotation:

```
┌─ Annotation N of M · Page P · @author: "comment text" ─────────┐
├──────────┬─────────────────────┬───────────────────────────────┤
│ Source   │ Source LaTeX        │ Live PDF preview              │
│ PDF page │ (highlighted lines, │ (current rebuilt state,       │
│ with     │  read-only)         │  auto-scrolls to page P)      │
│ highlight│                     │                               │
│ overlay  │ Proposed edit       │ Pagination check:             │
│          │ (read-only)         │ "24 → 24 pages, no shift" or  │
│          │                     │ "24 → 25 pages, shift at p.12"│
│          │ [Preview] [Approve] │                               │
│          │ [Reject] [Redraft]  │                               │
│          │ [Skip] [Surface]    │                               │
└──────────┴─────────────────────┴───────────────────────────────┘
```

Server is a fork of the brainstorming visual-companion server pattern (already proven; see `Python419/.superpowers/brainstorm/.../` and the `superpowers:brainstorming/visual-companion.md` reference). HTML files written to a screen dir; clicks captured to a state events file.

No framework. Vanilla HTML + minimal JS. Optional `diff2html` for the snippet diff. PDF pages displayed as `<img src="pages/page-N.png">`.

## 9. Compile + pagination strategy

**Strategy B + per-item Preview button.**

- The preview pane shows the CURRENT compiled state (last successful build with all applied edits in place).
- After every approval/rejection/redraft, a background `review-pdf build` runs and updates the preview when complete.
- Per-item **Preview** button does a speculative rebuild with a proposed-but-not-applied change, then shows that result. The user can then commit (Approve) or back out.
- **Pagination detection:** after each build, compare new PDF page count + per-page MD5 against the previous build. Surface as a small indicator under the preview pane. If page count shifts, highlight which page boundary moved.
- Expected compile time: 1-3s for the COTA report (small PDF, text-heavy). Spec should benchmark on first compile and adjust strategy if compile time exceeds ~5s (e.g., add a "rebuild now" button instead of automatic).

## 10. Error handling

### Fuzzy mapping failures
- Confidence < 0.5: flag as `needs_review`, show top 3 candidate file/line ranges.
- Tables and captions are the most common failure mode (rendered text doesn't match source 1:1 due to LaTeX commands).
- UI in Phase 2a surfaces these BEFORE Phase 1 runs, allowing manual override.

### Compile failures in Phase 1
- Each edit is validated with a `review-pdf build` before moving to the next.
- On failure: `git restore` the .tex file (or use the in-memory before-text to revert), mark annotation as `needs_review`, continue with the next.
- User sees these in Phase 2a as "Claude tried this edit but it broke the build — please revise."

### Compile failures in Phase 2a/2b (user-induced)
- Redraft or manual revert that breaks the build: show the pdflatex error inline; don't commit.
- User can iterate until the build is green again.

### Edit conflicts (overlapping line ranges)
- Phase 1 applies edits in reverse line order (highest line numbers first) so earlier line numbers stay valid.
- If two annotations target overlapping ranges, the second one's mapping needs re-computation post-first-edit.
- Spec should define: do we just flag this and require sequential review, or do we attempt automatic re-mapping?

## 11. Risk callouts

| Risk | Severity | Mitigation |
|---|---|---|
| Fuzzy mapping fails on tables / figure captions | Medium | `needs_review` bucket + manual override UI before Phase 1 |
| Pre-applied edit breaks LaTeX build | Medium | Per-edit validation in Phase 1; failing edits reverted + flagged |
| Edit conflicts (overlapping line ranges) | Low | Reverse-line-order application; spec must define re-mapping policy |
| Context compaction during long Claude Code session | Low | All state in `state.json`; Claude rehydrates from disk on every turn |
| Token cost across 80 walking iterations | Medium | Pre-cache mechanical proposals in `state.json` during Phase 1; Phase 2a is cheap reads, no live drafting |
| pdflatex compile time exceeds expectations | Low | Spec should benchmark on first compile; degrade to manual rebuild button if > 5s |
| LaTeX project layout differs from COTA template (figures dir, biber/biblatex, custom classes) | Medium | Engine must accept arbitrary project root + main file; don't hard-code COTA structure |
| Phase 1 modifying tracked files outside a git checkpoint | High | Engine must verify clean git state before Phase 1 begins; abort if dirty |

## 12. Open questions for the spec author to resolve

1. **Phase 1 invocation surface:** Should Phase 1 run inside the Claude Code session (visible, interruptible) or as a separate CLI command (`review-pdf pre-apply`)? Brainstorm-default lean: CLI, with a `--dry-run` that prints planned edits without applying. The spec should commit to one.

2. **Git commit granularity:** One commit per session, one per phase, or one per approval batch (e.g., every 10 approvals)? Audit-trail value vs. log noise.

3. **The `SURFACE` trigger phrase:** Should it be regex, exact substring, or a small DSL like `@claude: surface`? Default in brainstorm was substring match on `"Claude surface this"` — confirm or revise.

4. **Re-mapping policy on edit conflicts:** flag-and-require-sequential, or auto-recompute mapping after each prior edit applies?

5. **Build dir layout:** the COTA project compiles from `build/full_report.tex` which `\input{}`s into `templates/`. Will all LaTeX projects we generalize to follow this build/templates split? Or do we need to discover the main file?

6. **State directory location:** `.review-state/` alongside the LaTeX project root, or a centralized `~/.review-pdf-to-latex/sessions/`? Project-local is more discoverable; centralized survives polecat moves.

## 13. Next steps (in order)

1. **You (the next agent) write the spec** at `docs/specs/2026-05-16-review-pdf-to-latex-design.md`. Use this handoff as the source material, not the format — the spec should be a proper design memo with formal sections, not a notes dump.
2. **Self-review** with the brainstorming skill's checklist (placeholders / contradictions / scope / ambiguity).
3. **User review** — hand to Anthony for read-through.
4. **Implementation plan** — invoke `superpowers:writing-plans` once spec is approved.
5. **Execution** — `superpowers:executing-plans` or `superpowers:subagent-driven-development` depending on scope.

## 14. Dependencies inventory (already verified)

| Dependency | Status | Notes |
|---|---|---|
| Annotated PDF | ✓ exists | `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` (205 KB) |
| `pdftoppm` | ✓ available | Poppler 26.02, at `/opt/homebrew/bin/pdftoppm` |
| `pdflatex` | ✓ available | TeX Live 2025, at `/Library/TeX/texbin/pdflatex` |
| `xelatex` | ✓ available | TeX Live 2025 (use if COTA requires it; check `\documentclass` line) |
| `pdfannots` (Python) | ✗ install needed | `pip install pdfannots` — primary annotation extractor |
| `PyMuPDF` (Python) | ✗ install needed | Alternative; pick one (recommend pdfannots for MVP) |
| `latexmk` | ✗ not installed | Optional; spec can call pdflatex directly |
| Jinja2 (Python) | ? unknown | For HTML templates; minor dep |

## 15. Cross-references

- Session doc: `docs/sessions/2026-05-16-initial-brainstorm-session.md`
- SuperDoc research: `docs/research/2026-05-16-superdoc-fit-analysis.md`
- Visual mockups (still on disk): `~/PycharmProjects/Python419/.superpowers/brainstorm/94006-1778985671/content/{workflow-primary,layout-3pane-with-preview,refined-workflow-phases}.html`
- Brainstorming skill reference: `~/.claude-accounts/anthony/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/`
- Visual companion server (the pattern to fork): same path, `scripts/start-server.sh` and `scripts/frame-template.html`
