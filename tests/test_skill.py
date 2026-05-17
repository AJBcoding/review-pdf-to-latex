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
