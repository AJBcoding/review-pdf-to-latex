"""CLI entry point — argparse router for the 14 ``review-pdf`` subcommands.

All 14 subcommands are wired to real handlers (see ``_HANDLERS_TABLE``
below). Adding a new subcommand requires: (1) an ``argparse`` subparser
in ``_build_parser``, (2) a ``_handle_<name>`` function, and (3) an entry
in ``_HANDLERS_TABLE``.

See spec §8 for the full per-command contract and exit codes.
"""

from __future__ import annotations

import argparse
import json as _json
import sys
from pathlib import Path
from typing import Sequence


PROG = "review-pdf"


def _add_global_args(parser: argparse.ArgumentParser) -> None:
    """Attach ``--project-dir`` and ``--json`` to the top-level parser."""
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=Path.cwd(),
        help="Project root containing .review-state/ (default: $PWD).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Emit machine-consumable JSON on stdout where supported.",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Sidecar tool for walking PDF annotations into LaTeX source edits. "
            "See docs/specs/2026-05-16-review-pdf-to-latex-design.md."
        ),
    )
    _add_global_args(parser)
    sub = parser.add_subparsers(dest="subcommand", metavar="SUBCOMMAND")

    # 1. extract
    p_extract = sub.add_parser(
        "extract",
        help="Read PDF, build annotations.json + mapping.json + initial state.json.",
    )
    p_extract.add_argument("--pdf", type=Path, required=True)
    p_extract.add_argument("--surface-trigger", default="claude surface this")
    p_extract.add_argument("--force", action="store_true")

    # 2. serve
    p_serve = sub.add_parser("serve", help="Start the local HTTP viewer.")
    p_serve.add_argument("--port", type=int, default=0)
    p_serve.add_argument(
        "--order",
        choices=["mechanical-first", "surface-first"],
        default="mechanical-first",
    )
    p_serve.add_argument("--mapping-mode", action="store_true")

    # 3. apply
    p_apply = sub.add_parser("apply", help="Apply an edit to a .tex file.")
    p_apply.add_argument("--annotation-id", required=True)
    p_apply.add_argument("--new-text-file", type=Path, required=True)
    p_apply.add_argument("--dry-run", action="store_true")

    # 4. revert
    p_revert = sub.add_parser("revert", help="Restore before_text for an annotation.")
    p_revert.add_argument("--annotation-id", required=True)
    p_revert.add_argument(
        "--status",
        choices=["rejected", "needs_review"],
        default="rejected",
    )
    p_revert.add_argument("--failure-log", type=Path, default=None)

    # 5. preview
    p_preview = sub.add_parser("preview", help="Speculative compile with snapshot/restore.")
    p_preview.add_argument("--annotation-id", required=True)
    p_preview.add_argument("--new-text-file", type=Path, required=True)

    # 6. build
    p_build = sub.add_parser("build", help="Run pdflatex/xelatex; append build record.")
    p_build.add_argument("--main-file", type=Path, default=None)
    p_build.add_argument(
        "--engine",
        choices=["pdflatex", "xelatex", "auto"],
        default="auto",
    )
    p_build.add_argument("--quiet", action="store_true")
    p_build.add_argument(
        "--benchmark",
        action="store_true",
        help="Print 'Compile took X.Xs' to stderr (spec §11.3).",
    )

    # 7. status
    sub.add_parser("status", help="Report counts and current state.")

    # 8. override-mapping
    p_om = sub.add_parser(
        "override-mapping", help="Manual mapping override for needs_review cases."
    )
    p_om.add_argument("--annotation-id", required=True)
    p_om.add_argument("--file", required=True)
    p_om.add_argument("--lines", required=True, help="START:END")

    # 9. set-status
    p_ss = sub.add_parser(
        "set-status", help="Transition an annotation's status (no .tex mutation)."
    )
    p_ss.add_argument("--annotation-id", required=True)
    p_ss.add_argument(
        "--status",
        required=True,
        choices=[
            "pending",
            "applied",
            "accepted",
            "rejected",
            "redrafted",
            "deferred",
            "surfaced_pending",
            "surfaced_resolved",
            "needs_review",
        ],
    )
    p_ss.add_argument("--reason", default=None)

    # 10. append-chat
    p_ac = sub.add_parser(
        "append-chat", help="Append a Phase-2b chat turn to surface_chat_log."
    )
    p_ac.add_argument("--annotation-id", required=True)
    p_ac.add_argument("--role", choices=["user", "claude"], required=True)
    p_ac.add_argument("--text-file", type=Path, required=True)

    # 11. record-proposal
    p_rp = sub.add_parser(
        "record-proposal",
        help="Record proposed_text without mutating the .tex file.",
    )
    p_rp.add_argument("--annotation-id", required=True)
    p_rp.add_argument("--text-file", type=Path, required=True)

    # 12. commit-phase
    p_cp = sub.add_parser(
        "commit-phase", help="Run git commit and advance state.json.phase."
    )
    p_cp.add_argument("--phase", required=True, choices=["1", "2a", "2b", "3"])
    p_cp.add_argument("--message-suffix", default=None)
    p_cp.add_argument(
        "--granularity",
        default="phase",
        help="phase | session | batch:N (default: phase)",
    )

    # 13. wait-event
    p_we = sub.add_parser(
        "wait-event", help="Block until a new line is appended to state-events.jsonl."
    )
    p_we.add_argument("--since", default=None)
    p_we.add_argument("--timeout", type=int, default=60)

    # 14. migrate-state
    p_ms = sub.add_parser(
        "migrate-state", help="Upgrade state files between schema versions."
    )
    p_ms.add_argument("--from", dest="from_version", type=int, required=True)
    p_ms.add_argument("--to", dest="to_version", type=int, required=True)

    return parser


