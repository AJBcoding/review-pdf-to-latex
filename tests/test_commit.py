"""Tests for review_pdf_to_latex.commit."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex.commit import (
    CommitError,
    DirtyGitError,
    IllegalPhaseError,
    assert_clean_git,
    commit_phase,
    next_phase,
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
        "schema_version": 2,
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


@pytest.mark.parametrize(
    "current, expected",
    [
        ("0-setup", "1-batch"),
        ("1-batch", "2a-ratify"),
        ("2a-ratify", "2b-surface"),
        ("2b-surface", "3-final"),
        ("3-final", "3-final"),  # terminal: stays
    ],
)
def test_next_phase_valid_transitions(current: str, expected: str) -> None:
    assert next_phase(current) == expected


def test_next_phase_invalid_phase_raises() -> None:
    with pytest.raises(IllegalPhaseError):
        next_phase("not-a-real-phase")


def _init_project_repo(tmp_path: Path) -> tuple[Path, Path]:
    """Initialize a git repo with a minimal LaTeX project + .review-state/
    populated for phase 1-batch."""
    project = tmp_path / "proj"
    project.mkdir()
    _git("init", "-q", cwd=project)
    _git("config", "user.email", "test@example.com", cwd=project)
    _git("config", "user.name", "Test", cwd=project)
    tex_dir = project / "templates"
    tex_dir.mkdir()
    tex = tex_dir / "section.tex"
    tex.write_text("hello\n", encoding="utf-8")
    _git("add", "templates/section.tex", cwd=project)
    _git("commit", "-q", "-m", "initial latex", cwd=project)

    state_dir = project / ".review-state"
    state_dir.mkdir()
    state = {
        "schema_version": 2,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-001": {
                "status": "applied",
                "before_text": "hello\n",
                "proposed_text": "HELLO\n",
                "applied_text": "HELLO\n",
                "applied_at": "2026-05-16T20:45:12Z",
                "last_build_id": None,
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            }
        },
        "builds": [],
    }
    mapping = {
        "schema_version": 2,
        "mappings": {
            "ann-001": {
                "file": "templates/section.tex",
                "line_range": [1, 1],
                "confidence": 0.95,
                "method": "fuzzy_text",
                "needs_review": False,
            }
        },
    }
    # Source PDF guard: assert_source_pdf_unchanged reads source_pdf +
    # source_pdf_md5 from annotations.json. Create a real file so the
    # md5 check passes.
    source_pdf = project / "source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4 fake test pdf bytes\n")
    pdf_md5 = hashlib.md5(source_pdf.read_bytes()).hexdigest()
    annotations = {
        "schema_version": 2,
        "source_pdf": str(source_pdf.resolve()),
        "source_pdf_md5": pdf_md5,
        "annotations": [],
    }
    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    (state_dir / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")

    # Pretend phase 1 already mutated the tex file.
    tex.write_text("HELLO\n", encoding="utf-8")

    return project, state_dir


def test_commit_phase_advances_phase_and_creates_commit(tmp_path: Path) -> None:
    project, state_dir = _init_project_repo(tmp_path)
    sha = commit_phase(
        state_dir=state_dir,
        phase_arg="1-batch",
        message_suffix="test suffix",
        granularity="phase",
    )
    assert isinstance(sha, str) and len(sha) >= 7

    # state.phase advanced to next.
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "2a-ratify"

    # git log shows the new commit with expected subject and body.
    log = _git("log", "--format=%H%n%B", "-n", "1", cwd=project).stdout
    assert sha in log
    assert "phase 1" in log
    assert "test suffix" in log
    # state files included in the commit.
    files = _git("show", "--stat", "--name-only", "--format=", sha, cwd=project).stdout
    assert "templates/section.tex" in files
    assert ".review-state/state.json" in files


def test_commit_phase_rejects_phase_mismatch(tmp_path: Path) -> None:
    project, state_dir = _init_project_repo(tmp_path)
    # state.json says phase=1-batch; passing phase_arg=2a-ratify is illegal.
    with pytest.raises(CommitError):  # Either IllegalPhaseError or CommitFailedError
        commit_phase(
            state_dir=state_dir,
            phase_arg="2a-ratify",
            message_suffix=None,
            granularity="phase",
        )


def test_commit_phase_succeeds_when_review_state_gitignored(tmp_path: Path) -> None:
    """commit_phase must succeed even when extract wrote .review-state/ to .gitignore.

    Regression for rev-n5: git add without -f exits non-zero for gitignored paths,
    raising CommitFailedError (exit-19) on every extract-bootstrapped project.
    """
    project, state_dir = _init_project_repo(tmp_path)
    # Simulate what `extract` does: add .review-state/ to .gitignore.
    gitignore = project / ".gitignore"
    gitignore.write_text("# review-pdf-to-latex working state\n.review-state/\n", encoding="utf-8")
    _git("add", ".gitignore", cwd=project)
    _git("commit", "-q", "-m", "add gitignore", cwd=project)

    # commit_phase must not raise CommitFailedError despite the gitignore entry.
    sha = commit_phase(
        state_dir=state_dir,
        phase_arg="1-batch",
        message_suffix=None,
        granularity="phase",
    )
    assert isinstance(sha, str) and len(sha) >= 7

    # The state files must appear in the commit even though they were gitignored.
    files = _git("show", "--name-only", "--format=", sha, cwd=project).stdout
    assert ".review-state/state.json" in files
