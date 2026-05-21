"""Skill file structural tests — round-based processor (M7, bd rev-ek3).

The legacy 4-phase tests were retired with the rewrite; they pinned content
tracked for removal in bd rev-y0r. New tests pin the round-based flow per
UX spec §10.1 step 5, §10.2, §10.5.2, §10.6.
"""

from pathlib import Path

import pytest


def _parse_frontmatter(text: str) -> dict:
    """Minimal YAML frontmatter parser for the skill file (key: value pairs only)."""
    if not text.startswith("---\n"):
        raise ValueError("missing opening YAML fence")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError("missing closing YAML fence")
    block = text[4:end]
    out: dict[str, str] = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"non key:value line in frontmatter: {line!r}")
        key, value = line.split(":", 1)
        out[key.strip()] = value.strip()
    return out


def test_skill_file_exists(skill_path: Path) -> None:
    assert skill_path.exists(), f"SKILL.md missing at {skill_path}"


def test_skill_has_frontmatter_name_and_description(skill_text: str) -> None:
    fm = _parse_frontmatter(skill_text)
    assert fm.get("name") == "review-pdf-to-latex"
    desc = fm.get("description", "")
    assert len(desc) >= 60, "description too short to be useful at skill-selection time"
    # The new description names the round-based entry points.
    assert "/review-pdf process" in desc or "review-pdf process" in desc


def test_skill_overview_sections_present(skill_text: str) -> None:
    """The round-based processor must declare its activation and engine surface."""
    required = [
        "## When to invoke this skill",
        "## What the engine is",
        "## Round-based processor",
    ]
    for heading in required:
        assert heading in skill_text, f"missing section: {heading}"


def test_skill_activation_names_round_based_entry_points(skill_text: str) -> None:
    """Activation must explicitly cover both round-based commands."""
    assert "/review-pdf process" in skill_text
    assert "/review-pdf redraft" in skill_text
    # Submit-file driven, not viewer-driven:
    assert "submit-" in skill_text or "submit file" in skill_text.lower()


def test_skill_calls_only_engine_atomics_not_legacy_phase_commands(skill_text: str) -> None:
    """The four engine atomics must appear; legacy 4-phase commands must NOT."""
    for atomic in ("review-pdf apply", "review-pdf build", "review-pdf revert", "review-pdf preview"):
        assert atomic in skill_text, f"missing atomic call: {atomic}"
    # The skill must explicitly disclaim the legacy commands.
    assert "commit-phase" in skill_text, "expected an explicit 'do NOT call commit-phase' note"
    # And the disclaimer must be a 'do not' line, not a recipe.
    assert "Do NOT call `review-pdf commit-phase`" in skill_text or \
        "Do NOT call review-pdf commit-phase" in skill_text


def test_skill_reviewer_rig_guard_section(skill_text: str) -> None:
    """Reviewer-rig no-mutate branch must be load-bearing per spec §10.5.2 / §10.5.3."""
    assert "Reviewer-rig" in skill_text or "Reviewer rig" in skill_text
    # Both probe paths required:
    assert "gt whoami" in skill_text
    assert "destination_rig" in skill_text
    # L1/L2 must route to needs-followup, L3 must stay conversational.
    assert "needs-followup" in skill_text
    assert "no source access in this rig" in skill_text
    # The spec cite anchors the contract.
    assert "§10.5.2" in skill_text


def test_skill_processing_order_prompt(skill_text: str) -> None:
    """Easy-first (default) vs surface-first must be the prompt shape per §10.1 step 5."""
    assert "easy-first" in skill_text
    assert "surface-first" in skill_text
    # The chosen order must be recorded in the results file for resume.
    assert "processing_order" in skill_text