def _handle_extract(args: argparse.Namespace) -> int:
    """Phase 0: extract annotations, render pages, build initial state."""
    from review_pdf_to_latex.extract import run_extract

    return run_extract(
        pdf_path=Path(args.pdf),
        project_dir=Path(args.project_dir),
        surface_trigger=args.surface_trigger,
        force=bool(args.force),
    )


def _handle_build(args: argparse.Namespace) -> int:
    """Compile LaTeX; append a build record (spec §8 build row)."""
    from review_pdf_to_latex.build import run_build_command

    return run_build_command(
        project_dir=Path(args.project_dir),
        main_file=Path(args.main_file) if args.main_file else None,
        engine=args.engine,
        quiet=args.quiet,
        benchmark=getattr(args, "benchmark", False),
    )


def _handle_serve(args: argparse.Namespace) -> int:
    """Start the local HTTP viewer (spec §8 serve row)."""
    from review_pdf_to_latex.server import handle_serve

    return handle_serve(
        project_dir=Path(args.project_dir),
        port=args.port,
        order=args.order,
        mapping_mode=args.mapping_mode,
    )


def _handle_wait_event(args: argparse.Namespace) -> int:
    """Block until state-events.jsonl grows (spec §8 wait-event row)."""
    from review_pdf_to_latex.server import handle_wait_event

    return handle_wait_event(
        project_dir=Path(args.project_dir),
        since=args.since,
        timeout=args.timeout,
    )


def _format_status_human(report: "_status.StatusReport") -> str:
    """Render a :class:`StatusReport` as a multi-line human summary."""
    lines: list[str] = []
    lines.append(f"Phase: {report.phase}  (order: {report.order})")
    cur = report.current_annotation_id or "(none)"
    lines.append(f"Current annotation: {cur}")
    lines.append(
        f"Annotations: {report.total} total "
        f"({report.terminal_count} terminal, {report.non_terminal_count} non-terminal)"
    )
    for status_name, count in report.counts.items():
        if count > 0:
            lines.append(f"    {status_name}: {count}")
    if report.most_recent_build is not None:
        b = report.most_recent_build
        ok_str = "ok" if b.get("ok") else "FAILED"
        lines.append(
            f"Last build: {b.get('id')} — {ok_str}, "
            f"{b.get('page_count')} pages (compiled {b.get('compiled_at')})"
        )
    else:
        lines.append("Last build: (none)")
    if report.unresolved_needs_review > 0:
        lines.append(
            f"Unresolved needs_review: {report.unresolved_needs_review}"
        )
    return "\n".join(lines)


