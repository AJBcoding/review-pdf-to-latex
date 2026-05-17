"""Tests for review_pdf_to_latex.commit."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex.commit import (
    DirtyGitError,
    assert_clean_git,
)


def _git(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git("init", "-q", cwd=repo)
    _git("config", "user.email", "test@example.com", cwd=repo)
    _git("config", "user.name", "Test", cwd=repo)
    (repo / "README").write_text("hello\n", encoding="utf-8")
    _git("add", "README", cwd=repo)
    _git("commit", "-q", "-m", "init", cwd=repo)
    return repo


def test_assert_clean_git_passes_on_clean_repo_phase_0(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    # Should not raise.
    assert_clean_git(project_root=repo, current_phase="0-setup")


def test_assert_clean_git_raises_on_dirty_repo_phase_0(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    (repo / "dirty.txt").write_text("uncommitted\n", encoding="utf-8")
    with pytest.raises(DirtyGitError):
        assert_clean_git(project_root=repo, current_phase="0-setup")


def test_assert_clean_git_tolerates_dirty_after_phase_0(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    (repo / "dirty.txt").write_text("expected, the engine has been editing\n", encoding="utf-8")
    # In any phase past 0-setup, dirty state is expected — must not raise.
    for phase in ("1-batch", "2a-ratify", "2b-surface", "3-final"):
        assert_clean_git(project_root=repo, current_phase=phase)
