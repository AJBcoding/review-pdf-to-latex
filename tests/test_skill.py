"""Skill file structural tests (Task 14.1)."""

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
    assert "description" in fm and len(fm["description"]) >= 40


def test_skill_overview_sections_present(skill_text: str) -> None:
    required_headings = [
        "# review-pdf-to-latex",
        "## When to invoke this skill",
        "## What the engine is",
        "## The four phases",
    ]
    for heading in required_headings:
        assert heading in skill_text, f"missing heading: {heading}"


def test_skill_phase0_section_present_and_invocations_correct(skill_text: str) -> None:
    assert "## Phase 0 — Setup" in skill_text
    # The exact invocations must appear verbatim:
    assert "review-pdf extract --pdf" in skill_text
    assert "review-pdf serve --project-dir" in skill_text and "--mapping-mode" in skill_text
    # Must instruct Claude to check needs_review before advancing:
    assert "needs_review" in skill_text


def test_skill_phase1_section_present_and_loop_correct(skill_text: str) -> None:
    assert "## Phase 1 — Batch pre-apply" in skill_text
    # Reverse-line-order is the single most important sequencing rule:
    assert "reverse" in skill_text.lower() and "line" in skill_text.lower()
    # The four core CLI calls must each appear:
    for cli in ("review-pdf apply", "review-pdf build", "review-pdf revert", "review-pdf commit-phase --phase 1"):
        assert cli in skill_text, f"missing CLI invocation: {cli}"
    # SURFACE handling: trigger_match annotations are surfaced_pending:
    assert "trigger_match" in skill_text
    assert "surfaced_pending" in skill_text
    # Clean-git precondition mentioned:
    assert "git status" in skill_text or "clean" in skill_text.lower()


def test_skill_phase2a_section_has_wait_event_loop(skill_text: str) -> None:
    assert "## Phase 2a — Ratify" in skill_text
    # The wait-event loop is the heart of the skill:
    assert "review-pdf wait-event" in skill_text
    assert "--timeout 300" in skill_text or "--timeout 60" in skill_text
    # Exit code 20 (timeout) handled:
    assert "20" in skill_text and "timeout" in skill_text.lower()
    # All six action dispatches must appear:
    for action in ("approve", "reject", "redraft", "preview", "skip", "surface"):
        assert action in skill_text.lower(), f"missing action: {action}"
    # commit-phase boundary:
    assert "commit-phase --phase 2a" in skill_text


def test_skill_phase2b_section_present(skill_text: str) -> None:
    assert "## Phase 2b — Surface" in skill_text
    assert "review-pdf append-chat" in skill_text
    assert "surfaced_resolved" in skill_text
    assert "commit-phase --phase 2b" in skill_text


def test_skill_phase3_section_present(skill_text: str) -> None:
    assert "## Phase 3 — Final commit" in skill_text
    assert "review-pdf status --json" in skill_text
    assert "commit-phase --phase 3" in skill_text
    # Must check for non-terminal statuses before commit:
    assert "terminal" in skill_text.lower()
