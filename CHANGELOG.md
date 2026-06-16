# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Viewer embeds a Claude Code (or any configurable subprocess) terminal pane via xterm.js + a stdlib-only WebSocket/pty bridge at `/ws/terminal`. Toggleable bottom drawer in `frame.html`; configurable via `.review-config.toml` (`terminal_command`, `terminal_enabled`). Lets the reviewer hold a SURFACE-intent conversation without alt-tabbing out of the viewer (rev-dyn).
- Engine scaffolding (`src/review_pdf_to_latex/`) with the 14-subcommand `review-pdf` CLI.
- `extract` subcommand: pdfannots + rapidfuzz fuzzy mapping + pdftoppm page rendering.
- `apply` / `revert` / `set-status` / `append-chat` / `record-proposal` / `override-mapping` mutators with atomic `state.json` writes.
- `build` subcommand: pdflatex/xelatex orchestration + pagination diff.
- `serve` subcommand: local HTTP viewer (Phase 2a) + `--mapping-mode` UI (Phase 0 cleanup).
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
- Extracted the format-agnostic event bus (`_validate_event`, `_append_event_line`, `wait_for_events`, `handle_wait_event` and helpers) out of `server.py` into a new viewer-free `events.py`. The viewer imports the event bus; the edge is one-way. Wait-event symbols remain importable from `server` for backward compatibility (rev-l7).

## [0.1.0] - YYYY-MM-DD

_v1 release; date filled in on tag. Acceptance criteria: spec §18._