def _handle_status(args: argparse.Namespace) -> int:
    """``status`` subcommand handler (spec §8 exit codes 0, 6)."""
    from review_pdf_to_latex import state as _state
    from review_pdf_to_latex import status as _status

    state_dir = _state.StateDir(args.project_dir)
    try:
        report = _status.compute_status_report(state_dir)
    except _status.StateMissingError as e:
        print(f"state missing: {e}", file=sys.stderr)
        return EXIT_STATE_MISSING

    if args.json_output:
        print_json(report.to_dict())
    else:
        print(_format_status_human(report))
    return EXIT_OK


def _handle_apply(args: argparse.Namespace) -> int:
    """``apply`` subcommand handler (spec §8 exit codes 0, 7, 8, 9, 13, 16, 18, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, apply_edit

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        new_text = Path(args.new_text_file).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"cannot read --new-text-file: {exc}", file=sys.stderr)
        return EXIT_FILE_MUTATION_FAILED
    try:
        result = apply_edit(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            new_text=new_text,
            dry_run=bool(args.dry_run),
        )
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    if args.dry_run:
        print(f"--- {result.latex_file} (current)")
        print(f"+++ {result.latex_file} (proposed)")
        for ln in result.old_lines:
            sys.stdout.write(f"-{ln}")
        for ln in result.new_lines:
            sys.stdout.write(f"+{ln}")
    return EXIT_OK


def _handle_revert(args: argparse.Namespace) -> int:
    """``revert`` subcommand handler (spec §8 exit codes 0, 7, 9, 10, 18, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, revert_edit

    state_dir = Path(args.project_dir) / ".review-state"
    failure_log = Path(args.failure_log) if args.failure_log else None
    try:
        revert_edit(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            status=args.status,
            failure_log=failure_log,
        )
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    except ValueError as exc:
        # revert_edit raises ValueError for bad --status / failure-log combos.
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ILLEGAL_STATUS_TRANSITION
    return EXIT_OK


def _handle_set_status(args: argparse.Namespace) -> int:
    """``set-status`` subcommand handler (spec §8 exit codes 0, 7, 18, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, set_annotation_status

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        set_annotation_status(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            status=args.status,
            reason=args.reason,
        )
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    return EXIT_OK


def _handle_append_chat(args: argparse.Namespace) -> int:
    """``append-chat`` subcommand handler (spec §8 exit codes 0, 7, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, append_chat_turn

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        text = Path(args.text_file).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"cannot read --text-file: {exc}", file=sys.stderr)
        return EXIT_FILE_MUTATION_FAILED
    try:
        append_chat_turn(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            role=args.role,
            text=text,
        )
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    except ValueError as exc:
        # Invalid role (already restricted by argparse, but defend in depth).
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ILLEGAL_STATUS_TRANSITION
    return EXIT_OK


def _handle_record_proposal(args: argparse.Namespace) -> int:
    """``record-proposal`` subcommand handler (spec §8 exit codes 0, 7, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, record_proposal

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        text = Path(args.text_file).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"cannot read --text-file: {exc}", file=sys.stderr)
        return EXIT_FILE_MUTATION_FAILED
    try:
        record_proposal(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            proposed_text=text,
        )
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    return EXIT_OK


def _handle_override_mapping(args: argparse.Namespace) -> int:
    """``override-mapping`` subcommand handler (spec §8 exit codes 0, 7, 9, 13, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, override_mapping

    state_dir = Path(args.project_dir) / ".review-state"
    # args.lines is the raw "START:END" string from argparse; parse it here.
    try:
        start_s, end_s = args.lines.split(":", 1)
        lines = (int(start_s), int(end_s))
    except (ValueError, AttributeError):
        print(
            f"error: --lines must be START:END (got {args.lines!r})",
            file=sys.stderr,
        )
        return EXIT_INVALID_LINE_RANGE
    try:
        override_mapping(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            file=args.file,
            lines=lines,
        )
    except ApplyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    return EXIT_OK


# Phase short-form (CLI flag) → canonical state.json phase identifier.
# The CLI's argparse only accepts the short forms ("1", "2a", ...) per
# chunk B; the state file uses full forms ("1-batch", "2a-ratify", ...).
_PHASE_SHORT_TO_FULL: dict[str, str] = {
    "0": "0-setup",
    "1": "1-batch",
    "2a": "2a-ratify",
    "2b": "2b-surface",
    "3": "3-final",
    "0-setup": "0-setup",
    "1-batch": "1-batch",
    "2a-ratify": "2a-ratify",
    "2b-surface": "2b-surface",
    "3-final": "3-final",
}


def _handle_commit_phase(args: argparse.Namespace) -> int:
    """``commit-phase`` subcommand handler (spec §8 exit codes 0, 1, 15, 19, 21, 22)."""
    from review_pdf_to_latex.commit import CommitError, commit_phase

    state_dir = Path(args.project_dir) / ".review-state"
    phase_arg = _PHASE_SHORT_TO_FULL.get(args.phase, args.phase)
    try:
        sha = commit_phase(
            state_dir=state_dir,
            phase_arg=phase_arg,
            message_suffix=args.message_suffix,
            granularity=args.granularity,
        )
    except CommitError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    print(sha)
    return EXIT_OK


def _handle_preview(args: argparse.Namespace) -> int:
    """``preview`` subcommand handler (spec §8 exit codes 0, 7, 8, 11, 17, 21, 22)."""
    from review_pdf_to_latex import preview as _preview
    from review_pdf_to_latex import state as _state

    state_dir = _state.StateDir(args.project_dir)
    try:
        new_text = Path(args.new_text_file).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"cannot read --new-text-file: {exc}", file=sys.stderr)
        return EXIT_FILE_MUTATION_FAILED
    try:
        build_id = _preview.preview(state_dir, args.annotation_id, new_text)
    except _state.SourcePdfChangedError as exc:
        print(f"source PDF changed since extract: {exc}", file=sys.stderr)
        return EXIT_SOURCE_PDF_CHANGED
    except _state.LegacyStateError as exc:
        print(f"legacy state (no source_pdf_md5): {exc}", file=sys.stderr)
        return EXIT_LEGACY_STATE
    except _preview.AnnotationNotFoundError as exc:
        print(f"annotation not found: {exc}", file=sys.stderr)
        return EXIT_ANNOTATION_NOT_FOUND
    except _preview.MappingUnresolvedError as exc:
        print(f"mapping unresolved: {exc}", file=sys.stderr)
        return EXIT_MAPPING_UNRESOLVED
    except _preview.InPlaceRestoreError as exc:
        # Preserve the recovery-file instructions verbatim (spec §8 exit 17).
        print(f"in-place restore failed: {exc}", file=sys.stderr)
        print(
            "  recovery: copy the contents of the recovery file back over "
            "the original .tex location.",
            file=sys.stderr,
        )
        return EXIT_RESTORE_FAILED
    print(build_id)
    return EXIT_OK


def _handle_migrate_state(args: argparse.Namespace) -> int:
    """``migrate-state`` subcommand handler (spec §8 exit code 14).

    Design decision (do NOT add a source-PDF integrity guard here):
        Other mutators (apply / revert / preview / set-status / etc.) call
        ``state.assert_source_pdf_unchanged`` to refuse work if the source
        PDF's MD5 no longer matches ``annotations.json.source_pdf_md5``.
        ``migrate-state`` deliberately does NOT call that guard: migration
        operates on the on-disk state files only, and the source PDF may
        have legitimately moved, been renamed, or been deleted between the
        original ``extract`` and the migration run.
    """
    from review_pdf_to_latex import migrate as _migrate
    from review_pdf_to_latex import state as _state

    state_dir = _state.StateDir(args.project_dir)
    try:
        _migrate.migrate(
            state_dir,
            from_version=args.from_version,
            to_version=args.to_version,
        )
    except _migrate.UnsupportedMigrationError as e:
        print(f"unsupported migration: {e}", file=sys.stderr)
        return EXIT_UNSUPPORTED_MIGRATION
    return EXIT_OK


# Dispatch table: every subcommand → its handler. Adding a new subcommand
# requires an entry here plus a matching argparse subparser in _build_parser
# and a _handle_<name> function defined above.
_HANDLERS_TABLE: dict[str, "callable"] = {
    "extract": _handle_extract,
    "build": _handle_build,
    "serve": _handle_serve,
    "wait-event": _handle_wait_event,
    "status": _handle_status,
    "migrate-state": _handle_migrate_state,
    "apply": _handle_apply,
    "revert": _handle_revert,
    "set-status": _handle_set_status,
    "append-chat": _handle_append_chat,
    "record-proposal": _handle_record_proposal,
    "override-mapping": _handle_override_mapping,
    "commit-phase": _handle_commit_phase,
    "preview": _handle_preview,
}


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns an exit code (or raises SystemExit for --help).

    Parameters
    ----------
    argv:
        Argument list, defaulting to ``sys.argv[1:]``. Passed explicitly
        in tests; the ``[project.scripts]`` shim leaves it as None.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.subcommand is None:
        parser.print_usage(sys.stderr)
        raise SystemExit(2)
    handler = _HANDLERS_TABLE[args.subcommand]
    return handler(args)


def print_json(data: object) -> None:
    """Write one JSON object as a newline-terminated line on stdout.

    Sorted keys; compact separators; no trailing whitespace. Used by every
    subcommand handler whose ``args.json_output`` is true. The single-line
    format makes streaming output trivially parseable by the skill.
    """
    sys.stdout.write(_json.dumps(data, sort_keys=True))
    sys.stdout.write("\n")
    sys.stdout.flush()


# Exit codes (spec §8 — pinned by tests/test_cli.py::test_exit_code_constants_match_spec).
# The skill consumes these as its contract with the engine; do NOT renumber.
EXIT_OK = 0
EXIT_MISSING_PDF = 2  # extract: --pdf path absent or unreadable
EXIT_EXISTING_STATE = 3  # extract: .review-state/ exists, no --force
EXIT_PDFANNOTS_FAILED = 4  # extract: pdfannots parse error
EXIT_PORT_UNAVAILABLE = 5  # serve: requested port in use
EXIT_STATE_MISSING = 6  # any: state.json absent when required
EXIT_ANNOTATION_NOT_FOUND = 7  # any per-annotation: id absent
EXIT_MAPPING_UNRESOLVED = 8  # apply/preview: mapping has no latex_file/line_range
EXIT_FILE_MUTATION_FAILED = 9  # apply: .tex write failed
EXIT_NO_PRIOR_APPLY = 10  # revert: no before_text captured
EXIT_BUILD_FAILED = 11  # build/preview: pdflatex non-zero
EXIT_MAIN_FILE_NOT_FOUND = 12  # build: --main-file absent
EXIT_INVALID_LINE_RANGE = 13  # override-mapping: bad START:END
EXIT_UNSUPPORTED_MIGRATION = 14  # migrate-state: no path from N to M
EXIT_DIRTY_GIT_STATE = 15  # commit-phase: git status --porcelain non-empty
EXIT_OVERLAPPING_LINE_RANGE = 16  # apply: conflict with another annotation
EXIT_RESTORE_FAILED = 17  # preview: in-place restore failed (engine emits recovery)
EXIT_ILLEGAL_STATUS_TRANSITION = 18  # set-status: rejected by validate_status_transition
EXIT_COMMIT_FAILED = 19  # commit-phase: hook or staging error
EXIT_WAIT_TIMEOUT = 20  # wait-event: --timeout elapsed before any event
EXIT_SOURCE_PDF_CHANGED = 21  # any mutator: PDF md5 differs from annotations.json.source_pdf_md5
EXIT_LEGACY_STATE = 22  # any mutator: annotations.json predates source_pdf_md5 guard