def test_skill_per_comment_loop_handles_build_failure(skill_text: str) -> None:
    """Apply → build → on failure revert + build_failed (UX spec §10.1 step 5)."""
    # The dashed status from the results-file enum (§10.3):
    assert "build_failed" in skill_text
    # The revert call with --failure-log must appear:
    assert "review-pdf revert" in skill_text
    assert "--failure-log" in skill_text
    # The build error must land in agent_note:
    assert "agent_note" in skill_text


def test_skill_l3_pause_and_interrupt(skill_text: str) -> None:
    """L3 conversational pass + graceful mid-L3 interrupt (§10.1 step 5)."""
    assert "L3" in skill_text
    # Sequential in document order:
    assert "document order" in skill_text
    # Interrupt → partial results with in_progress + deferred remainders.
    assert "interrupt" in skill_text.lower()
    assert "round_status: in_progress" in skill_text or '"round_status": "in_progress"' in skill_text
    assert "deferred" in skill_text


def test_skill_results_file_atomic_append(skill_text: str) -> None:
    """Per-comment atomic append to .review-state/results-<submit_id>.json (§10.3)."""
    assert "results-" in skill_text and "submit_id" in skill_text
    # Atomic protocol: tmp + fsync + rename. The file-write pattern matters.
    assert "fsync" in skill_text
    assert "rename" in skill_text
    # Results enum surfaces explicitly:
    for status in ("applied", "deferred", "needs-followup", "rejected", "build_failed"):
        assert status in skill_text, f"missing results-file status: {status}"


def test_skill_resume_skips_terminals(skill_text: str) -> None:
    """Resume re-invocation must skip already-terminal comments (§10.3)."""
    assert "resume" in skill_text.lower()
    # The order is read back from results, not re-prompted.
    assert "processing_order" in skill_text
    # Round-resume progress marker is the visible signal.
    assert "round_resume" in skill_text


def test_skill_structured_progress_markers(skill_text: str) -> None:
    """Skill emits structured progress markers for the §9.2.7 β strip."""
    assert "::review-pdf:progress::" in skill_text
    # The events the strip parses:
    for event in ("round_start", "comment_start", "comment_done", "round_done"):
        assert event in skill_text, f"missing progress event: {event}"


def test_skill_version_bump_section(skill_text: str) -> None:
    """Round-end version bump per §10.6 — minor/major/custom + collision + implicit v1.0."""
    # The three modes:
    assert "minor" in skill_text and "major" in skill_text and "custom" in skill_text
    # Custom validation regex form:
    assert "\\d+\\.\\d+" in skill_text or r"^\d+\.\d+$" in skill_text
    # Collision bumps until free:
    assert "collision" in skill_text.lower() or "already exists" in skill_text.lower()
    # Implicit v1.0 for no-version inputs:
    assert "v1.0" in skill_text or "1.0" in skill_text


def test_skill_single_commit_at_round_end(skill_text: str) -> None:
    """One git commit per round, fired only on round_status: complete (§10.6)."""
    assert "git commit" in skill_text
    # Commit message shape — the §10.6 boilerplate header line.
    assert "review-pdf: round" in skill_text
    assert "Applied (N)" in skill_text
    assert "Version:" in skill_text
    # No commit while in_progress.
    assert "in_progress" in skill_text


def test_skill_redraft_mode_is_non_mutating(skill_text: str) -> None:
    """/review-pdf redraft must be non-mutating per §10.2."""
    assert "/review-pdf redraft" in skill_text
    assert "live-redraft" in skill_text
    assert "redraft_suggestion" in skill_text
    # preview is the speculative path the redraft mode uses.
    assert "review-pdf preview" in skill_text
    # No apply, no build, no commit in redraft.
    assert "No `apply`" in skill_text or "no apply" in skill_text.lower()


def test_skill_forbidden_moves_section(skill_text: str) -> None:
    """The skill must enumerate forbidden moves explicitly."""
    # The classic state-file invariant from the engine:
    assert "state.json" in skill_text
    # And the explicit 'engine is the sole writer' reminder.
    assert "sole writer" in skill_text.lower() or "engine is the sole" in skill_text.lower()
