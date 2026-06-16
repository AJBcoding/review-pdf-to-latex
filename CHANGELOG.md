# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- PDF round-trip READ half (rev-l3): the desktop viewer now displays a PDF's native markup annotations (Highlight/StrikeOut/Underline/Squiggly/Text). `page.getAnnotations()` is consumed inside the existing `renderPage`, normalized into the discriminated anchor union + `native-pdf` provenance, and rendered through the existing comment-card stream + reveal — not a second pdf.js annotation DOM. Annotations are a read-projection of the source (re-derived per open, deduped by `comment_id`, never written to the working-state drafts sidecar). The bundle writer skips `native-pdf` origins so native rows round-trip through the JSON sidecar instead of being re-stamped as duplicate annotations on the next bundle write (§3.2 provenance).
- HTML/DOCX comments now anchor on the unified `text-quote` model over the iframe's extracted linear text (the truth), resolved by the same `fuzzyMatchAnchor` core the Markdown viewer uses. Selections are captured as `text-quote`, highlights paint across the multiple text nodes a range spans, and reveal scrolls the resolved range into view. The legacy `html-selector-hint` kind is kept as a locality hint so migrated v1 comments keep displaying (spec §5.5, rev-l6).
- Engine scaffolding (`src/review_pdf_to_latex/`) with the 13-subcommand `review-pdf` CLI.
- `extract` subcommand: pdfannots + rapidfuzz fuzzy mapping + pdftoppm page rendering.
- `apply` / `revert` / `set-status` / `append-chat` / `record-proposal` / `override-mapping` mutators with atomic `state.json` writes.
- `build` subcommand: pdflatex/xelatex orchestration + pagination diff.
- `preview` subcommand: speculative compile with in-memory snapshot/restore.
- `wait-event` subcommand: inotify/kqueue + stat-poll fallback on `state-events.jsonl`.
- `commit-phase` subcommand: sole mutator of `state.json.phase`; structured commit messages per spec §13.2.
- `status` subcommand: counts and current state, with `--json` for machine consumption.
- `migrate-state` subcommand: schema migration stub.
- Claude Code skill at `~/.claude/skills/review-pdf-to-latex/SKILL.md`: four-phase playbook driving the engine via CLI.
- Test suite: unit tests per module, end-to-end fixture against a synthetic annotated PDF + minimal LaTeX project.

### Fixed
- `bootstrap_state` now initializes annotations with empty `highlighted_text` and `trigger_match=false` directly to `surfaced_pending`, routing them past Phase 1 (which has nothing to anchor on without a source text run) into Phase 2b's SURFACE conversation loop (rev-mvd).
- `wait-event --since` no longer drops events that share a wall-clock second: event timestamps now carry microsecond precision (`…:11.123456Z`), so the `ts > since` cursor distinguishes events appended within the same second instead of silently skipping the second one (rev-l7).
- `wait_for_events` is now genuinely side-effect-free for a missing events file: the kqueue watcher watches the parent directory rather than `touch()`-ing the events file into existence to obtain a watch fd (rev-l7).

### Changed
- Extracted the format-agnostic event bus (`_validate_event`, `_append_event_line`, `wait_for_events`, `handle_wait_event` and helpers) out of `server.py` into a new viewer-free `events.py` (rev-l7).

### Removed
- Legacy HTTP viewer and its terminal bridge, per owner decision OD-2 (rev-l8): deleted `server.py` (the `ReviewHandler` viewer half — frame/page/build/static serving), `terminal.py` (RFC-6455 + pty WebSocket bridge), the `templates/` package (`frame.html`, `annotation.html`, vendored xterm.js/css), and their tests. Removed the `serve` subcommand and its `--mapping-mode` UI. The flock-disciplined event bus survives in `events.py` (the headless/scripted-driver + embedding path); the reviewer-facing UI is now the `review-pdf` Electron app under `desktop/`. Rationale: the viewer's auto-reload contract was never implemented (broken in every install, unnoticed), and the Electron pivot (2026-05-17) retired this architecture by design.

## [0.1.0] - YYYY-MM-DD

_v1 release; date filled in on tag. Acceptance criteria: spec §18._
