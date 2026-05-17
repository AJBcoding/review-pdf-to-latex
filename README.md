# review-pdf-to-latex

Walk PDF annotations through their LaTeX source edits, paragraph by paragraph, with live rebuilt-PDF preview. Sidecar-style: a thin local viewer driven by Claude Code in the main terminal.

**Status:** Pre-implementation. Design brainstorming complete (2026-05-16). Next step: a new Claude Code agent (started in this repo) reads the handoff and writes the formal spec in `docs/specs/`, then the implementation plan.

## Start here

- [`docs/handoffs/2026-05-16-brainstorm-complete-handoff.md`](docs/handoffs/2026-05-16-brainstorm-complete-handoff.md) — **the spec brief**: every decision, constraint, and path needed to write the formal spec.
- [`docs/sessions/2026-05-16-initial-brainstorm-session.md`](docs/sessions/2026-05-16-initial-brainstorm-session.md) — chronological record of the brainstorming session that produced the handoff.
- [`docs/research/2026-05-16-superdoc-fit-analysis.md`](docs/research/2026-05-16-superdoc-fit-analysis.md) — why we did NOT build on SuperDoc (DOCX-only, wrong fit for PDF+LaTeX).

## First concrete use case

COTA Impact Report v2.0 review cycle — 80 PDF annotations from `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` to be walked into LaTeX source at `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/`. The tool is designed so this same workflow generalizes to any LaTeX project + annotated PDF.

## Shape of the thing

Two artifacts, one workflow:

```
This repo (Python package):       ~/.claude/skills/review-pdf-to-latex/:
  the engine                        the playbook
  ─────────────────                 ─────────────────
  extract.py    PDF → JSON          SKILL.md — teaches Claude the
  server.py     HTTP viewer                    4-phase workflow,
  apply.py      .tex mutations                 what HTML to push,
  build.py      pdflatex runner                how to recover from
  state.py      JSON state I/O                 compile failures
  CLI: review-pdf {extract,
       serve, apply, build}
```

The engine knows nothing about Claude. The skill knows nothing about pdfannots or pdflatex. They meet at the JSON state file and the CLI.

## License

TBD. Engine likely MIT (intended for cross-project reuse and collaborator portability); skill is personal/internal.
