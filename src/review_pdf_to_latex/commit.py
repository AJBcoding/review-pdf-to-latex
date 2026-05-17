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


# Phase ID to human-friendly suffix used in the commit subject.
_PHASE_LABELS: dict[str, str] = {
    "0-setup": "phase 0 — setup",
    "1-batch": "phase 1 — batch apply",
    "2a-ratify": "phase 2a — ratify",
    "2b-surface": "phase 2b — surface",
    "3-final": "phase 3 — final",
}

# Statuses that count as edits in the commit summary, in display order.
_SUMMARY_STATUSES: list[str] = [
    "applied",
    "accepted",
    "redrafted",
    "rejected",
    "deferred",
    "surfaced_resolved",
    "surfaced_pending",
    "needs_review",
    "pending",
]


def _count_by_status(state: dict) -> dict[str, int]:
    counts: dict[str, int] = {s: 0 for s in _SUMMARY_STATUSES}
    for _ann_id, entry in state.get("annotations", {}).items():
        s = entry.get("status", "pending")
        counts[s] = counts.get(s, 0) + 1
    return counts


def _summary_for_phase(phase: str, counts: dict[str, int]) -> list[str]:
    """Return the body lines (without trailing newline) per spec §13.2."""
    lines: list[str] = []
    # For phase 1 the relevant categories are applied / needs_review;
    # for phase 2a it's accepted / rejected / redrafted / deferred;
    # for phase 2b it's surfaced_resolved / deferred; for phase 3 anything left.
    relevant: list[str]
    if phase == "1-batch":
        relevant = ["applied", "needs_review"]
    elif phase == "2a-ratify":
        relevant = ["accepted", "rejected", "redrafted", "deferred"]
    elif phase == "2b-surface":
        relevant = ["surfaced_resolved", "deferred"]
    elif phase == "3-final":
        relevant = _SUMMARY_STATUSES
    else:
        relevant = _SUMMARY_STATUSES
    for s in relevant:
        n = counts.get(s, 0)
        if n > 0:
            lines.append(f"{s.replace('_', ' ').title().replace(' ', '')}: {n}")
    return lines


def render_commit_message(
    phase: str,
    granularity: str,
    message_suffix: str | None,
    state: dict,
) -> str:
    """Render a commit message per spec §13.2.

    Subject line:
        review-pdf-to-latex: <phase label>[ — <message_suffix>]

    Body:
        - one "<status>: <count>" per relevant status
        - blank line
        - annotation ID listing (first 10 IDs, plus "...and N more")
        - blank line
        - state snapshot pointer (state.json path)

    Args:
        phase: Phase id (the SOURCE phase being committed; e.g., "1-batch").
        granularity: "phase" | "session" | "batch:N" — currently only affects
            the subject line annotation.
        message_suffix: Optional user-supplied project tag (e.g., "COTA v2.0").
        state: The state.json dict to summarize.
    """
    if phase not in _PHASE_LABELS:
        raise IllegalPhaseError(f"unknown phase {phase!r}")
    counts = _count_by_status(state)

    subject = f"review-pdf-to-latex: {_PHASE_LABELS[phase]}"
    if message_suffix:
        subject = f"{subject} — {message_suffix}"

    body_lines = _summary_for_phase(phase, counts)

    annotation_ids = sorted(state.get("annotations", {}).keys())
    if annotation_ids:
        head = annotation_ids[:10]
        more = len(annotation_ids) - len(head)
        listing = "Annotations: " + ", ".join(head)
        if more > 0:
            listing += f", ...and {more} more"
    else:
        listing = "Annotations: (none)"

    parts: list[str] = [subject, ""]
    if body_lines:
        parts.extend(body_lines)
        parts.append("")
    parts.append(listing)
    parts.append("")
    parts.append("State snapshot: .review-state/state.json")
    if granularity != "phase":
        parts.append(f"Granularity: {granularity}")
    return "\n".join(parts) + "\n"


# Spec §7.3: 0-setup → 1-batch → 2a-ratify → 2b-surface → 3-final (terminal).
_PHASE_TRANSITIONS: dict[str, str] = {
    "0-setup": "1-batch",
    "1-batch": "2a-ratify",
    "2a-ratify": "2b-surface",
    "2b-surface": "3-final",
    "3-final": "3-final",  # terminal, idempotent
}


def next_phase(current: str) -> str:
    """Return the phase that follows `current`. Terminal phase 3-final is fixed.

    Raises:
        IllegalPhaseError: if `current` is not a known phase id.
    """
    if current not in _PHASE_TRANSITIONS:
        raise IllegalPhaseError(
            f"unknown phase {current!r}; expected one of {sorted(_PHASE_TRANSITIONS)}"
        )
    return _PHASE_TRANSITIONS[current]


