"""CLI entry point — argparse router for the ``review-pdf`` subcommands.

All subcommands are wired to real handlers (see ``_HANDLERS_TABLE``
below). Adding a new subcommand requires: (1) an ``argparse`` subparser
in ``_build_parser``, (2) a ``_handle_<name>`` function, and (3) an entry
in ``_HANDLERS_TABLE``.

See spec §8 for the full per-command contract and exit codes.
"""

from __future__ import annotations

import argparse
import json as _json
import os
import sys
from pathlib import Path
from typing import Sequence


PROG = "review-pdf"


def _reviewer_rig_guard(
    subcommand: str, args: argparse.Namespace | None = None
) -> int | None:
    """Belt-and-braces refusal for source-mutating atomics under a Reviewer rig.

    Per UX spec §10.5.2 / §10.5.3 (decision rev-1s5 option 3 + thin engine
    slice), the Reviewer (local) destination has no source-mutation
    capability. The skill-side gate is the primary enforcement; this
    secondary gate covers the case where a user invokes the engine binary
    directly from a Reviewer pty. Returns ``EXIT_REVIEWER_RIG_REFUSED``
    (23) when ``$GT_RIG`` starts with ``reviewer/``; otherwise ``None``
    and the caller proceeds normally. An unset or empty ``$GT_RIG`` is
    not a Reviewer context.

    Guarded set: ``apply``, ``build``, ``revert`` — the source-mutating
    atomics named verbatim by spec §10.5.3 item 2. ``commit-phase`` is
    DELIBERATELY EXEMPT (decision OD-4): it is not a source-mutating
    atomic — it only ``git commit``s what ``apply`` already wrote and
    advances ``state.json.phase``. With the three mutating atomics
    refused, a Reviewer rig has no automated source changes left to
    commit, so guarding ``commit-phase`` would close no hole the spec
    intends closed (manual edits inside a Reviewer pty are deliberately
    NOT blocked — §10.5.3 enforces the *automated pipeline boundary*).
    The guarded set is pinned by tests in test_cli.py so it can't drift;
    extend BOTH the call sites and that pin (and amend §10.5.3) if this
    decision is ever revisited.
    """
    gt_rig = os.environ.get("GT_RIG", "")
    if gt_rig.startswith("reviewer/"):
        message = (
            f"{subcommand} refused: invoked under Reviewer rig identity "
            f"$GT_RIG={gt_rig!r}; this rig has no source-mutation "
            "capability per spec §10.5.2 (capability matrix). Route the "
            "submit through an originating rig to apply L1/L2 edits."
        )
        if args is not None:
            return _emit_error(args, message, EXIT_REVIEWER_RIG_REFUSED)
        print(message, file=sys.stderr)
        return EXIT_REVIEWER_RIG_REFUSED
    return None


def _add_global_args(
    parser: argparse.ArgumentParser, *, on_subparser: bool = False
) -> None:
    """Attach ``--project-dir`` and ``--json`` to ``parser``.

    Called once on the top-level parser and once per subparser. On
    subparsers the defaults are :data:`argparse.SUPPRESS` so the
    subparser only writes the namespace when the user actually passes
    the flag — otherwise the top-level value (or its default) wins.
    This lets users place these flags either before or after the
    subcommand:

        review-pdf --project-dir P extract --pdf F   # before
        review-pdf extract --pdf F --project-dir P   # after

    When both positions supply the flag, the subcommand value wins
    (argparse parses subparsers after the parent, so it overwrites).
    """
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=argparse.SUPPRESS if on_subparser else Path.cwd(),
        help=(
            "Project root containing .review-state/ "
            "(default: $PWD; accepted before or after the subcommand)."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        default=argparse.SUPPRESS if on_subparser else False,
        help="Emit machine-consumable JSON on stdout where supported.",
    )


