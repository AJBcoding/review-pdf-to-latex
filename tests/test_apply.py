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


def test_apply_edit_rejects_unsupported_schema(tmp_path: Path) -> None:
    """A state.json with a newer schema_version makes the mutator refuse (rev-l1).

    The old _read_json bypassed the schema guard; now the read routes through
    state.read_json and the guard's SchemaVersionError is wrapped into
    SchemaUnsupportedApplyError (exit 24).
    """
    from review_pdf_to_latex.apply import SchemaUnsupportedApplyError
    from review_pdf_to_latex.exit_codes import EXIT_SCHEMA_UNSUPPORTED

    proj = _make_project(tmp_path)
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    state["schema_version"] = 2  # newer than SUPPORTED_SCHEMA (1)
    proj.state_path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(SchemaUnsupportedApplyError) as exc:
        apply_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            new_text="x\n",
            dry_run=False,
        )
    assert exc.value.exit_code == EXIT_SCHEMA_UNSUPPORTED == 24


def test_apply_edit_rejects_older_schema_as_migration_required(tmp_path: Path) -> None:
    """A state.json with an older schema_version demands migration (rev-l1)."""
    from review_pdf_to_latex.apply import MigrationRequiredApplyError
    from review_pdf_to_latex.exit_codes import EXIT_MIGRATION_REQUIRED

    proj = _make_project(tmp_path)
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    state["schema_version"] = 0  # older than SUPPORTED_SCHEMA (1)
    proj.state_path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(MigrationRequiredApplyError) as exc:
        apply_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            new_text="x\n",
            dry_run=False,
        )
    assert exc.value.exit_code == EXIT_MIGRATION_REQUIRED == 25


def test_apply_module_has_no_unguarded_read_json(tmp_path: Path) -> None:
    """The unguarded apply._read_json shim is gone (rev-l1 / C3 done-criterion)."""
    from review_pdf_to_latex import apply as _apply

    assert not hasattr(_apply, "_read_json"), (
        "apply._read_json must be deleted; all reads route through "
        "state.read_json via _read_state_json"
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


from review_pdf_to_latex.apply import apply_batch


def _make_project_three_in_one_file(tmp_path: Path) -> _ProjectFixture:
    lines = [f"L{i:02d}\n" for i in range(1, 121)]  # 120 lines
    proj = _make_project(tmp_path, lines=lines)
    # Reset the default ann-001 mapping to a clean state, then add three.
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    state["annotations"] = {
        "ann-A": dict(state["annotations"]["ann-001"]),
        "ann-B": dict(state["annotations"]["ann-001"]),
        "ann-C": dict(state["annotations"]["ann-001"]),
    }
    proj.state_path.write_text(json.dumps(state), encoding="utf-8")
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-A": {
                "latex_file": "templates/section.tex",
                "line_range": [10, 10],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
            "ann-B": {
                "latex_file": "templates/section.tex",
                "line_range": [50, 50],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
            "ann-C": {
                "latex_file": "templates/section.tex",
                "line_range": [100, 100],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
        },
    }
    proj.mapping_path.write_text(json.dumps(mapping), encoding="utf-8")
    return proj


def test_apply_batch_reverse_order_keeps_earlier_lines_valid(tmp_path: Path) -> None:
    proj = _make_project_three_in_one_file(tmp_path)

    # Provide the edits in arbitrary (ascending) order; apply_batch reorders.
    edits = [
        ("ann-A", "A-new1\nA-new2\nA-new3\n"),  # +2 lines at L10
        ("ann-B", "B-new1\n"),                  # 0 net shift at L50
        ("ann-C", ""),                          # -1 line at L100 (full deletion)
    ]
    results = apply_batch(state_dir=proj.state_dir, edits=edits)
    assert len(results) == 3

    new_text = proj.tex_path.read_text(encoding="utf-8")
    new_lines = new_text.splitlines(keepends=True)

    # Confirm each edit landed at the correct (post-shift) location by checking
    # the surrounding context.
    # ann-C: line 100 was "L100\n" → deleted; line 99 = "L99\n" preceding,
    # next line should be "L101\n".
    assert "L100\n" not in new_lines
    # ann-B: line 50 was "L50\n" → "B-new1\n"; ann-B was applied before any
    # other edit could shift it (since C was first in reverse order).
    assert "B-new1\n" in new_lines
    # ann-A: line 10 → three lines.
    assert "A-new1\n" in new_lines
    assert "A-new2\n" in new_lines
    assert "A-new3\n" in new_lines

    # State has all three statuses == applied
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    for ann_id in ("ann-A", "ann-B", "ann-C"):
        assert state["annotations"][ann_id]["status"] == "applied"


def test_apply_batch_guards_source_pdf_once(tmp_path: Path, monkeypatch) -> None:
    """rev-l12: the source-PDF guard runs once per batch, not once per edit."""
    import review_pdf_to_latex.apply as apply_mod

    proj = _make_project_three_in_one_file(tmp_path)

    calls = {"n": 0}
    real_guard = apply_mod._guard_source_pdf

    def counting_guard(state_dir: Path) -> None:
        calls["n"] += 1
        real_guard(state_dir)

    monkeypatch.setattr(apply_mod, "_guard_source_pdf", counting_guard)

    apply_batch(
        state_dir=proj.state_dir,
        edits=[("ann-A", "x\n"), ("ann-B", "y\n"), ("ann-C", "z\n")],
    )

    assert calls["n"] == 1


def test_apply_batch_still_refuses_when_source_pdf_changed(tmp_path: Path) -> None:
    """The single batch guard still rejects a drifted source PDF (rev-l12)."""
    from review_pdf_to_latex.apply import SourcePdfChangedApplyError

    proj = _make_project_three_in_one_file(tmp_path)
    (proj.project / "source.pdf").write_bytes(b"%PDF-1.4 different fixture\n")

    with pytest.raises(SourcePdfChangedApplyError, match="source PDF changed"):
        apply_batch(state_dir=proj.state_dir, edits=[("ann-A", "x\n")])


from review_pdf_to_latex.apply import (
    NoPriorApplyError,
    revert_edit,
)


def test_revert_edit_restores_before_text_and_sets_status_rejected(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")

    revert_edit(state_dir=proj.state_dir, annotation_id="ann-001", status="rejected")

    # File restored to original two lines at positions 2-3.
    text = proj.tex_path.read_text(encoding="utf-8")
    assert text == "line one\nline two\nline three\nline four\nline five\n"

    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "rejected"
    assert entry["applied_text"] is None
    assert entry["before_text"] == "line two\nline three\n"  # preserved


def test_revert_edit_with_failure_log_sets_needs_review_and_log_path(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="Y\n")

    log_path = proj.state_dir / "builds" / "build-007.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("LaTeX Error: Undefined control sequence\n", encoding="utf-8")

    revert_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        status="needs_review",
        failure_log=log_path,
    )

    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "needs_review"
    assert entry["failure_log_path"] == str(log_path.relative_to(proj.project))
    assert entry["failure_edit_text"] == "Y\n"


def test_revert_edit_rejects_invalid_status(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")

    with pytest.raises(ValueError):
        revert_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            status="accepted",  # not a valid revert target
        )


def test_revert_edit_raises_when_no_prior_apply(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    # No apply called; applied_text is None.
    with pytest.raises(NoPriorApplyError):
        revert_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            status="rejected",
        )


def test_revert_edit_after_empty_apply_restores_full_file(tmp_path: Path) -> None:
    """Empty new_text deletes lines; reverting must restore them without
    consuming any subsequent unrelated line (rev-ra1 degenerate-range bug)."""
    proj = _make_project(tmp_path)
    # ann-001 maps to [2, 3]; applying "" deletes those two lines.
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="")

    # File is now 3 lines: line one, line four, line five.
    assert proj.tex_path.read_text(encoding="utf-8") == (
        "line one\nline four\nline five\n"
    )

    revert_edit(state_dir=proj.state_dir, annotation_id="ann-001", status="rejected")

    # All five original lines must be present — "line four" must NOT be lost.
    assert proj.tex_path.read_text(encoding="utf-8") == (
        "line one\nline two\nline three\nline four\nline five\n"
    )

    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "rejected"
    assert entry["applied_text"] is None
    assert entry["before_text"] == "line two\nline three\n"


