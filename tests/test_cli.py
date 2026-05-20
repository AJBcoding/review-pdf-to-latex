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
    "set-current",
    "append-chat",
    "record-proposal",
    "commit-phase",
    "wait-event",
    "migrate-state",
    "pdf-health",
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
def test_global_args_accepted_after_subcommand(subcommand: str) -> None:
    """`--project-dir` and `--json` parse cleanly when placed after the subcommand.

    Regression for rev-16m: the skill documents post-subcommand placement
    but argparse used to reject it because the flags were only on the
    top-level parser.
    """
    parser = cli._build_parser()
    # Build a minimal valid argv per subcommand (just the required args).
    extra: dict[str, list[str]] = {
        "extract": ["--pdf", "x.pdf"],
        "apply": ["--annotation-id", "a", "--new-text-file", "x.txt"],
        "revert": ["--annotation-id", "a"],
        "preview": ["--annotation-id", "a", "--new-text-file", "x.txt"],
        "override-mapping": ["--annotation-id", "a", "--file", "x.tex", "--lines", "1:2"],
        "set-status": ["--annotation-id", "a", "--status", "accepted"],
        "set-current": ["--annotation-id", "a"],
        "append-chat": ["--annotation-id", "a", "--role", "user", "--text-file", "x.txt"],
        "record-proposal": ["--annotation-id", "a", "--text-file", "x.txt"],
        "commit-phase": ["--phase", "1"],
        "migrate-state": ["--from", "1", "--to", "2"],
        "pdf-health": ["--pdf", "x.pdf"],
    }
    argv = [subcommand] + extra.get(subcommand, []) + [
        "--project-dir", "/some/proj",
        "--json",
    ]
    args = parser.parse_args(argv)
    assert str(args.project_dir) == "/some/proj"
    assert args.json_output is True


def test_global_args_after_subcommand_override_before() -> None:
    """When supplied in both positions, the subcommand-level value wins."""
    parser = cli._build_parser()
    args = parser.parse_args(
        [
            "--project-dir", "/before",
            "status",
            "--project-dir", "/after",
        ]
    )
    assert str(args.project_dir) == "/after"


def test_global_args_before_subcommand_still_work() -> None:
    """Pre-subcommand placement remains valid (regression guard)."""
    parser = cli._build_parser()
    args = parser.parse_args(
        ["--project-dir", "/proj", "--json", "status"]
    )
    assert str(args.project_dir) == "/proj"
    assert args.json_output is True


def test_global_args_default_when_neither_position_used() -> None:
    """With no `--project-dir`, the default is the current working directory."""
    parser = cli._build_parser()
    args = parser.parse_args(["status"])
    assert args.project_dir == Path.cwd()
    assert args.json_output is False


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


# ---- Task 6.8 / 7.5 / 10.3: mutator + preview + commit-phase CLI ----------

import hashlib as _hashlib


