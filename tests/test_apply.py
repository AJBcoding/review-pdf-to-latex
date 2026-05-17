# tests/test_apply.py
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from review_pdf_to_latex.apply import (
    AppliedEdit,
    apply_edit,
)


@dataclass
class _ProjectFixture:
    project: Path
    state_dir: Path
    state_path: Path
    mapping_path: Path
    annotations_path: Path
    tex_path: Path


def _make_project(tmp_path: Path, lines: list[str] | None = None) -> _ProjectFixture:
    """Build a minimal .review-state/ + one .tex file + fake source PDF.

    The source PDF is a 1-byte sentinel whose MD5 is recorded in
    annotations.json, so the spec §14 risk-9 guard
    (state.assert_source_pdf_unchanged) passes by default. Tests that want
    to exercise the guard's failure paths mutate the PDF after the fact.
    """
    import hashlib

    if lines is None:
        lines = [
            "line one\n",
            "line two\n",
            "line three\n",
            "line four\n",
            "line five\n",
        ]
    project = tmp_path / "proj"
    project.mkdir()
    tex_dir = project / "templates"
    tex_dir.mkdir()
    tex = tex_dir / "section.tex"
    tex.write_text("".join(lines), encoding="utf-8")

    # Source PDF fixture for the source-PDF guard.
    pdf = project / "source.pdf"
    pdf.write_bytes(b"%PDF-1.4 fixture\n")
    pdf_md5 = hashlib.md5(pdf.read_bytes()).hexdigest()

    state_dir = project / ".review-state"
    state_dir.mkdir()
    state = {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-001": {
                "status": "pending",
                "before_text": None,
                "proposed_text": None,
                "applied_text": None,
                "applied_at": None,
                "last_build_id": None,
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            },
        },
        "builds": [],
    }
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-001": {
                "latex_file": "templates/section.tex",
                "line_range": [2, 3],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
        },
    }
    annotations = {
        "schema_version": 1,
        "source_pdf": str(pdf.resolve()),
        "source_pdf_md5": pdf_md5,
        "extracted_at": "2026-05-16T20:30:00Z",
        "extractor": "pdfannots-fake",
        "annotations": [
            {
                "id": "ann-001",
                "page": 1,
                "bbox": [0, 0, 0, 0],
                "highlighted_text": "line two",
                "author": "anon",
                "comment": "tighten",
                "created": "2026-05-15T14:22:11Z",
                "trigger_match": False,
            }
        ],
    }

    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    (state_dir / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")
    return _ProjectFixture(
        project=project,
        state_dir=state_dir,
        state_path=state_dir / "state.json",
        mapping_path=state_dir / "mapping.json",
        annotations_path=state_dir / "annotations.json",
        tex_path=tex,
    )


def test_apply_edit_happy_path(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)

    result = apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="replaced two and three\n",
        dry_run=False,
    )

    assert isinstance(result, AppliedEdit)
    assert result.latex_file == "templates/section.tex"
    assert result.old_lines == ["line two\n", "line three\n"]
    assert result.new_lines == ["replaced two and three\n"]
    # We removed 2 lines, added 1 → shift is -1
    assert result.line_shift == -1

    # File on disk reflects the edit.
    new_text = proj.tex_path.read_text(encoding="utf-8")
    assert new_text == "line one\nreplaced two and three\nline four\nline five\n"

    # state.json reflects the apply.
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "applied"
    assert entry["before_text"] == "line two\nline three\n"
    assert entry["proposed_text"] == "replaced two and three\n"
    assert entry["applied_text"] == "replaced two and three\n"
    assert entry["applied_at"] is not None


def test_apply_edit_dry_run_does_not_write(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    original_tex = proj.tex_path.read_text(encoding="utf-8")
    original_state = proj.state_path.read_text(encoding="utf-8")

    result = apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="X\n",
        dry_run=True,
    )

    assert isinstance(result, AppliedEdit)
    assert result.new_lines == ["X\n"]
    # Neither the tex file nor state.json moved.
    assert proj.tex_path.read_text(encoding="utf-8") == original_tex
    assert proj.state_path.read_text(encoding="utf-8") == original_state


def test_apply_edit_before_text_captured_only_once(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)

    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="first draft\n",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    before_after_first = state["annotations"]["ann-001"]["before_text"]
    assert before_after_first == "line two\nline three\n"

    # Apply a second time over the new content; before_text must NOT be
    # overwritten (spec §7.3: "Never overwritten after first capture").
    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="second draft\n",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["before_text"] == before_after_first
    assert state["annotations"]["ann-001"]["proposed_text"] == "second draft\n"
    assert state["annotations"]["ann-001"]["applied_text"] == "second draft\n"


def test_apply_edit_recomputes_subsequent_mappings_in_same_file(tmp_path: Path) -> None:
    # Two mappings in the same file: ann-001 at lines 2-3, ann-002 at lines 5-5.
    # Apply ann-001 with a single replacement line → shift = -1 → ann-002 moves to 4.
    proj = _make_project(tmp_path)
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    state["annotations"]["ann-002"] = dict(state["annotations"]["ann-001"])
    proj.state_path.write_text(json.dumps(state), encoding="utf-8")
    mapping = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    mapping["mappings"]["ann-002"] = {
        "latex_file": "templates/section.tex",
        "line_range": [5, 5],
        "confidence": 0.9,
        "method": "fuzzy_text",
        "needs_review": False,
    }
    proj.mapping_path.write_text(json.dumps(mapping), encoding="utf-8")

    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="one new line\n",
    )

    mapping_after = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    # ann-002 was at [5, 5]; shift is -1 (replaced 2 lines with 1) → [4, 4].
    assert mapping_after["mappings"]["ann-002"]["line_range"] == [4, 4]
    # ann-001's mapping itself updates so its new line_range covers the new text.
    assert mapping_after["mappings"]["ann-001"]["line_range"] == [2, 2]


def test_apply_edit_handles_unicode(tmp_path: Path) -> None:
    proj = _make_project(
        tmp_path,
        lines=["L1: alpha\n", "L2: «beta» — café\n", "L3: gamma\n"],
    )
    mapping = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    mapping["mappings"]["ann-001"]["line_range"] = [2, 2]
    proj.mapping_path.write_text(json.dumps(mapping), encoding="utf-8")

    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="L2 NEW: ß∆中\n",
    )

    new = proj.tex_path.read_text(encoding="utf-8")
    assert "L2 NEW: ß∆中" in new
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["before_text"] == "L2: «beta» — café\n"


def test_apply_edit_refuses_when_source_pdf_changed(tmp_path: Path) -> None:
    """Spec §14 risk 9: mutator refuses if the source PDF md5 has drifted."""
    from review_pdf_to_latex.apply import SourcePdfChangedApplyError

    proj = _make_project(tmp_path)
    # Mutate the source PDF after extract; the recorded md5 no longer matches.
    (proj.project / "source.pdf").write_bytes(b"%PDF-1.4 different fixture\n")
    with pytest.raises(SourcePdfChangedApplyError, match="source PDF changed"):
        apply_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            new_text="anything\n",
        )
