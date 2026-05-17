"""CHANGELOG structural tests (Task 15.2)."""

from pathlib import Path

import pytest

CHANGELOG = Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def test_changelog_exists() -> None:
    assert CHANGELOG.exists(), f"CHANGELOG.md missing at {CHANGELOG}"


def test_changelog_has_unreleased_section() -> None:
    text = CHANGELOG.read_text(encoding="utf-8")
    assert "## [Unreleased]" in text


def test_changelog_follows_keep_a_changelog_header() -> None:
    text = CHANGELOG.read_text(encoding="utf-8")
    assert text.startswith("# Changelog")
    assert "Keep a Changelog" in text or "keepachangelog.com" in text
