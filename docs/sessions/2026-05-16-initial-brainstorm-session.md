# Session — Initial Brainstorm

**Date:** 2026-05-16
**Participants:** Anthony Byrnes + Claude (Opus 4.7, 1M context)
**Mode:** `superpowers:brainstorming` skill with visual companion
**Outcome:** Design approved; spec to be written by next agent in this repo

---

## What happened

A scoping conversation that started as a generic "personal document review tool with three workflows" and converged on a concrete sidecar architecture for one specific recurring workflow: walking PDF annotations into LaTeX source edits with live preview.

## Sequence of conversation

1. **Original brief.** User presented an ambitious build prompt for a 3-workflow document review tool (PDF + trigger comments / HTML slide deck with pin annotations / in-app prose editing). Tech stack initially proposed: Next.js + Plate + Anthropic SDK + PyMuPDF sidecar. Asked Claude to use the brainstorm skill before building.

2. **Visual companion enabled.** Claude pushed a 3-up workflow comparison (W1/W2/W3 wireframes) to a browser viewer at `http://localhost:51598`. User picked **W1 (PDF + trigger comments)** as the primary use case.

3. **Concrete use case surfaced.** User reframed the problem from generic to specific: walking the 80 annotations on `2026-05-15-COTA-Impact-Report-v2.0comment.pdf` paragraph-by-paragraph into the LaTeX templates that produced it. Pain point: existing options (apply-all-and-re-read vs. chat-by-chat) both fail — one loses oversight, the other loses state.

4. **Scope reduction.** "Generic 3-workflow platform" was replaced with "specific PDF-annotations-to-LaTeX walker." Estimated build: 1-2 sessions (the user's estimate; Claude's revised estimate is closer to 12-16 hours given fuzzy mapping complexity).

5. **Reuse factor question.** User picked the high-reuse answer ("Frequent + cross-doc + maybe collaborators"). Justified building well enough to generalize, but not over-engineering for collaborators yet.

6. **Deployment model.** Local-only, single-user picked. Halves the build (no auth, no DB, no hosting).

7. **Architecture pivot — sidecar pattern.** User proposed: instead of a full Flask app with its own chat and AI integration, build a thin local viewer (clone of the brainstorming visual companion pattern) and let Claude Code in the main window drive everything. This collapses the AI integration, chat UI, and most orchestration into the existing Claude session. Probably 60-70% less code than the original plan.

8. **SuperDoc explored and rejected.** User asked if SuperDoc could be a foundation. Researched (see `docs/research/2026-05-16-superdoc-fit-analysis.md`). Verdict: no — SuperDoc is DOCX-only, our problem is PDF + LaTeX. No fit.

9. **Live preview requirement.** User added a critical constraint: must show how the fix renders, and pagination/page breaks matter. This made strategy B (async rebuild after every approval) + per-item Preview button the right design. The ~205KB PDF size suggests 1-3s compile times, which feels live.

10. **Refined workflow.** User restructured the in-tool flow into phases: Claude pre-applies all mechanical edits in batch (Phase 1), then user walks the ratification (Phase 2a) and surface conversations (Phase 2b) in the sidecar, with order configurable. This turns 80 decisions into ~70 quick ratifications + ~10 substantive conversations.

11. **Packaging.** User picked "both: skill + standalone repo." Engine is a Python package (this repo, MIT-licensed for collaborator portability); skill is a thin SKILL.md in `~/.claude/skills/review-pdf-to-latex/` that teaches Claude how to drive the engine.

12. **Paths confirmed.** LaTeX project root: `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/` (a Gas Town polecat workspace). Tool home: `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/`.

13. **Design summary approved.** Claude presented a compact design summary covering goals, non-goals, repo layout, data model, workflow phases, viewer UI, compile strategy, risks. User approved without changes.

14. **Repo created.** This repo initialized at `main`. User redirected: don't write the spec here — write the supporting docs (research, handoff, session) and let the next agent in this repo write the formal spec from those.

## Key decisions captured

- **Architecture:** Sidecar pattern — Claude in main terminal drives; engine is a thin viewer + state manager.
- **Repository split:** Standalone Python package (engine) + Claude Code skill (playbook). They meet at JSON state files and CLI commands.
- **Workflow:** 4 phases (Setup, Batch pre-apply, Review/Surface, Final commit) with order toggle.
- **Compile strategy:** Strategy B (async rebuild after every approval/rejection) + per-item Preview button.
- **State:** Three JSON files (`annotations.json` immutable, `mapping.json` editable, `state.json` mutable).
- **First use case:** COTA Impact Report v2.0 review cycle, but designed to generalize.
- **Out of scope for v1:** multi-user / collaboration, hosted deployment, non-LaTeX source formats, in-browser LaTeX editing, Anthropic SDK integration inside the tool.

## Visual artifacts produced during the session

Live during the session (still on disk in the originating polecat):

- `Python419/.superpowers/brainstorm/94006-1778985671/content/workflow-primary.html` — 3-up workflow comparison (W1/W2/W3)
- `.../layout-3pane-with-preview.html` — 3-pane viewer layout with live preview pane
- `.../refined-workflow-phases.html` — phase model (0/1/2a/2b/3) with order toggle

These can be copied into `docs/research/mockups/` if useful to the next agent; not copied by default.

## What the next agent will do

1. Read this session doc + the handoff + the SuperDoc research.
2. Write the formal spec in `docs/specs/2026-05-16-review-pdf-to-latex-design.md`.
3. Run the brainstorm skill's spec self-review on it.
4. Hand the spec back to Anthony for review.
5. After spec approval, invoke `superpowers:writing-plans` to draft the implementation plan.
