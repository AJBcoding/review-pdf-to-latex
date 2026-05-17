"""Tests for review_pdf_to_latex.commit."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex.commit import (
    DirtyGitError,
    assert_clean_git,
    render_commit_message,
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


def _state(annotations: dict[str, dict]) -> dict:
    return {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": annotations,
        "builds": [],
    }


def test_render_commit_message_phase_1(tmp_path: Path) -> None:
    state = _state({
        f"ann-{i:03d}": {"status": "applied"} for i in range(1, 11)
    })
    msg = render_commit_message(
        phase="1-batch",
        granularity="phase",
        message_suffix=None,
        state=state,
    )
    assert "phase 1" in msg
    assert "10" in msg  # 10 applied edits referenced somewhere
    # Annotation IDs appear in the body (truncated or full).
    assert "ann-001" in msg


def test_render_commit_message_phase_2a_with_suffix(tmp_path: Path) -> None:
    anns = {}
    for i in range(1, 63):
        anns[f"ann-{i:03d}"] = {"status": "accepted"}
    for i in range(63, 68):
        anns[f"ann-{i:03d}"] = {"status": "rejected"}
    for i in range(68, 71):
        anns[f"ann-{i:03d}"] = {"status": "redrafted"}
    state = _state(anns)
    msg = render_commit_message(
        phase="2a-ratify",
        granularity="phase",
        message_suffix="COTA Impact Report v2.0",
        state=state,
    )
    assert "phase 2a" in msg
    assert "Accepted: 62" in msg
    assert "Rejected: 5" in msg
    assert "Redrafted: 3" in msg
    assert "COTA Impact Report v2.0" in msg


def test_render_commit_message_phase_3_zero_edits(tmp_path: Path) -> None:
    state = _state({})
    msg = render_commit_message(
        phase="3-final",
        granularity="phase",
        message_suffix=None,
        state=state,
    )
    assert "phase 3" in msg
    # Zero-count edge case must still produce a coherent message.
    assert msg.strip() != ""
