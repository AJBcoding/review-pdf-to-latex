# review-pdf-to-latex

Walk PDF annotations into LaTeX source edits, paragraph by paragraph, with live rebuilt-PDF preview. Engine is a Python CLI; the playbook is a Claude Code skill that drives the engine through a four-phase workflow.

## What this is

A two-artifact tool. The **engine** is a Python package exposing a `review-pdf` CLI; it knows nothing about Claude. The **skill** (a markdown file at `~/.claude/skills/review-pdf-to-latex/SKILL.md`) teaches Claude Code how to drive the engine through Phase 0 (extract), Phase 1 (batch pre-apply), Phase 2a (ratify), Phase 2b (surface conversation), and Phase 3 (final commit). All state lives in `.review-state/` at the LaTeX project root; the engine is the sole writer. The reviewer-facing UI is the `review-pdf` Electron app under [`desktop/`](desktop/) (see the `/review` skill); the engine and the app meet only through `.review-state/` files.

## When you want this

- You have an annotated PDF (highlights + comments) produced by an external reviewer.
- The PDF was rendered from a LaTeX source tree you own.
- You work in Claude Code and want a structured walkthrough rather than a batch-apply + cold re-read.
- You want a clean git audit trail of which annotations you accepted, rejected, redrafted, or deferred.

If your source is DOCX, Markdown, or HTML: this tool is not for you (LaTeX-only, by design — see spec §17).

## Install

```bash
# Engine (this repo):
pip install -e .[dev]

# Skill (one-time, installs the playbook for Claude Code):
mkdir -p ~/.claude/skills/review-pdf-to-latex
cp docs/skill-reference/SKILL.md ~/.claude/skills/review-pdf-to-latex/SKILL.md
# OR write your own SKILL.md from the spec at docs/specs/.

# Verify:
review-pdf status --help
```

System dependencies (must be on `PATH`): `pdftoppm` (Poppler), `pdflatex` and `xelatex` (TeX Live), `git`.

## Quickstart

```bash
# Phase 0: extract annotations + render pages + build initial mapping
review-pdf extract \
  --pdf ~/Downloads/annotated.pdf \
  --project-dir ~/projects/my-latex-paper/

# If there are needs_review mappings, resolve each one from the CLI:
review-pdf override-mapping --project-dir ~/projects/my-latex-paper/ \
  --annotation-id <id> --file <path.tex> --lines <start>:<end>

# Now hand the wheel to Claude Code. In a Claude Code session in the project:
#   /review-pdf-to-latex
# The skill walks Phase 1 (batch pre-apply), drives Phase 2a ratification,
# handles Phase 2b conversations, and finalizes with Phase 3.
```

Phase 2a ratification happens in the `review-pdf` Electron app (under [`desktop/`](desktop/)), which renders three panes: source PDF page (with highlight overlay), source LaTeX (with the proposed edit), and the live rebuilt PDF (with a pagination indicator: "no shift" vs. "shift at p.N"). Actions: Approve, Reject, Redraft, Preview, Skip, Surface.

## CLI reference

| Subcommand | One-liner |
|---|---|
| `extract` | Read the PDF, fuzzy-map every annotation to a LaTeX line range, render page PNGs, write initial state. |
| `apply` | Replace a mapped line range in a `.tex` file; capture `before_text` on first apply. |
| `revert` | Restore `before_text`; optionally records `failure_log_path` for Phase-1 compile failures. |
| `preview` | Speculative compile: in-place edit, build, restore. Produces a transient build PDF for the viewer. |
| `build` | Run `pdflatex` or `xelatex` twice, copy PDF to `.review-state/builds/`, append build record with per-page MD5 + pagination diff. |
| `status` | Counts per status, current phase, last build outcome, unresolved `needs_review`. |
| `override-mapping` | Manual mapping override for `needs_review` annotations. |
| `set-status` | Single mutator for status transitions that don't touch `.tex` files (Approve, Skip, Surface, terminal markers). |
| `append-chat` | Append one chat turn to a SURFACE annotation's `surface_chat_log`. |
| `record-proposal` | Stage `proposed_text` without mutating `.tex` (for replay / dry-run). |
| `commit-phase` | The sole mutator of `state.json.phase`; runs `git commit` with the structured message. |
| `wait-event` | Block on `state-events.jsonl`; print the next event or exit 20 on timeout. The skill's bash idiom. |
| `migrate-state` | Schema migration (stub in v1). |

Full per-command signatures, flags, and exit codes: [`docs/specs/2026-05-16-review-pdf-to-latex-design.md`](docs/specs/2026-05-16-review-pdf-to-latex-design.md), §8.

## Architecture

Sidecar pattern: a stateless `review-pdf` CLI plus the `review-pdf` Electron app, both driven from outside by Claude Code. The app never calls Claude; Claude never embeds the review UI. They meet at four files in `.review-state/`: `annotations.json` (immutable), `mapping.json` (editable via CLI), `state.json` (engine-owned), and `state-events.jsonl` (UI-appended). See spec §5 for the full diagram and layer-responsibility table.

## Status

Pre-1.0; v1 acceptance criteria are listed in spec §18 and target the COTA Impact Report v2.0 review cycle as the first real run. See `CHANGELOG.md` for per-release details.

## License

MIT. The engine is intended for cross-project reuse and collaborator portability. The skill is personal/internal but follows the same license.
