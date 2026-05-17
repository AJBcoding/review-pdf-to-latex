"""Phase commit orchestrator. Sole writer of state.json.phase and sole
executor of `git commit`.

Implements spec §8 (commit-phase row), §13.1 (clean-state precondition),
§13.2 (commit message template), §13.3 (gitignore policy).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Iterable

from .state import (
    LegacyStateError,
    SourcePdfChangedError,
    StateDir,
    assert_source_pdf_unchanged,
    atomic_write_json,
)


class CommitError(Exception):
    exit_code: int = 1


class DirtyGitError(CommitError):
    exit_code = 15


class CommitFailedError(CommitError):
    exit_code = 19


class IllegalPhaseError(CommitError):
    exit_code = 1


class SourcePdfChangedCommitError(CommitError):
    """Wraps state.SourcePdfChangedError; commit-phase refuses to proceed."""

    exit_code = 21


class LegacyStateCommitError(CommitError):
    """Wraps state.LegacyStateError; commit-phase refuses to proceed."""

    exit_code = 22


def assert_clean_git(project_root: Path, current_phase: str) -> None:
    """Spec §13.1: in phase 0-setup, refuse to proceed if git status is dirty.

    After Phase 0 the engine has been editing .tex files, so dirty state is
    expected and the check is skipped.

    Raises:
        DirtyGitError (exit 15): porcelain status non-empty AND phase == 0-setup.
    """
    if current_phase != "0-setup":
        return
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise DirtyGitError(
            f"`git status` failed in {project_root}: {result.stderr.strip()}"
        )
    if result.stdout.strip():
        raise DirtyGitError(
            "dirty git state in project root; commit or stash before phase 0:\n"
            + result.stdout
        )
