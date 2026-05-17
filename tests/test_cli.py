"""Tests for review_pdf_to_latex.cli — argparse router and subcommand dispatch."""

import json
from pathlib import Path

import pytest

from review_pdf_to_latex import cli


ALL_SUBCOMMANDS = [
    "extract",
    "serve",
    "apply",
    "revert",
    "preview",
    "build",
    "status",
    "override-mapping",
    "set-status",
    "append-chat",
    "record-proposal",
    "commit-phase",
    "wait-event",
    "migrate-state",
]


def test_top_level_help_exits_zero(capsys: pytest.CaptureFixture):
    """`review-pdf --help` exits with code 0 and prints the program name."""
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "review-pdf" in out


def test_top_level_no_args_exits_nonzero(capsys: pytest.CaptureFixture):
    """`review-pdf` with no subcommand exits non-zero with a usage hint."""
    with pytest.raises(SystemExit) as exc:
        cli.main([])
    assert exc.value.code != 0


@pytest.mark.parametrize("subcommand", ALL_SUBCOMMANDS)
def test_subcommand_help_exits_zero(
    subcommand: str, capsys: pytest.CaptureFixture
):
    """`review-pdf <subcommand> --help` exits with code 0."""
    with pytest.raises(SystemExit) as exc:
        cli.main([subcommand, "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert subcommand in out


@pytest.mark.parametrize("subcommand", ALL_SUBCOMMANDS)
def test_subcommand_stub_raises_not_implemented(
    subcommand: str, tmp_project: Path
):
    """Each of the 14 subcommand stubs raises NotImplementedError until implemented.

    We supply the bare-minimum flags each stub requires to satisfy argparse;
    the stub raises BEFORE doing any real work.
    """
    # Per-subcommand minimum required args so argparse does not exit first.
    args_by_cmd: dict[str, list[str]] = {
        "extract": ["--pdf", str(tmp_project / "fake.pdf")],
        "serve": [],
        "apply": [
            "--annotation-id", "ann-001",
            "--new-text-file", str(tmp_project / "draft.tex"),
        ],
        "revert": ["--annotation-id", "ann-001"],
        "preview": [
            "--annotation-id", "ann-001",
            "--new-text-file", str(tmp_project / "draft.tex"),
        ],
        "build": [],
        "status": [],
        "override-mapping": [
            "--annotation-id", "ann-001",
            "--file", "templates/x.tex",
            "--lines", "10:20",
        ],
        "set-status": [
            "--annotation-id", "ann-001",
            "--status", "accepted",
        ],
        "append-chat": [
            "--annotation-id", "ann-001",
            "--role", "user",
            "--text-file", str(tmp_project / "turn.txt"),
        ],
        "record-proposal": [
            "--annotation-id", "ann-001",
            "--text-file", str(tmp_project / "draft.tex"),
        ],
        "commit-phase": ["--phase", "1"],
        "wait-event": [],
        "migrate-state": ["--from", "1", "--to", "1"],
    }
    argv = [
        "--project-dir", str(tmp_project),
        subcommand,
        *args_by_cmd[subcommand],
    ]
    with pytest.raises(NotImplementedError, match=f"subcommand {subcommand}"):
        cli.main(argv)


def test_print_json_writes_single_line(capsys: pytest.CaptureFixture):
    """print_json writes a single newline-terminated JSON object to stdout."""
    cli.print_json({"ok": True, "count": 3})
    out = capsys.readouterr().out
    assert out.endswith("\n")
    parsed = json.loads(out.strip())
    assert parsed == {"ok": True, "count": 3}


def test_print_json_serializes_sort_keys(capsys: pytest.CaptureFixture):
    """print_json output is stable: keys are sorted for diffability."""
    cli.print_json({"z": 1, "a": 2})
    out = capsys.readouterr().out.strip()
    assert out == '{"a": 2, "z": 1}'


def test_status_subcommand_with_json_flag_still_raises(tmp_project: Path):
    """`--json status` propagates through to the stub (not yet implemented)."""
    with pytest.raises(NotImplementedError, match="subcommand status"):
        cli.main(["--project-dir", str(tmp_project), "--json", "status"])