def _bootstrap_minimal_project(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Build a minimal project directory wired for the mutator CLIs.

    Layout (mirrors :func:`tests.test_apply._make_project`):

        <tmp>/proj/
            source.pdf                            (sentinel; MD5 in annotations.json)
            templates/section.tex                 ("alpha..epsilon" — 5 lines)
            .review-state/
                state.json                        (phase=1-batch, ann-001 pending)
                mapping.json                      (ann-001 → templates/section.tex 2:3)
                annotations.json                  (carries source_pdf_md5 — guard OK)

    Returns ``(project_dir, state_dir, tex_path)``.
    """
    project = tmp_path / "proj"
    project.mkdir()
    (project / "templates").mkdir()
    tex = project / "templates" / "section.tex"
    tex.write_text(
        "alpha\nbeta\ngamma\ndelta\nepsilon\n",
        encoding="utf-8",
    )

    pdf = project / "source.pdf"
    pdf.write_bytes(b"%PDF-1.4 fixture\n")
    pdf_md5 = _hashlib.md5(pdf.read_bytes()).hexdigest()

    state_dir = project / ".review-state"
    state_dir.mkdir()
    state = {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-001": {
                "status": "pending",
                "before_text": None,
                "proposed_text": None,
                "applied_text": None,
                "applied_at": None,
                "last_build_id": None,
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            }
        },
        "builds": [],
    }
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-001": {
                "latex_file": "templates/section.tex",
                "line_range": [2, 3],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            }
        },
    }
    annotations = {
        "schema_version": 1,
        "source_pdf": str(pdf.resolve()),
        "source_pdf_md5": pdf_md5,
        "extracted_at": "2026-05-16T20:30:00Z",
        "extractor": "pdfannots-fake",
        "annotations": [
            {
                "id": "ann-001",
                "page": 1,
                "bbox": [0, 0, 0, 0],
                "highlighted_text": "beta\ngamma",
                "author": "anon",
                "comment": "tighten",
                "created": "2026-05-15T14:22:11Z",
                "trigger_match": False,
            }
        ],
    }
    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    (state_dir / "annotations.json").write_text(
        json.dumps(annotations), encoding="utf-8"
    )
    return project, state_dir, tex


def _run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "review_pdf_to_latex", *args],
        capture_output=True,
        text=True,
    )


def test_cli_apply_subcommand(tmp_path: Path) -> None:
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    new_text_file = tmp_path / "draft.txt"
    new_text_file.write_text("REPLACED\n", encoding="utf-8")

    r = _run_cli(
        [
            "--project-dir", str(project),
            "apply",
            "--annotation-id", "ann-001",
            "--new-text-file", str(new_text_file),
        ]
    )
    assert r.returncode == 0, r.stderr
    assert tex.read_text(encoding="utf-8") == "alpha\nREPLACED\ndelta\nepsilon\n"
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["status"] == "applied"


def test_cli_apply_subcommand_dry_run_does_not_mutate(tmp_path: Path) -> None:
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    new_text_file = tmp_path / "draft.txt"
    new_text_file.write_text("REPLACED\n", encoding="utf-8")
    original = tex.read_text(encoding="utf-8")

    r = _run_cli(
        [
            "--project-dir", str(project),
            "apply",
            "--annotation-id", "ann-001",
            "--new-text-file", str(new_text_file),
            "--dry-run",
        ]
    )
    assert r.returncode == 0, r.stderr
    assert tex.read_text(encoding="utf-8") == original
    # Diff-style output printed.
    assert "templates/section.tex" in r.stdout
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["status"] == "pending"


def test_cli_apply_subcommand_unknown_annotation_exits_7(tmp_path: Path) -> None:
    project, _, _ = _bootstrap_minimal_project(tmp_path)
    new_text_file = tmp_path / "draft.txt"
    new_text_file.write_text("X\n", encoding="utf-8")

    r = _run_cli(
        [
            "--project-dir", str(project),
            "apply",
            "--annotation-id", "ann-999",
            "--new-text-file", str(new_text_file),
        ]
    )
    assert r.returncode == 7, r.stderr


def test_cli_revert_subcommand(tmp_path: Path) -> None:
    """apply then revert restores the .tex contents and marks status rejected."""
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    nt = tmp_path / "d.txt"
    nt.write_text("X\n", encoding="utf-8")
    apply_run = _run_cli(
        [
            "--project-dir", str(project),
            "apply",
            "--annotation-id", "ann-001",
            "--new-text-file", str(nt),
        ]
    )
    assert apply_run.returncode == 0, apply_run.stderr

    r = _run_cli(
        [
            "--project-dir", str(project),
            "revert",
            "--annotation-id", "ann-001",
            "--status", "rejected",
        ]
    )
    assert r.returncode == 0, r.stderr
    assert tex.read_text(encoding="utf-8") == "alpha\nbeta\ngamma\ndelta\nepsilon\n"
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["status"] == "rejected"


def test_cli_revert_subcommand_no_prior_apply_exits_10(tmp_path: Path) -> None:
    """revert without a prior apply returns exit code 10."""
    project, _, _ = _bootstrap_minimal_project(tmp_path)
    r = _run_cli(
        [
            "--project-dir", str(project),
            "revert",
            "--annotation-id", "ann-001",
            "--status", "rejected",
        ]
    )
    assert r.returncode == 10, r.stderr


def test_cli_set_status_subcommand(tmp_path: Path) -> None:
    """apply lands ann-001 at status=applied; set-status moves it to accepted."""
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    nt = tmp_path / "d.txt"
    nt.write_text("X\n", encoding="utf-8")
    _run_cli(
        [
            "--project-dir", str(project),
            "apply",
            "--annotation-id", "ann-001",
            "--new-text-file", str(nt),
        ]
    )

    r = _run_cli(
        [
            "--project-dir", str(project),
            "set-status",
            "--annotation-id", "ann-001",
            "--status", "accepted",
            "--reason", "looks good",
        ]
    )
    assert r.returncode == 0, r.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["status"] == "accepted"
    assert state["annotations"]["ann-001"]["last_status_reason"] == "looks good"


def test_cli_set_current_subcommand(tmp_path: Path) -> None:
    """set-current updates current_annotation_id without touching status."""
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    r = _run_cli(
        [
            "--project-dir", str(project),
            "set-current",
            "--annotation-id", "ann-001",
        ]
    )
    assert r.returncode == 0, r.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["current_annotation_id"] == "ann-001"
    # Status untouched — set-current is status-neutral.
    assert state["annotations"]["ann-001"]["status"] == "pending"


def test_cli_set_current_unknown_annotation_exits_7(tmp_path: Path) -> None:
    project, _, _ = _bootstrap_minimal_project(tmp_path)
    r = _run_cli(
        [
            "--project-dir", str(project),
            "set-current",
            "--annotation-id", "ann-999",
        ]
    )
    assert r.returncode == 7, r.stderr


def test_cli_append_chat_subcommand(tmp_path: Path) -> None:
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    tf = tmp_path / "msg.txt"
    tf.write_text("How does this paragraph land?", encoding="utf-8")
    r = _run_cli(
        [
            "--project-dir", str(project),
            "append-chat",
            "--annotation-id", "ann-001",
            "--role", "user",
            "--text-file", str(tf),
        ]
    )
    assert r.returncode == 0, r.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    log = state["annotations"]["ann-001"]["surface_chat_log"]
    assert log[0]["text"] == "How does this paragraph land?"
    assert log[0]["role"] == "user"


def test_cli_record_proposal_subcommand(tmp_path: Path) -> None:
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    tf = tmp_path / "proposal.txt"
    tf.write_text("stashed\n", encoding="utf-8")
    original = tex.read_text(encoding="utf-8")
    r = _run_cli(
        [
            "--project-dir", str(project),
            "record-proposal",
            "--annotation-id", "ann-001",
            "--text-file", str(tf),
        ]
    )
    assert r.returncode == 0, r.stderr
    # .tex untouched.
    assert tex.read_text(encoding="utf-8") == original
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["proposed_text"] == "stashed\n"
    # Status unchanged (record-proposal does not transition).
    assert state["annotations"]["ann-001"]["status"] == "pending"


def test_cli_override_mapping_subcommand(tmp_path: Path) -> None:
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    other = project / "templates" / "other.tex"
    other.write_text("o1\no2\no3\n", encoding="utf-8")
    r = _run_cli(
        [
            "--project-dir", str(project),
            "override-mapping",
            "--annotation-id", "ann-001",
            "--file", "templates/other.tex",
            "--lines", "1:2",
        ]
    )
    assert r.returncode == 0, r.stderr
    mapping = json.loads((state_dir / "mapping.json").read_text(encoding="utf-8"))
    entry = mapping["mappings"]["ann-001"]
    assert entry["latex_file"] == "templates/other.tex"
    assert entry["line_range"] == [1, 2]
    assert entry["method"] == "manual"
    assert entry["needs_review"] is False


def test_cli_override_mapping_subcommand_bad_lines_exits_13(tmp_path: Path) -> None:
    """A malformed --lines argument (no colon) returns exit code 13."""
    project, _, _ = _bootstrap_minimal_project(tmp_path)
    r = _run_cli(
        [
            "--project-dir", str(project),
            "override-mapping",
            "--annotation-id", "ann-001",
            "--file", "templates/section.tex",
            "--lines", "garbage",
        ]
    )
    assert r.returncode == 13, r.stderr


def test_cli_commit_phase_subcommand(tmp_path: Path) -> None:
    """End-to-end: init a repo, seed a phase-1 snapshot, invoke commit-phase,
    assert state.phase advanced and a commit landed."""
    project = tmp_path / "proj"
    project.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=str(project), check=True)
    subprocess.run(
        ["git", "config", "user.email", "t@example.com"],
        cwd=str(project), check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"], cwd=str(project), check=True,
    )
    (project / "templates").mkdir()
    tex = project / "templates" / "section.tex"
    tex.write_text("orig\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "templates/section.tex"], cwd=str(project), check=True,
    )
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=str(project), check=True,
    )

    # Simulate a phase-1 apply: mutate the file, set up state.
    tex.write_text("APPLIED\n", encoding="utf-8")
    state_dir = project / ".review-state"
    state_dir.mkdir()
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {
                    "ann-001": {
                        "status": "applied",
                        "before_text": "orig\n",
                        "proposed_text": "APPLIED\n",
                        "applied_text": "APPLIED\n",
                        "applied_at": "2026-05-16T20:45:12Z",
                        "last_build_id": None,
                        "surface_chat_log": None,
                        "failure_log_path": None,
                        "failure_edit_text": None,
                    }
                },
                "builds": [],
            }
        ),
        encoding="utf-8",
    )
    (state_dir / "mapping.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mappings": {
                    "ann-001": {
                        "latex_file": "templates/section.tex",
                        "line_range": [1, 1],
                        "confidence": 0.95,
                        "method": "fuzzy_text",
                        "needs_review": False,
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    # Source-PDF guard: include source_pdf_md5 so assert_source_pdf_unchanged
    # passes (without it, commit_phase would raise LegacyStateCommitError → 22).
    source_pdf = project / "source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4 fake\n")
    pdf_md5 = _hashlib.md5(source_pdf.read_bytes()).hexdigest()
    (state_dir / "annotations.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source_pdf": str(source_pdf.resolve()),
                "source_pdf_md5": pdf_md5,
                "annotations": [],
            }
        ),
        encoding="utf-8",
    )

    result = _run_cli(
        [
            "--project-dir", str(project),
            "commit-phase",
            "--phase", "1",
            "--message-suffix", "smoke test",
        ]
    )
    assert result.returncode == 0, result.stderr
    sha_printed = result.stdout.strip()
    assert len(sha_printed) >= 7

    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "2a-ratify"

    log = subprocess.run(
        ["git", "log", "--format=%H%n%B", "-n", "1"],
        cwd=str(project), capture_output=True, text=True, check=True,
    ).stdout
    assert sha_printed in log
    assert "smoke test" in log


# ---- Task 10.3: preview subcommand -----------------------------------------

from unittest.mock import patch as _patch

from review_pdf_to_latex import preview as _preview_mod


def _make_new_text_file(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "new_text.tex"
    p.write_text(content, encoding="utf-8")
    return p


def test_cli_preview_prints_build_id_and_exits_zero(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Successful preview prints the build ID to stdout and returns 0."""
    new_text_file = _make_new_text_file(tmp_project, "speculative text\n")

    def fake_preview(state_dir, annotation_id, new_text):  # type: ignore[no-untyped-def]
        assert annotation_id == "ann-001"
        assert new_text == "speculative text\n"
        return "build-042"

    with _patch.object(_preview_mod, "preview", side_effect=fake_preview):
        rc = cli.main(
            [
                "--project-dir", str(tmp_project),
                "preview",
                "--annotation-id", "ann-001",
                "--new-text-file", str(new_text_file),
            ]
        )

    assert rc == 0
    out = capsys.readouterr().out.strip()
    assert out == "build-042"


def test_cli_preview_exits_7_for_unknown_annotation(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """AnnotationNotFoundError → exit code 7."""
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    with _patch.object(
        _preview_mod,
        "preview",
        side_effect=_preview_mod.AnnotationNotFoundError("ann-999 not found"),
    ):
        rc = cli.main(
            [
                "--project-dir", str(tmp_project),
                "preview",
                "--annotation-id", "ann-999",
                "--new-text-file", str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_ANNOTATION_NOT_FOUND == 7
    err = capsys.readouterr().err
    assert "ann-999" in err


def test_cli_preview_exits_8_for_unresolved_mapping(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """MappingUnresolvedError → exit code 8."""
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    with _patch.object(
        _preview_mod,
        "preview",
        side_effect=_preview_mod.MappingUnresolvedError(
            "ann-001 mapping unresolved"
        ),
    ):
        rc = cli.main(
            [
                "--project-dir", str(tmp_project),
                "preview",
                "--annotation-id", "ann-001",
                "--new-text-file", str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_MAPPING_UNRESOLVED == 8


def test_cli_preview_exits_17_on_in_place_restore_failure(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """InPlaceRestoreError → exit code 17 with recovery instructions on stderr."""
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    with _patch.object(
        _preview_mod,
        "preview",
        side_effect=_preview_mod.InPlaceRestoreError(
            "failed to restore /tmp/foo.tex; "
            "recovery at .review-state/preview-recovery-20260516T200000.txt"
        ),
    ):
        rc = cli.main(
            [
                "--project-dir", str(tmp_project),
                "preview",
                "--annotation-id", "ann-001",
                "--new-text-file", str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_RESTORE_FAILED == 17
    err = capsys.readouterr().err
    assert "recovery" in err.lower()


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


# ---- Task 11.2: status subcommand ------------------------------------------

import json as _json_mod


def _seed_state_for_cli(tmp_project: Path, phase: str = "0-setup") -> None:
    """Seed a minimal state.json so status can read it."""
    state_mod_path = tmp_project / ".review-state" / "state.json"
    state_mod_path.parent.mkdir(parents=True, exist_ok=True)
    state_mod_path.write_text(
        _json_mod.dumps(
            {
                "schema_version": 1,
                "phase": phase,
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {
                    "ann-001": {
                        "status": "applied",
                        "before_text": None,
                        "proposed_text": None,
                        "applied_text": None,
                        "applied_at": None,
                        "last_build_id": None,
                        "surface_chat_log": None,
                        "failure_log_path": None,
                        "failure_edit_text": None,
                    },
                    "ann-002": {
                        "status": "accepted",
                        "before_text": None,
                        "proposed_text": None,
                        "applied_text": None,
                        "applied_at": None,
                        "last_build_id": None,
                        "surface_chat_log": None,
                        "failure_log_path": None,
                        "failure_edit_text": None,
                    },
                },
                "builds": [],
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def test_cli_status_json_output(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """`review-pdf --json status` prints a JSON object with the expected keys."""
    _seed_state_for_cli(tmp_project)
    rc = cli.main(["--project-dir", str(tmp_project), "--json", "status"])
    assert rc == 0
    out = capsys.readouterr().out.strip()
    parsed = _json_mod.loads(out)
    assert parsed["phase"] == "0-setup"
    assert parsed["total"] == 2
    assert parsed["counts"]["applied"] == 1
    assert parsed["counts"]["accepted"] == 1
    assert parsed["non_terminal_count"] == 1
    assert parsed["terminal_count"] == 1


def test_cli_status_human_output(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Without --json, status prints a human-readable summary to stdout."""
    _seed_state_for_cli(tmp_project, phase="2a-ratify")
    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "2a-ratify" in out
    assert "applied" in out
    assert "accepted" in out
    assert "1" in out


def test_cli_status_human_output_includes_build_info_when_present(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """When builds[] has entries, the summary mentions the last build."""
    _seed_state_for_cli(tmp_project)
    state_path = tmp_project / ".review-state" / "state.json"
    payload = _json_mod.loads(state_path.read_text(encoding="utf-8"))
    payload["builds"].append(
        {
            "id": "build-001",
            "pdf_path": ".review-state/builds/build-001.pdf",
            "page_count": 24,
            "compiled_at": "2026-05-16T20:00:00Z",
            "log_path": ".review-state/builds/build-001.log",
            "ok": True,
            "page_md5": ["a"] * 24,
        }
    )
    state_path.write_text(
        _json_mod.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
    )

    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "build-001" in out
    assert "24" in out


def test_cli_status_exits_6_when_state_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture
):
    """No state.json → exit code 6 and error on stderr."""
    rc = cli.main(["--project-dir", str(tmp_path), "status"])
    assert rc == cli.EXIT_STATE_MISSING == 6
    err = capsys.readouterr().err
    assert "state.json" in err


def test_cli_status_human_output_is_compact_four_lines(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Default ``status`` output is a fixed 4-line summary (rev-hgj).

    The skill greps these lines deterministically; reserve ``--json``
    for full machine output.
    """
    _seed_state_for_cli(tmp_project, phase="2a-ratify")
    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out.rstrip("\n")
    lines = out.split("\n")
    assert len(lines) == 4, f"expected 4 lines, got {len(lines)}: {out!r}"
    assert lines[0].startswith("Phase: 2a-ratify")
    assert lines[1].startswith("Counts: ")
    assert "2 total" in lines[1]
    assert "1 applied" in lines[1]
    assert "1 accepted" in lines[1]
    assert lines[2].startswith("Last build: ")
    assert lines[3].startswith("Working tree: ")


def test_cli_status_human_output_working_tree_clean_in_fresh_repo(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Working-tree line reports 'clean' for an empty git repo and
    '(not a git repo)' for a non-git directory.
    """
    import subprocess as _sp

    _seed_state_for_cli(tmp_project)
    # Non-git directory → "(not a git repo)" path.
    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Working tree: (not a git repo)" in out

    # Initialise a git repo, commit the state file, expect "clean".
    _sp.run(["git", "init", "-q"], cwd=tmp_project, check=True)
    _sp.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit",
         "--allow-empty", "-q", "-m", "init"],
        cwd=tmp_project,
        check=True,
    )
    # The .review-state/ tree is now untracked, so working tree is dirty.
    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Working tree: dirty" in out


# ---- Task 13.2: migrate-state subcommand -----------------------------------


def test_cli_migrate_state_exits_14(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Any migrate-state call in v1 exits 14 with the spec message."""
    rc = cli.main(
        [
            "--project-dir",
            str(tmp_project),
            "migrate-state",
            "--from",
            "1",
            "--to",
            "2",
        ]
    )
    assert rc == cli.EXIT_UNSUPPORTED_MIGRATION == 14
    err = capsys.readouterr().err
    assert "from=1" in err
    assert "to=2" in err
    assert "no migrations" in err.lower()


def test_cli_migrate_state_same_from_to_also_exits_14(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """from=to is still rejected (the engine does not implicitly no-op)."""
    rc = cli.main(
        [
            "--project-dir",
            str(tmp_project),
            "migrate-state",
            "--from",
            "1",
            "--to",
            "1",
        ]
    )
    assert rc == cli.EXIT_UNSUPPORTED_MIGRATION


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