def _build_parser() -> argparse.ArgumentParser:
    from . import __version__
    from . import state as _state

    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Sidecar tool for walking PDF annotations into LaTeX source edits. "
            "See docs/specs/2026-05-16-review-pdf-to-latex-design.md."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
        help="Print the engine version and exit. Used by the Electron app at startup per spec §13.1.",
    )
    _add_global_args(parser)
    sub = parser.add_subparsers(dest="subcommand", metavar="SUBCOMMAND")

    # 1. extract
    p_extract = sub.add_parser(
        "extract",
        help="Read PDF, build annotations.json + mapping.json + initial state.json.",
    )
    p_extract.add_argument("--pdf", type=Path, required=True)
    p_extract.add_argument(
        "--surface-trigger",
        default=None,
        help=(
            "Case-insensitive substring that flags an annotation's comment as "
            "SURFACE-intent. Overrides .review-config.toml's surface_trigger key "
            "(which itself overrides the built-in default 'surface this')."
        ),
    )
    p_extract.add_argument("--force", action="store_true")
    p_extract.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress non-error stderr (e.g., the post-run summary line).",
    )
    _add_global_args(p_extract, on_subparser=True)

    # 3. apply
    p_apply = sub.add_parser("apply", help="Apply an edit to a .tex file.")
    p_apply.add_argument("--annotation-id", required=True)
    p_apply.add_argument("--new-text-file", type=Path, required=True)
    p_apply.add_argument("--dry-run", action="store_true")
    _add_global_args(p_apply, on_subparser=True)

    # 4. revert
    p_revert = sub.add_parser("revert", help="Restore before_text for an annotation.")
    p_revert.add_argument("--annotation-id", required=True)
    p_revert.add_argument(
        "--status",
        choices=["rejected", "needs_review"],
        default="rejected",
    )
    p_revert.add_argument("--failure-log", type=Path, default=None)
    _add_global_args(p_revert, on_subparser=True)

    # 5. preview
    p_preview = sub.add_parser("preview", help="Speculative compile with snapshot/restore.")
    p_preview.add_argument("--annotation-id", required=True)
    p_preview.add_argument("--new-text-file", type=Path, required=True)
    _add_global_args(p_preview, on_subparser=True)

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
    _add_global_args(p_build, on_subparser=True)

    # 7. status
    p_status = sub.add_parser("status", help="Report counts and current state.")
    _add_global_args(p_status, on_subparser=True)

    # 8. override-mapping
    p_om = sub.add_parser(
        "override-mapping", help="Manual mapping override for needs_review cases."
    )
    p_om.add_argument("--annotation-id", required=True)
    p_om.add_argument("--file", required=True)
    p_om.add_argument("--lines", required=True, help="START:END")
    _add_global_args(p_om, on_subparser=True)

    # 9. set-status
    p_ss = sub.add_parser(
        "set-status", help="Transition an annotation's status (no .tex mutation)."
    )
    p_ss.add_argument("--annotation-id", required=True)
    p_ss.add_argument(
        "--status",
        required=True,
        # Single-sourced from state.STATUSES (rev-l13) — do not re-list here.
        choices=list(_state.STATUSES),
    )
    p_ss.add_argument("--reason", default=None)
    _add_global_args(p_ss, on_subparser=True)

    # 9b. set-current (rev-bus: status-neutral navigation)
    p_sc = sub.add_parser(
        "set-current",
        help="Move the viewer cursor to an annotation without changing its status.",
    )
    p_sc.add_argument("--annotation-id", required=True)
    _add_global_args(p_sc, on_subparser=True)

    # 10. append-chat
    p_ac = sub.add_parser(
        "append-chat", help="Append a Phase-2b chat turn to surface_chat_log."
    )
    p_ac.add_argument("--annotation-id", required=True)
    p_ac.add_argument("--role", choices=["user", "claude"], required=True)
    p_ac.add_argument("--text-file", type=Path, required=True)
    _add_global_args(p_ac, on_subparser=True)

    # 11. record-proposal
    p_rp = sub.add_parser(
        "record-proposal",
        help="Record proposed_text without mutating the .tex file.",
    )
    p_rp.add_argument("--annotation-id", required=True)
    p_rp.add_argument("--text-file", type=Path, required=True)
    _add_global_args(p_rp, on_subparser=True)

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
    _add_global_args(p_cp, on_subparser=True)

    # 13. wait-event
    p_we = sub.add_parser(
        "wait-event", help="Block until a new line is appended to state-events.jsonl."
    )
    p_we.add_argument("--since", default=None)
    p_we.add_argument("--timeout", type=int, default=60)
    _add_global_args(p_we, on_subparser=True)

    # 14. bulk-surface
    p_bs = sub.add_parser(
        "bulk-surface",
        help=(
            "Promote every status=pending annotation with trigger_match=true "
            "to surfaced_pending (surface-first ordering shortcut, rev-bwi)."
        ),
    )
    _add_global_args(p_bs, on_subparser=True)

    # 15. migrate-state
    p_ms = sub.add_parser(
        "migrate-state", help="Upgrade state files between schema versions."
    )
    p_ms.add_argument("--from", dest="from_version", type=int, required=True)
    p_ms.add_argument("--to", dest="to_version", type=int, required=True)
    _add_global_args(p_ms, on_subparser=True)

    # 16. pdf-health
    p_ph = sub.add_parser(
        "pdf-health",
        help=(
            "Pre-flight health check for a PDF (text-layer readability, "
            "ligature loss, encryption, per-page errors). Specified by "
            "ux-spec §5.2 + design-spec §8; always emits JSON to stdout."
        ),
    )
    p_ph.add_argument("--pdf", type=Path, required=True, help="Path to the PDF to check.")
    _add_global_args(p_ph, on_subparser=True)

    return parser


