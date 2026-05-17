"""Integration tests for the `extract` CLI subcommand."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from review_pdf_to_latex import cli


FIXTURE_PDF = Path(__file__).parent / "fixtures" / "sample-annotated.pdf"


def _make_minimal_project(root: Path) -> None:
    """Create a project with one .tex file whose contents are unrelated to the PDF."""
    (root / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nplaceholder.\n\\end{document}\n",
        encoding="utf-8",
    )


def test_extract_happy_path(tmp_path: Path) -> None:
    """`extract` writes annotations.json, mapping.json, state.json, and pages/."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    exit_code = cli.main(
        [
            "--project-dir",
            str(project),
            "extract",
            "--pdf",
            str(FIXTURE_PDF),
        ]
    )

    assert exit_code == 0, f"extract exited {exit_code}"

    state_dir = project / ".review-state"
    annotations_path = state_dir / "annotations.json"
    mapping_path = state_dir / "mapping.json"
    state_path = state_dir / "state.json"
    pages_dir = state_dir / "pages"

    assert annotations_path.exists(), "annotations.json missing"
    assert mapping_path.exists(), "mapping.json missing"
    assert state_path.exists(), "state.json missing"
    assert pages_dir.is_dir(), "pages/ missing"
    assert any(pages_dir.glob("page-*.png")), "no page PNGs written"

    # Top-level shapes.
    annotations = json.loads(annotations_path.read_text(encoding="utf-8"))
    assert annotations["schema_version"] == 1
    assert "annotations" in annotations and isinstance(annotations["annotations"], list)
    assert annotations["source_pdf"] == str(FIXTURE_PDF.resolve())
    assert annotations["source_pdf_md5"] == hashlib.md5(
        FIXTURE_PDF.read_bytes()
    ).hexdigest()
    assert annotations["extractor"].startswith("pdfannots-")

    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    assert mapping["schema_version"] == 1
    assert "mappings" in mapping and isinstance(mapping["mappings"], dict)

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["schema_version"] == 1
    assert state["phase"] == "0-setup"
    assert state["order"] == "mechanical-first"
    assert state["current_annotation_id"] is None
    assert state["builds"] == []
    assert isinstance(state["annotations"], dict)
    # IDs in state == IDs in annotations.json.
    assert set(state["annotations"].keys()) == {
        a["id"] for a in annotations["annotations"]
    }


def test_extract_patches_gitignore(tmp_path: Path) -> None:
    """`extract` adds .review-state/ to .gitignore."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    exit_code = cli.main(
        ["--project-dir", str(project), "extract", "--pdf", str(FIXTURE_PDF)]
    )
    assert exit_code == 0

    gi = project / ".gitignore"
    assert gi.exists()
    assert ".review-state/" in gi.read_text(encoding="utf-8").splitlines()


def test_extract_refuses_existing_state_without_force(tmp_path: Path) -> None:
    """A second `extract` without --force exits 3 and does not overwrite."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    first = cli.main(
        ["--project-dir", str(project), "extract", "--pdf", str(FIXTURE_PDF)]
    )
    assert first == 0

    state_path = project / ".review-state" / "state.json"
    original = state_path.read_text(encoding="utf-8")

    second = cli.main(
        ["--project-dir", str(project), "extract", "--pdf", str(FIXTURE_PDF)]
    )
    assert second == 3, f"expected exit code 3, got {second}"
    assert state_path.read_text(encoding="utf-8") == original, (
        "extract overwrote state.json without --force"
    )


def test_extract_with_force_overwrites(tmp_path: Path) -> None:
    """`extract --force` re-runs even when state files exist."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    assert (
        cli.main(["--project-dir", str(project), "extract", "--pdf", str(FIXTURE_PDF)])
        == 0
    )
    assert (
        cli.main(
            [
                "--project-dir",
                str(project),
                "extract",
                "--pdf",
                str(FIXTURE_PDF),
                "--force",
            ]
        )
        == 0
    )


def test_extract_missing_pdf_exits_2(tmp_path: Path) -> None:
    """A nonexistent --pdf path exits 2."""
    project = tmp_path / "proj"
    project.mkdir()

    bogus = tmp_path / "does-not-exist.pdf"
    exit_code = cli.main(
        ["--project-dir", str(project), "extract", "--pdf", str(bogus)]
    )
    assert exit_code == 2


def test_extract_pdfannots_failure_exits_4(tmp_path: Path) -> None:
    """A file that exists but isn't a parseable PDF exits 4."""
    project = tmp_path / "proj"
    project.mkdir()

    fake = tmp_path / "fake.pdf"
    fake.write_bytes(b"not a pdf at all")

    exit_code = cli.main(
        ["--project-dir", str(project), "extract", "--pdf", str(fake)]
    )
    assert exit_code == 4