def test_revert_edit_after_empty_apply_shifts_subsequent_mapping_back(
    tmp_path: Path,
) -> None:
    """Empty-text apply shifts subsequent mappings; revert must shift them back."""
    proj = _make_project(tmp_path)
    # Add ann-002 at line 5.
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

    # Apply empty text to ann-001 [2, 3] — deletes 2 lines, shifts ann-002 from [5,5] to [3,3].
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="")
    mapping_mid = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    assert mapping_mid["mappings"]["ann-002"]["line_range"] == [3, 3]

    # Revert ann-001 — ann-002 must shift back to [5, 5].
    revert_edit(state_dir=proj.state_dir, annotation_id="ann-001", status="rejected")
    mapping_after = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    assert mapping_after["mappings"]["ann-002"]["line_range"] == [5, 5]


from review_pdf_to_latex.apply import (
    IllegalStatusTransitionError,
    set_annotation_status,
)


# --- rev-n4 regression: status validation hoisted above .tex mutation -------

def test_apply_edit_illegal_status_leaves_tex_unchanged(tmp_path: Path) -> None:
    """apply_edit on an accepted annotation raises IllegalStatusTransitionError
    with the .tex file byte-identical (no partial mutation). (rev-n4)"""
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="applied\n")
    set_annotation_status(state_dir=proj.state_dir, annotation_id="ann-001", status="accepted")

    tex_before = proj.tex_path.read_bytes()

    with pytest.raises(IllegalStatusTransitionError):
        apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="re-applied\n")

    assert proj.tex_path.read_bytes() == tex_before


