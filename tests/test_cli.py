"""Tests for review_pdf_to_latex.cli — argparse router and subcommand dispatch."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from review_pdf_to_latex import cli


pdflatex = pytest.mark.skipif(
    shutil.which("pdflatex") is None,
    reason="pdflatex not on PATH",
)
pdftoppm = pytest.mark.skipif(
    shutil.which("pdftoppm") is None,
    reason="pdftoppm not on PATH",
)


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


# Subcommands whose handlers are wired (no longer raise NotImplementedError).
# Stubs remaining in cli.py are the Wave-3 set (apply, revert, preview,
# commit-phase, set-status, append-chat, record-proposal, override-mapping).
_WIRED_SUBCOMMANDS = frozenset(
    {
        "extract",
        "serve",
        "build",
        "status",
        "wait-event",
        "migrate-state",
    }
)


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


@pytest.mark.parametrize(
    "subcommand", [s for s in ALL_SUBCOMMANDS if s not in _WIRED_SUBCOMMANDS]
)
def test_subcommand_stub_raises_not_implemented(
    subcommand: str, tmp_project: Path
):
    """Wave-3 subcommand stubs still raise NotImplementedError until implemented.

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


def test_apply_subcommand_with_json_flag_still_raises(tmp_project: Path):
    """`--json apply` propagates through to a Wave-3 stub (not yet implemented)."""
    draft = tmp_project / "draft.tex"
    draft.write_text("hello", encoding="utf-8")
    with pytest.raises(NotImplementedError, match="subcommand apply"):
        cli.main(
            [
                "--project-dir",
                str(tmp_project),
                "--json",
                "apply",
                "--annotation-id",
                "ann-001",
                "--new-text-file",
                str(draft),
            ]
        )


@pdflatex
@pdftoppm
def test_cli_build_subcommand_end_to_end(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    (project / "build").mkdir(parents=True)
    main = project / "build" / "full_report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
hi
\end{document}
""",
        encoding="utf-8",
    )
    state_dir = project / ".review-state"
    (state_dir / "builds").mkdir(parents=True)
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "review_pdf_to_latex",
            "--project-dir",
            str(project),
            "build",
            "--quiet",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert len(state["builds"]) == 1
    assert state["builds"][0]["ok"] is True


@pdflatex
@pdftoppm
def test_cli_build_benchmark_emits_timing(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    (project / "build").mkdir(parents=True)
    main = project / "build" / "full_report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
hi
\end{document}
""",
        encoding="utf-8",
    )
    state_dir = project / ".review-state"
    state_dir.mkdir()
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "review_pdf_to_latex",
            "--project-dir",
            str(project),
            "build",
            "--quiet",
            "--benchmark",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "Compile took" in result.stderr


def test_exit_code_constants_match_spec():
    """Module-level exit-code constants match spec §8 verbatim.

    The CLI surface table in spec §8 documents these codes as the
    contract between the engine and the skill. Renaming or renumbering
    breaks the skill; this test pins them.
    """
    assert cli.EXIT_OK == 0
    assert cli.EXIT_MISSING_PDF == 2
    assert cli.EXIT_EXISTING_STATE == 3
    assert cli.EXIT_PDFANNOTS_FAILED == 4
    assert cli.EXIT_PORT_UNAVAILABLE == 5
    assert cli.EXIT_STATE_MISSING == 6
    assert cli.EXIT_ANNOTATION_NOT_FOUND == 7
    assert cli.EXIT_MAPPING_UNRESOLVED == 8
    assert cli.EXIT_FILE_MUTATION_FAILED == 9
    assert cli.EXIT_NO_PRIOR_APPLY == 10
    assert cli.EXIT_BUILD_FAILED == 11
    assert cli.EXIT_MAIN_FILE_NOT_FOUND == 12
    assert cli.EXIT_INVALID_LINE_RANGE == 13
    assert cli.EXIT_UNSUPPORTED_MIGRATION == 14
    assert cli.EXIT_DIRTY_GIT_STATE == 15
    assert cli.EXIT_OVERLAPPING_LINE_RANGE == 16
    assert cli.EXIT_RESTORE_FAILED == 17
    assert cli.EXIT_ILLEGAL_STATUS_TRANSITION == 18
    assert cli.EXIT_COMMIT_FAILED == 19
    assert cli.EXIT_WAIT_TIMEOUT == 20
    assert cli.EXIT_SOURCE_PDF_CHANGED == 21
    assert cli.EXIT_LEGACY_STATE == 22
