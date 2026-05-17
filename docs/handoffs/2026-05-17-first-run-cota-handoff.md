# Handoff — First Real Run on COTA Impact Report v2.0

**Date:** 2026-05-17
**From:** Implementation session (review-pdf-to-latex tool, just shipped)
**To:** Fresh Claude Code agent invoked in `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/`
**Purpose:** Validate v1 of the tool against the production use case it was designed for. Capture friction.

---

## Paste this into a fresh Claude Code session in the cota-impact repo

```text
You are running in /Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/. This is the LaTeX source for the COTA Impact Report. There is an annotated PDF at /Users/anthonybyrnes/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf (205 KB, 80 annotations) that needs to be walked into the LaTeX templates.

A tool exists for exactly this workflow: `review-pdf` (engine at ~/PycharmProjects/review-pdf-to-latex) + a Claude Code skill that drives it through four phases. This is the FIRST real run; your job is to use it AND report what breaks.

1. Invoke the skill. Type `/review-pdf-to-latex` (or invoke via the Skill tool with name `review-pdf-to-latex`). It is installed at ~/.claude/skills/review-pdf-to-latex/SKILL.md and teaches the 4-phase workflow (extract → batch pre-apply → ratify/surface → final commit).

2. Verify the engine is installed: `review-pdf --help` should print the usage banner with 14 subcommands. If it fails, the engine is at ~/PycharmProjects/review-pdf-to-latex and needs `pip install -e .` from there into a venv with Python 3.11+.

3. Confirm the source PDF and project root with me before Phase 0. Expect:
   - PDF: `/Users/anthonybyrnes/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf`
   - Project root: `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/` (current working dir)
   - Main file: likely `build/full_report.tex` (the engine auto-discovers; override with `--main-file` if needed)
   - LaTeX engine: auto-detected from `\documentclass`

4. Run Phase 0 (extract). Expected output: ~80 annotations in `.review-state/annotations.json`, mappings in `.review-state/mapping.json`, ~24 PDF pages rendered to `.review-state/pages/`, plus an initial state.json at `phase: 0-setup`. If many annotations land in `needs_review` (tables, captions are the common failure mode), follow the skill's manual-mapping step.

5. Run Phase 1 (batch pre-apply). The skill loops `pending` annotations in reverse line order per file, calling `apply` then `build` for each. ~70 mechanical edits expected; ~10 SURFACE-trigger annotations (comments containing "Claude surface this", case-insensitive) should land in `surfaced_pending` for Phase 2b.

6. Phase 2a (ratify) + Phase 2b (surface) per the skill.

7. Phase 3 (final commit).

Throughout: keep a running list of friction. The tool's spec is at ~/PycharmProjects/review-pdf-to-latex/docs/specs/2026-05-16-review-pdf-to-latex-design.md and the implementation plan at docs/plans/2026-05-16-review-pdf-to-latex-implementation.md. The 8-test e2e suite passed against synthetic fixtures; this run is what catches design-level issues the synthetics couldn't.

Specifically watch for:
- pdfannots extraction shape mismatches (annotation fields, comment authors)
- Fuzzy mapping accuracy on tables, captions, figure environments
- Pagination drift surprises (which page boundaries actually move when text edits land)
- Compile time per build (spec budgeted 1–3s; if it's 10s+, the auto-rebuild strategy needs revisiting per spec §11.3)
- Browser-server-skill loop ergonomics (the wait-event blocking call, the click→engine path, state.json polling)
- Any case where the skill tells you to do something but the engine refuses (illegal status transition, source-PDF guard failure, mapping unresolved)
- Any case where you wish a CLI flag existed and didn't

At the end of the run (or when you hit a blocker), write a friction report to ~/PycharmProjects/review-pdf-to-latex/docs/handoffs/2026-05-17-first-run-cota-feedback.md covering:
- What worked
- What broke (with stack traces, log excerpts, exact commands)
- What you wished was different (UX, CLI, skill prompt wording)
- Quantitative observations (mapping confidence histogram, build time avg, pages with pagination drift)

The tool's author is in the next room. You may be interrupted to clarify the workflow mid-run; preserve `.review-state/` so resumption works.

Begin by invoking the skill and confirming the paths with me before running any state-mutating command.
```

---

## Notes for the author (not for the agent)

- **The agent will be operating on a real, valued LaTeX project.** The engine respects git: `commit-phase` runs `git add` + `git commit`. Phase-1 build failures revert in place. There are no destructive operations without git history capturing them. Still, before Phase 0, the agent should verify the working tree is clean (the engine asserts this only for the initial commit boundary; Pass-3 of planning relaxed it for later phases).
- **Mid-flight clarification is allowed.** The first run is partly a UX shakedown. If the skill's prompt wording is unclear (e.g., "the user picks an action — which actions?"), revise the SKILL.md and re-invoke.
- **Token budget consideration.** Phase 1 with 70 mechanical proposals will consume meaningful context. The skill instructs streaming proposals to disk via temp files (not holding all 70 in working memory). Watch the context counter; if it crowds 50%, the skill should pause and let compaction happen — state.json + state-events.jsonl are the resumption substrate.
- **The friction report goes back here** in `~/PycharmProjects/review-pdf-to-latex/docs/handoffs/` so it informs v1.1.