def _handle_extract(args: argparse.Namespace) -> int:
    """Phase 0: extract annotations, render pages, build initial state."""
    from review_pdf_to_latex.extract import run_extract

    return run_extract(
        pdf_path=Path(args.pdf),
        project_dir=Path(args.project_dir),
        surface_trigger=args.surface_trigger,
        force=bool(args.force),
        quiet=bool(getattr(args, "quiet", False)),
        json_output=bool(getattr(args, "json_output", False)),
    )


def _handle_build(args: argparse.Namespace) -> int:
    """Compile LaTeX; append a build record (spec §8 build row)."""
    if (refused := _reviewer_rig_guard("build", args)) is not None:
        return refused
    from review_pdf_to_latex.build import run_build_command

    return run_build_command(
        project_dir=Path(args.project_dir),
        main_file=Path(args.main_file) if args.main_file else None,
        engine=args.engine,
        quiet=args.quiet,
        benchmark=getattr(args, "benchmark", False),
    )


def _handle_wait_event(args: argparse.Namespace) -> int:
    """Block until state-events.jsonl grows (spec §8 wait-event row)."""
    from review_pdf_to_latex.events import handle_wait_event

    return handle_wait_event(
        project_dir=Path(args.project_dir),
        since=args.since,
        timeout=args.timeout,
    )