def _files_touched_by_state(state: dict, project_root: Path) -> list[Path]:
    """Best-effort: every .tex file referenced indirectly by annotations with
    a non-null applied_text. For v1 we don't have a reverse index from
    annotation → file in state.json itself (mapping.json owns that), so we
    read mapping.json and collect all latex_file entries whose annotation
    has a status that implies the file was touched."""
    state_dir = project_root / ".review-state"
    mapping_path = state_dir / "mapping.json"
    if not mapping_path.exists():
        return []
    with mapping_path.open("r", encoding="utf-8") as f:
        mapping = json.load(f)
    touched: set[str] = set()
    annotation_states = state.get("annotations", {})
    for ann_id, map_entry in mapping.get("mappings", {}).items():
        ann = annotation_states.get(ann_id, {})
        if ann.get("applied_text") is not None or ann.get("status") in (
            "applied",
            "accepted",
            "redrafted",
            "rejected",  # rejected means we reverted, which is also a write
            "surfaced_resolved",
        ):
            if map_entry.get("latex_file"):
                touched.add(map_entry["latex_file"])
    return [project_root / f for f in sorted(touched)]


def commit_phase(
    state_dir: Path,
    phase_arg: str,
    message_suffix: str | None,
    granularity: str,
) -> str:
    """Render the commit message, stage touched files + all four state files,
    run `git commit`, then advance state.phase. Returns the new commit SHA.

    Spec §8 commit-phase row, §13.

    Args:
        state_dir: Path to .review-state.
        phase_arg: The SOURCE phase being committed; MUST equal state.phase.
        message_suffix: Optional free-form project tag.
        granularity: "phase" | "session" | "batch:N".

    Returns:
        The 40-char hex SHA of the new commit (from `git rev-parse HEAD`).

    Raises:
        IllegalPhaseError (exit 1): phase_arg != state.phase.
        DirtyGitError (exit 15): dirty pre-phase-0 state.
        CommitFailedError (exit 19): git add or git commit failed.
        SourcePdfChangedCommitError (exit 21): PDF md5 mismatch.
        LegacyStateCommitError (exit 22): annotations.json predates the guard.
    """
    state_dir = Path(state_dir)
    project_root = state_dir.parent
    # Spec §14 risk 9: refuse to commit against potentially stale state.
    try:
        assert_source_pdf_unchanged(StateDir(project_root))
    except SourcePdfChangedError as exc:
        raise SourcePdfChangedCommitError(str(exc)) from exc
    except LegacyStateError as exc:
        raise LegacyStateCommitError(str(exc)) from exc
    state_path = state_dir / "state.json"
    with state_path.open("r", encoding="utf-8") as f:
        state = json.load(f)

    current_phase = state.get("phase")
    if phase_arg != current_phase:
        raise IllegalPhaseError(
            f"--phase {phase_arg!r} does not match current state.phase "
            f"{current_phase!r}"
        )

    assert_clean_git(project_root=project_root, current_phase=current_phase)

    message = render_commit_message(
        phase=current_phase,
        granularity=granularity,
        message_suffix=message_suffix,
        state=state,
    )

    # Stage .tex files touched by annotation activity + the four state files.
    to_stage: list[str] = []
    for tex_path in _files_touched_by_state(state, project_root):
        try:
            to_stage.append(str(tex_path.resolve().relative_to(project_root)))
        except ValueError:
            continue
    for state_file in ("state.json", "mapping.json", "annotations.json"):
        p = state_dir / state_file
        if p.exists():
            to_stage.append(str(p.resolve().relative_to(project_root)))
    # Also stage state-events.jsonl if present (audit trail).
    events_path = state_dir / "state-events.jsonl"
    if events_path.exists():
        to_stage.append(str(events_path.resolve().relative_to(project_root)))

    if to_stage:
        add_result = subprocess.run(
            ["git", "add", "--", *to_stage],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            check=False,
        )
        if add_result.returncode != 0:
            raise CommitFailedError(
                f"git add failed: {add_result.stderr.strip()}"
            )

    commit_result = subprocess.run(
        ["git", "commit", "-m", message],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if commit_result.returncode != 0:
        raise CommitFailedError(
            f"git commit failed: {commit_result.stderr.strip() or commit_result.stdout.strip()}"
        )

    sha_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=True,
    )
    sha = sha_result.stdout.strip()

    # Advance phase.
    state["phase"] = next_phase(current_phase)
    atomic_write_json(state_path, state)

    return sha
