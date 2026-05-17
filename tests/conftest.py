"""Shared pytest fixtures for the review-pdf-to-latex test suite."""

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