def _git_working_tree_state(project_dir: Path) -> str:
    """Best-effort git working-tree summary: 'clean', 'dirty (N file(s))', or '(not a git repo)'.

    Runs ``git status --porcelain``. Falls back to ``(unknown)`` on any
    failure so ``status`` never crashes on environments without git.
    """
    import subprocess

    try:
        proc = subprocess.run(
            ["git", "-C", str(project_dir), "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return "(unknown)"
    if proc.returncode != 0:
        return "(not a git repo)"
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not lines:
        return "clean"
    n = len(lines)
    return f"dirty ({n} file{'s' if n != 1 else ''})"


# Presentation order for the `status` human summary's count line: headline
# statuses (the ones a reviewer acts on) first, terminal ones last. This is a
# display ordering, NOT the spec §7.3 order — its membership is pinned to
# state.ALL_STATUSES by test_status_consumer_orderings_cover_all_statuses
# (rev-l13), so it can never silently drop a status.
_STATUS_HEADLINE_ORDER: tuple[str, ...] = (
    "applied",
    "pending",
    "needs_review",
    "surfaced_pending",
    "accepted",
    "rejected",
    "redrafted",
    "deferred",
    "surfaced_resolved",
)


def _format_status_human(
    report: "_status.StatusReport", project_dir: Path
) -> str:
    """Render a :class:`StatusReport` as a compact 4-line summary.

    The four lines are intentionally fixed so callers (and the polecat
    skill) can grep deterministically:

    1. Phase / order / current annotation.
    2. Annotation counts (headline statuses; only nonzero ones shown).
    3. Last build status.
    4. Working-tree state (git porcelain).

    Use ``--json`` for the full machine-readable structure.
    """
    # Line 1: phase + order + current annotation
    cur = report.current_annotation_id or "(none)"
    line1 = (
        f"Phase: {report.phase} (order: {report.order}) · current: {cur}"
    )

    # Line 2: compact counts. Show total plus every nonzero status, in
    # the canonical order so users see headline numbers (applied, pending,
    # needs_review, surfaced_pending) before terminal ones. This is a
    # presentation ordering (not the spec §7.3 order); its membership is
    # pinned to state.ALL_STATUSES by test_status_consumer_orderings_cover_all_statuses.
    parts = [f"{report.total} total"]
    for name in _STATUS_HEADLINE_ORDER:
        n = report.counts.get(name, 0)
        if n > 0:
            parts.append(f"{n} {name}")
    line2 = "Counts: " + " · ".join(parts)

    # Line 3: last build
    if report.most_recent_build is not None:
        b = report.most_recent_build
        ok_str = "ok" if b.get("ok") else "FAILED"
        line3 = (
            f"Last build: {b.get('id')} — {ok_str}, "
            f"{b.get('page_count')} pages ({b.get('compiled_at')})"
        )
    else:
        line3 = "Last build: (none)"

    # Line 4: working-tree state
    line4 = f"Working tree: {_git_working_tree_state(project_dir)}"

    return "\n".join([line1, line2, line3, line4])


def _handle_status(args: argparse.Namespace) -> int:
    """``status`` subcommand handler (spec §8 exit codes 0, 6)."""
    from review_pdf_to_latex import state as _state
    from review_pdf_to_latex import status as _status

    state_dir = _state.StateDir(args.project_dir)
    try:
        report = _status.compute_status_report(state_dir)
    except _status.StateMissingError as e:
        return _emit_error(args, f"state missing: {e}", EXIT_STATE_MISSING)

    if args.json_output:
        print_json(report.to_dict())
    else:
        print(_format_status_human(report, Path(args.project_dir)))
    return EXIT_OK


def _handle_apply(args: argparse.Namespace) -> int:
    """``apply`` subcommand handler (spec §8 exit codes 0, 7, 8, 9, 13, 16, 18, 21, 22, 23)."""
    if (refused := _reviewer_rig_guard("apply", args)) is not None:
        return refused
    from review_pdf_to_latex.apply import ApplyError, apply_edit

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        new_text = Path(args.new_text_file).read_text(encoding="utf-8")
    except OSError as exc:
        return _emit_error(
            args, f"cannot read --new-text-file: {exc}", EXIT_FILE_MUTATION_FAILED
        )
    try:
        result = apply_edit(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            new_text=new_text,
            dry_run=bool(args.dry_run),
        )
    except ApplyError as exc:
        return _emit_error(args, f"error: {exc}", exc.exit_code)
    if args.dry_run:
        print(f"--- {result.latex_file} (current)")
        print(f"+++ {result.latex_file} (proposed)")
        for ln in result.old_lines:
            sys.stdout.write(f"-{ln}")
        for ln in result.new_lines:
            sys.stdout.write(f"+{ln}")
    return EXIT_OK


def _handle_revert(args: argparse.Namespace) -> int:
    """``revert`` subcommand handler (spec §8 exit codes 0, 7, 9, 10, 18, 21, 22, 23)."""
    if (refused := _reviewer_rig_guard("revert", args)) is not None:
        return refused
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
        return _emit_error(args, f"error: {exc}", exc.exit_code)
    except ValueError as exc:
        # revert_edit raises ValueError for bad --status / failure-log combos.
        return _emit_error(args, f"error: {exc}", EXIT_ILLEGAL_STATUS_TRANSITION)
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
        return _emit_error(args, f"error: {exc}", exc.exit_code)
    return EXIT_OK


def _handle_set_current(args: argparse.Namespace) -> int:
    """``set-current`` subcommand handler (spec rev-bus, exit codes 0, 7, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, set_current_annotation

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        set_current_annotation(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
        )
    except ApplyError as exc:
        return _emit_error(args, f"error: {exc}", exc.exit_code)
    return EXIT_OK


def _handle_append_chat(args: argparse.Namespace) -> int:
    """``append-chat`` subcommand handler (spec §8 exit codes 0, 7, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, append_chat_turn

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        text = Path(args.text_file).read_text(encoding="utf-8")
    except OSError as exc:
        return _emit_error(
            args, f"cannot read --text-file: {exc}", EXIT_FILE_MUTATION_FAILED
        )
    try:
        append_chat_turn(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            role=args.role,
            text=text,
        )
    except ApplyError as exc:
        return _emit_error(args, f"error: {exc}", exc.exit_code)
    except ValueError as exc:
        # Invalid role (already restricted by argparse, but defend in depth).
        return _emit_error(args, f"error: {exc}", EXIT_ILLEGAL_STATUS_TRANSITION)
    return EXIT_OK


def _handle_record_proposal(args: argparse.Namespace) -> int:
    """``record-proposal`` subcommand handler (spec §8 exit codes 0, 7, 21, 22)."""
    from review_pdf_to_latex.apply import ApplyError, record_proposal

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        text = Path(args.text_file).read_text(encoding="utf-8")
    except OSError as exc:
        return _emit_error(
            args, f"cannot read --text-file: {exc}", EXIT_FILE_MUTATION_FAILED
        )
    try:
        record_proposal(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            proposed_text=text,
        )
    except ApplyError as exc:
        return _emit_error(args, f"error: {exc}", exc.exit_code)
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
        return _emit_error(
            args,
            f"error: --lines must be START:END (got {args.lines!r})",
            EXIT_INVALID_LINE_RANGE,
        )
    try:
        override_mapping(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            file=args.file,
            lines=lines,
        )
    except ApplyError as exc:
        return _emit_error(args, f"error: {exc}", exc.exit_code)
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
        return _emit_error(args, f"error: {exc}", exc.exit_code)
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
        return _emit_error(
            args, f"cannot read --new-text-file: {exc}", EXIT_FILE_MUTATION_FAILED
        )
    try:
        build_id = _preview.preview(state_dir, args.annotation_id, new_text)
    except _state.SourcePdfChangedError as exc:
        return _emit_error(
            args, f"source PDF changed since extract: {exc}", EXIT_SOURCE_PDF_CHANGED
        )
    except _state.LegacyStateError as exc:
        return _emit_error(
            args, f"legacy state (no source_pdf_md5): {exc}", EXIT_LEGACY_STATE
        )
    except _preview.InPlaceRestoreError as exc:
        # Special-cased only for the extra recovery-file instructions (spec §8
        # exit 17); the code itself still comes from exc.exit_code. The JSON
        # envelope folds the recovery hint into the message so machine callers
        # get it too (stdout stays a single JSON object).
        recovery = (
            "  recovery: copy the contents of the recovery file back over "
            "the original .tex location."
        )
        if getattr(args, "json_output", False):
            return _emit_error(
                args, f"in-place restore failed: {exc}\n{recovery}", exc.exit_code
            )
        print(f"in-place restore failed: {exc}", file=sys.stderr)
        print(recovery, file=sys.stderr)
        return exc.exit_code
    except _preview.PreviewError as exc:
        # AnnotationNotFoundError (7) / MappingUnresolvedError (8) — folded into
        # the EngineError hierarchy (rev-x10), so this collapses like every
        # other mutator handler.
        return _emit_error(args, f"error: {exc}", exc.exit_code)
    print(build_id)
    return EXIT_OK


def _handle_bulk_surface(args: argparse.Namespace) -> int:
    """``bulk-surface`` subcommand handler (rev-bwi).

    Exit codes: 0 ok; 18 illegal transition (validation guard); 21/22
    source-PDF guard. ``--json`` emits ``{"promoted": [...]}``; the human
    output is one ``"promoted N: id1 id2 ..."`` line on stdout.
    """
    from review_pdf_to_latex.apply import ApplyError, bulk_surface_pending

    state_dir = Path(args.project_dir) / ".review-state"
    try:
        promoted = bulk_surface_pending(state_dir=state_dir)
    except ApplyError as exc:
        return _emit_error(args, f"error: {exc}", exc.exit_code)

    if getattr(args, "json_output", False):
        print_json({"promoted": list(promoted)})
    else:
        if promoted:
            print(f"promoted {len(promoted)}: {' '.join(promoted)}")
        else:
            print("promoted 0")
    return EXIT_OK


def _handle_pdf_health(args: argparse.Namespace) -> int:
    """PDF pre-flight health check (design-spec §8 pdf-health row)."""
    from review_pdf_to_latex.pdf_health import run_pdf_health

    return run_pdf_health(Path(args.pdf))


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
        return _emit_error(
            args, f"unsupported migration: {e}", EXIT_UNSUPPORTED_MIGRATION
        )
    return EXIT_OK


# Dispatch table: every subcommand → its handler. Adding a new subcommand
# requires an entry here plus a matching argparse subparser in _build_parser
# and a _handle_<name> function defined above.
_HANDLERS_TABLE: dict[str, "callable"] = {
    "extract": _handle_extract,
    "build": _handle_build,
    "wait-event": _handle_wait_event,
    "status": _handle_status,
    "migrate-state": _handle_migrate_state,
    "apply": _handle_apply,
    "revert": _handle_revert,
    "set-status": _handle_set_status,
    "set-current": _handle_set_current,
    "append-chat": _handle_append_chat,
    "record-proposal": _handle_record_proposal,
    "override-mapping": _handle_override_mapping,
    "commit-phase": _handle_commit_phase,
    "preview": _handle_preview,
    "bulk-surface": _handle_bulk_surface,
    "pdf-health": _handle_pdf_health,
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


def _emit_error(args: argparse.Namespace, message: str, exit_code: int) -> int:
    """Emit a CLI error and return its exit code (rev-l13 uniform envelope).

    Two output modes, selected by the global ``--json`` flag:

    - ``--json`` set: write a single ``{"error": <message>, "exit_code":
      <code>}`` object to **stdout** via :func:`print_json`. This makes the
      machine contract uniform — with ``--json``, stdout is exactly one JSON
      object whether the command succeeds or fails — so consumers parse one
      place regardless of outcome.
    - human mode (default): write ``message`` to stderr, preserving the
      pre-existing human output verbatim.

    The returned int is the process exit code and remains the authoritative
    failure signal in both modes (the ``exit_code`` field merely mirrors it
    for callers that capture stdout but not the wait status).
    """
    if getattr(args, "json_output", False):
        print_json({"error": message, "exit_code": exit_code})
    else:
        print(message, file=sys.stderr)
    return exit_code


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
# Single-sourced from exit_codes.py (rev-x10); re-exported at module level so
# ``cli.EXIT_*`` references and the pinning test keep working unchanged.
from .exit_codes import (  # noqa: E402,F401  (re-export for the contract surface)
    EXIT_ANNOTATION_NOT_FOUND,
    EXIT_BUILD_FAILED,
    EXIT_COMMIT_FAILED,
    EXIT_DIRTY_GIT_STATE,
    EXIT_EXISTING_STATE,
    EXIT_FILE_MUTATION_FAILED,
    EXIT_GENERIC,
    EXIT_ILLEGAL_STATUS_TRANSITION,
    EXIT_INVALID_LINE_RANGE,
    EXIT_LEGACY_STATE,
    EXIT_MAIN_FILE_NOT_FOUND,
    EXIT_MAPPING_UNRESOLVED,
    EXIT_MISSING_PDF,
    EXIT_NO_PRIOR_APPLY,
    EXIT_OK,
    EXIT_OVERLAPPING_LINE_RANGE,
    EXIT_PDFANNOTS_FAILED,
    EXIT_PORT_UNAVAILABLE,
    EXIT_RESTORE_FAILED,
    EXIT_REVIEWER_RIG_REFUSED,
    EXIT_SOURCE_PDF_CHANGED,
    EXIT_STATE_MISSING,
    EXIT_UNSUPPORTED_MIGRATION,
    EXIT_WAIT_TIMEOUT,
)