def test_revert_edit_illegal_status_leaves_tex_unchanged(tmp_path: Path) -> None:
    """revert_edit on an accepted annotation raises IllegalStatusTransitionError
    with the .tex file byte-identical (no partial mutation). (rev-n4)"""
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="applied\n")
    set_annotation_status(state_dir=proj.state_dir, annotation_id="ann-001", status="accepted")

    tex_before = proj.tex_path.read_bytes()

    with pytest.raises(IllegalStatusTransitionError):
        revert_edit(state_dir=proj.state_dir, annotation_id="ann-001", status="rejected")

    assert proj.tex_path.read_bytes() == tex_before


def test_set_status_legal_transition_applied_to_accepted(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")
    set_annotation_status(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        status="accepted",
        reason="looks good",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "accepted"
    assert entry["last_status_reason"] == "looks good"


def test_set_status_illegal_transition_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    # pending → accepted is illegal per spec §10.3 (must go pending → applied → accepted)
    with pytest.raises(IllegalStatusTransitionError):
        set_annotation_status(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            status="accepted",
        )


def test_set_status_no_reason_does_not_set_field(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")
    set_annotation_status(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        status="accepted",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "accepted"
    # When no reason is supplied, field is omitted or None — accept either.
    assert entry.get("last_status_reason") in (None,)


from review_pdf_to_latex.apply import (
    AnnotationNotFoundError,
    SourcePdfChangedApplyError,
    set_current_annotation,
)


def test_set_current_annotation_updates_state_without_status_change(tmp_path: Path) -> None:
    """set-current is status-neutral: only current_annotation_id moves."""
    proj = _make_project(tmp_path)
    set_current_annotation(state_dir=proj.state_dir, annotation_id="ann-001")
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    assert state["current_annotation_id"] == "ann-001"
    # Status remains whatever it was (pending in this fixture).
    assert state["annotations"]["ann-001"]["status"] == "pending"


def test_set_current_annotation_unknown_id_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    with pytest.raises(AnnotationNotFoundError):
        set_current_annotation(state_dir=proj.state_dir, annotation_id="ann-missing")


def test_set_current_annotation_source_pdf_changed_raises(tmp_path: Path) -> None:
    """Cursor moves are gated by the same source-PDF guard as every other writer
    in apply.py (spec §14 risk 9)."""
    proj = _make_project(tmp_path)
    pdf = proj.project / "source.pdf"
    pdf.write_bytes(b"%PDF-1.4 mutated\n")  # md5 no longer matches annotations.json
    with pytest.raises(SourcePdfChangedApplyError):
        set_current_annotation(state_dir=proj.state_dir, annotation_id="ann-001")


from review_pdf_to_latex.apply import append_chat_turn


def test_append_chat_first_turn_initializes_log(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    append_chat_turn(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        role="user",
        text="Why is this passage flagged?",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    log = state["annotations"]["ann-001"]["surface_chat_log"]
    assert isinstance(log, list)
    assert len(log) == 1
    assert log[0]["role"] == "user"
    assert log[0]["text"] == "Why is this passage flagged?"
    assert "ts" in log[0]


def test_append_chat_second_turn_appends(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    append_chat_turn(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        role="user",
        text="One",
    )
    append_chat_turn(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        role="claude",
        text="Two",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    log = state["annotations"]["ann-001"]["surface_chat_log"]
    assert [t["role"] for t in log] == ["user", "claude"]
    assert [t["text"] for t in log] == ["One", "Two"]


def test_append_chat_invalid_role_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    with pytest.raises(ValueError):
        append_chat_turn(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            role="assistant",  # only "user" or "claude" allowed
            text="hi",
        )


from review_pdf_to_latex.apply import record_proposal


def test_record_proposal_writes_state_but_not_tex(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    original_tex = proj.tex_path.read_text(encoding="utf-8")

    record_proposal(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        proposed_text="stashed proposal\n",
    )

    # .tex file is untouched.
    assert proj.tex_path.read_text(encoding="utf-8") == original_tex
    # state.json carries the proposal but status has NOT moved off pending.
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["proposed_text"] == "stashed proposal\n"
    assert entry["applied_text"] is None
    assert entry["status"] == "pending"


from review_pdf_to_latex.apply import (
    FileMutationError,
    InvalidLineRangeError,
    override_mapping,
)


def test_override_mapping_writes_manual_method(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    # Add a second file to the project to override into.
    other = proj.project / "templates" / "other.tex"
    other.write_text("o1\no2\no3\no4\n", encoding="utf-8")

    override_mapping(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        file="templates/other.tex",
        lines=(2, 3),
    )

    mapping = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    entry = mapping["mappings"]["ann-001"]
    assert entry["latex_file"] == "templates/other.tex"
    assert entry["line_range"] == [2, 3]
    assert entry["confidence"] == 1.0
    assert entry["method"] == "manual"
    assert entry["needs_review"] is False
    assert entry.get("candidates") is None


def test_override_mapping_out_of_bounds_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)  # section.tex has 5 lines
    with pytest.raises(InvalidLineRangeError):
        override_mapping(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            file="templates/section.tex",
            lines=(3, 99),
        )


def test_override_mapping_nonexistent_file_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    with pytest.raises(FileMutationError):
        override_mapping(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            file="templates/does-not-exist.tex",
            lines=(1, 1),
        )
