"""Shared pytest fixtures for the review-pdf-to-latex test suite."""

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
