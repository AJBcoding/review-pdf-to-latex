"""Tests for src/review_pdf_to_latex/extract.py — Phase 0 setup pipeline."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from review_pdf_to_latex.extract import read_annotations
from review_pdf_to_latex.state import Annotation


FIXTURE_PDF = Path(__file__).parent / "fixtures" / "sample-annotated.pdf"


def test_read_annotations_returns_list_with_correct_fields() -> None:
    """read_annotations returns Annotation dataclasses with all required fields populated."""
    assert FIXTURE_PDF.exists(), (
        f"Fixture {FIXTURE_PDF} missing; commit a 1-page PDF with 2 highlights first."
    )

    result = read_annotations(FIXTURE_PDF)

    assert isinstance(result, list), "expected a list"
    assert len(result) >= 1, "fixture must contain at least one highlight"

    id_pattern = re.compile(r"^ann-\d{3}$")

    for i, ann in enumerate(result):
        assert isinstance(ann, Annotation), f"item {i} is not an Annotation dataclass"
        assert id_pattern.match(ann.id), f"id {ann.id!r} not in ann-NNN format"
        assert isinstance(ann.page, int) and ann.page >= 1, "page must be 1-based int"
        assert isinstance(ann.bbox, tuple) and len(ann.bbox) == 4, "bbox must be 4-tuple"
        assert all(isinstance(c, float) for c in ann.bbox), "bbox values must be floats"
        assert isinstance(ann.highlighted_text, str) and ann.highlighted_text, (
            "highlighted_text must be a non-empty string"
        )
        assert isinstance(ann.author, str) and ann.author, (
            "author must be a non-empty string (use 'anonymous' if absent)"
        )
        assert isinstance(ann.comment, str), "comment must be str (may be empty)"
        assert ann.created is None or isinstance(ann.created, str), (
            "created must be ISO8601 string or None"
        )
        assert isinstance(ann.trigger_match, bool), "trigger_match must be bool"

    # IDs are sequential and zero-padded across the list.
    expected_ids = [f"ann-{i + 1:03d}" for i in range(len(result))]
    assert [a.id for a in result] == expected_ids, (
        f"IDs must be sequential ann-001..ann-NNN; got {[a.id for a in result]}"
    )


from review_pdf_to_latex.extract import is_trigger


@pytest.mark.parametrize(
    ("comment", "trigger", "expected"),
    [
        ("claude surface this", "claude surface this", True),
        ("Claude Surface This", "claude surface this", True),
        ("CLAUDE SURFACE THIS, please", "claude surface this", True),
        ("Hey, claude surface this paragraph", "claude surface this", True),
        ("tighten the prose", "claude surface this", False),
        ("", "claude surface this", False),
        ("claude surfacethis", "claude surface this", False),
        ("anything goes", "anything goes", True),
        ("anything", "anything goes", False),
    ],
    ids=[
        "exact",
        "title_case",
        "uppercase_with_extra",
        "embedded_in_longer",
        "no_match",
        "empty_comment",
        "no_space_no_match",
        "custom_trigger_match",
        "custom_trigger_no_match",
    ],
)
def test_is_trigger_case_insensitive_substring(
    comment: str, trigger: str, expected: bool
) -> None:
    """is_trigger returns True iff the trigger phrase is a case-insensitive substring."""
    assert is_trigger(comment, trigger) is expected
