"""CLI entry point — argparse router for the 14 ``review-pdf`` subcommands.

Each subcommand handler is a stub that raises ``NotImplementedError`` until
the corresponding feature task lands. The router itself, ``--project-dir``,
the ``--json`` global flag, and the exit-code constants are all wired up
here so feature tasks can drop in implementations without touching argparse.

See spec §8 for the full per-command contract and exit codes.
"""

from __future__ import annotations

import argparse
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


def _stub(name: str) -> None:
    """Raise NotImplementedError for an unimplemented subcommand."""
    raise NotImplementedError(f"subcommand {name} not yet implemented")


_HANDLERS: dict[str, str] = {
    "extract": "extract",
    "serve": "serve",
    "apply": "apply",
    "revert": "revert",
    "preview": "preview",
    "build": "build",
    "status": "status",
    "override-mapping": "override-mapping",
    "set-status": "set-status",
    "append-chat": "append-chat",
    "record-proposal": "record-proposal",
    "commit-phase": "commit-phase",
    "wait-event": "wait-event",
    "migrate-state": "migrate-state",
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
    _stub(_HANDLERS[args.subcommand])
    return 0  # unreachable until stubs are replaced
