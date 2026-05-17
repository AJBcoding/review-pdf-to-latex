"""Shared pytest fixtures for the review-pdf-to-latex test suite."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


@pytest.fixture
def tmp_project(tmp_path: Path) -> Path:
    """A fresh temp directory simulating a LaTeX project root.

    The directory contains an empty ``.review-state/`` subdir, matching the
    invariant established by ``review-pdf extract`` in production (spec §7).
    Tests that need pre-seeded state files should write into this directory.
    """
    state_dir = tmp_path / ".review-state"
    state_dir.mkdir()
    return tmp_path


@pytest.fixture
def skill_path() -> Path:
    """Resolve the SKILL.md location (env-overridable for CI)."""
    default = Path.home() / ".claude" / "skills" / "review-pdf-to-latex" / "SKILL.md"
    return Path(os.environ.get("SKILL_PATH", str(default)))


@pytest.fixture
def skill_text(skill_path: Path) -> str:
    if not skill_path.exists():
        pytest.skip(f"SKILL.md not found at {skill_path}")
    return skill_path.read_text(encoding="utf-8")


@pytest.fixture
def minimal_project(tmp_path: Path) -> Path:
    """Create the smallest possible .review-state/ that server tests need.

    Layout:
      <tmp>/project/
        main.tex
        .review-state/
          state.json
          mapping.json
          pages/page-1.png    (a PNG-magic file; content irrelevant for routing tests)
          builds/build-001/page-1.png

    state.json carries phase 2a-ratify, one annotation ann-001 in status applied.
    """
    project = tmp_path / "project"
    state_dir = project / ".review-state"
    pages = state_dir / "pages"
    build_dir = state_dir / "builds" / "build-001"
    pages.mkdir(parents=True)
    build_dir.mkdir(parents=True)
    (project / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n"
    )
    (pages / "page-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (build_dir / "page-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    state = {
        "schema_version": 1,
        "phase": "2a-ratify",
        "order": "mechanical-first",
        "current_annotation_id": "ann-001",
        "annotations": {
            "ann-001": {
                "status": "applied",
                "before_text": "old",
                "proposed_text": "new",
                "applied_text": "new",
                "applied_at": "2026-05-16T20:45:12Z",
                "last_build_id": "build-001",
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            }
        },
        "builds": [
            {
                "id": "build-001",
                "pdf_path": ".review-state/builds/build-001.pdf",
                "page_count": 1,
                "compiled_at": "2026-05-16T20:46:00Z",
                "log_path": ".review-state/builds/build-001.log",
                "ok": True,
                "page_md5": ["d41d8cd98f00b204e9800998ecf8427e"],
            }
        ],
    }
    (state_dir / "state.json").write_text(json.dumps(state, indent=2, sort_keys=True))
    (state_dir / "annotations.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source_pdf": "/dev/null/source.pdf",
                "source_pdf_md5": "d41d8cd98f00b204e9800998ecf8427e",
                "extracted_at": "2026-05-16T20:40:00Z",
                "extractor": "pdfannots-test",
                "annotations": [
                    {
                        "id": "ann-001",
                        "page": 1,
                        "bbox": [72.0, 510.5, 540.0, 542.5],
                        "highlighted_text": "old",
                        "author": "anonymous",
                        "comment": "Tighten this",
                        "created": "2026-05-16T20:30:00Z",
                        "trigger_match": False,
                    }
                ],
            },
            indent=2,
            sort_keys=True,
        )
    )
    (state_dir / "mapping.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mappings": {
                    "ann-001": {
                        "latex_file": "main.tex",
                        "line_range": [1, 4],
                        "method": "fuzzy",
                        "confidence": 0.91,
                        "needs_review": False,
                        "candidates": [],
                    }
                },
            },
            indent=2,
            sort_keys=True,
        )
    )
    return project
