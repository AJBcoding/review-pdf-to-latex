"""Tests for the speculative-compile preview path (spec §10.3, §11.1)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from review_pdf_to_latex import preview


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_with_in_place_edit_mutates_during_yield_and_restores_on_exit(
    tmp_path: Path,
):
    """Inside the `with` block the file shows the new text; on exit, the file
    is byte-identical to its pre-call contents."""
    target = tmp_path / "intro.tex"
    original = "line 1\nline 2\nline 3\nline 4\nline 5\n"
    _write(target, original)
    pre_hash = target.read_bytes()

    with preview.with_in_place_edit(
        target, line_range=(2, 3), new_text="REPLACEMENT\n"
    ):
        mutated = target.read_text(encoding="utf-8")
        assert mutated == "line 1\nREPLACEMENT\nline 4\nline 5\n"

    post_hash = target.read_bytes()
    assert post_hash == pre_hash, "file must be byte-identical after restore"


def test_with_in_place_edit_restores_on_exception(tmp_path: Path):
    """If the caller raises inside the `with` block, the file is still restored."""
    target = tmp_path / "intro.tex"
    original = "alpha\nbeta\ngamma\n"
    _write(target, original)

    class _Boom(Exception):
        pass

    with pytest.raises(_Boom):
        with preview.with_in_place_edit(
            target, line_range=(2, 2), new_text="HYPOTHETICAL\n"
        ):
            assert target.read_text(encoding="utf-8") == "alpha\nHYPOTHETICAL\ngamma\n"
            raise _Boom("simulated build crash")

    assert target.read_text(encoding="utf-8") == original


def test_with_in_place_edit_invalid_line_range_raises(tmp_path: Path):
    """A line range outside the file's line count raises ValueError before mutation."""
    target = tmp_path / "intro.tex"
    _write(target, "only one line\n")

    with pytest.raises(ValueError, match="line range"):
        with preview.with_in_place_edit(
            target, line_range=(5, 7), new_text="oops\n"
        ):
            pass

    assert target.read_text(encoding="utf-8") == "only one line\n"


def test_with_in_place_edit_restore_failure_writes_recovery_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """If the restore step fails on the way out, the engine writes the
    in-memory snapshot to a recovery file under ``.review-state/`` and
    raises ``InPlaceRestoreError``.

    We simulate the failure by monkeypatching ``Path.write_text`` on the
    target file to raise during restore (the *second* call — the first call
    is the in-place mutation we want to succeed).
    """
    target = tmp_path / "intro.tex"
    original = "before\n"
    _write(target, original)

    # Ensure the recovery dir exists; the helper writes into
    # <project_root>/.review-state/preview-recovery-<ts>.txt where
    # project_root is target.parent.
    recovery_dir = tmp_path / ".review-state"
    recovery_dir.mkdir()

    real_write_text = Path.write_text
    call_count = {"n": 0}

    def failing_write_text(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        call_count["n"] += 1
        # Allow the mutation write (first call). Fail the restore (second).
        if self == target and call_count["n"] >= 2:
            raise OSError("simulated restore failure")
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", failing_write_text)

    with pytest.raises(preview.InPlaceRestoreError) as exc_info:
        with preview.with_in_place_edit(
            target, line_range=(1, 1), new_text="MUTATED\n"
        ):
            assert target.read_text(encoding="utf-8") == "MUTATED\n"

    # The recovery file must exist and contain the original snapshot.
    recovery_files = list(recovery_dir.glob("preview-recovery-*.txt"))
    assert len(recovery_files) == 1, (
        f"expected one recovery file, got {recovery_files}"
    )
    assert recovery_files[0].read_text(encoding="utf-8") == original

    # The error message must name the original file and the recovery file.
    msg = str(exc_info.value)
    assert str(target) in msg
    assert str(recovery_files[0]) in msg


from unittest.mock import patch

from review_pdf_to_latex import state as state_mod


def _seed_minimal_project(tmp_project: Path) -> None:
    """Seed a project root with one .tex file, plus mapping.json and state.json.

    Layout:
        tmp_project/templates/intro.tex
        tmp_project/source.pdf
        tmp_project/.review-state/annotations.json
        tmp_project/.review-state/mapping.json
        tmp_project/.review-state/state.json
    """
    import hashlib

    tex = tmp_project / "templates" / "intro.tex"
    tex.parent.mkdir(parents=True, exist_ok=True)
    tex.write_text(
        "intro line 1\nintro line 2\nintro line 3\nintro line 4\n",
        encoding="utf-8",
    )

    # Seed a source PDF + annotations.json so assert_source_pdf_unchanged
    # has a matching MD5 to verify.
    source_pdf = tmp_project / "source.pdf"
    source_pdf.write_bytes(b"%PDF-1.4 fake pdf content\n")
    pdf_md5 = hashlib.md5(source_pdf.read_bytes()).hexdigest()

    sd = state_mod.StateDir(tmp_project)
    state_mod.atomic_write_json(
        sd.annotations_path,
        {
            "schema_version": 1,
            "source_pdf": str(source_pdf),
            "source_pdf_md5": pdf_md5,
            "annotations": [],
        },
    )
    state_mod.atomic_write_json(
        sd.mapping_path,
        {
            "schema_version": 1,
            "mappings": {
                "ann-001": {
                    "latex_file": "templates/intro.tex",
                    "line_range": [2, 3],
                    "confidence": 0.9,
                    "method": "fuzzy_text",
                    "needs_review": False,
                    "candidates": [],
                },
            },
        },
    )
    state_mod.atomic_write_json(
        sd.state_path,
        {
            "schema_version": 1,
            "phase": "2a-ratify",
            "order": "mechanical-first",
            "current_annotation_id": "ann-001",
            "annotations": {
                "ann-001": {
                    "status": "applied",
                    "before_text": "intro line 2\nintro line 3",
                    "proposed_text": "intro line 2\nintro line 3",
                    "applied_text": "intro line 2\nintro line 3",
                    "applied_at": "2026-05-16T20:00:00Z",
                    "last_build_id": "build-001",
                    "surface_chat_log": None,
                    "failure_log_path": None,
                    "failure_edit_text": None,
                },
            },
            "builds": [],
        },
    )


def test_preview_appends_build_and_restores_tex_file(tmp_project: Path):
    """preview() runs build inside the snapshot/restore context, returns the
    build ID, and leaves the .tex file byte-identical."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)
    tex = tmp_project / "templates" / "intro.tex"
    original = tex.read_bytes()

    # Stub out build.build so this test does not invoke pdflatex.
    # The contract: build.build mutates state.json.builds[] and returns
    # the new build ID. Preview must invoke it inside the `with` block.
    def fake_build(state_dir, **kwargs):  # type: ignore[no-untyped-def]
        # Verify the .tex file IS mutated at the moment build runs.
        current = tex.read_text(encoding="utf-8")
        assert "HYPOTHETICAL" in current, (
            "build must run with the speculative edit in place"
        )
        # Append a build record (mimicking chunk C's behavior).
        payload = state_mod.read_json(state_dir.state_path)
        payload["builds"].append(
            {
                "id": "build-002",
                "pdf_path": ".review-state/builds/build-002.pdf",
                "page_count": 1,
                "compiled_at": "2026-05-16T20:05:00Z",
                "log_path": ".review-state/builds/build-002.log",
                "ok": True,
                "page_md5": ["deadbeef"],
            }
        )
        state_mod.atomic_write_json(state_dir.state_path, payload)
        return "build-002"

    with patch.object(preview, "_invoke_build", side_effect=fake_build):
        build_id = preview.preview(
            sd, annotation_id="ann-001", new_text="HYPOTHETICAL line\n"
        )

    assert build_id == "build-002"

    # The .tex file is byte-identical to its pre-preview state.
    assert tex.read_bytes() == original

    # state.json.annotations[ann-001] is unchanged.
    final = state_mod.read_json(sd.state_path)
    ann = final["annotations"]["ann-001"]
    assert ann["status"] == "applied"
    assert ann["applied_text"] == "intro line 2\nintro line 3"
    assert ann["last_build_id"] == "build-001"  # NOT updated to build-002

    # state.json.builds[] grew by one entry.
    assert [b["id"] for b in final["builds"]] == ["build-002"]


def test_preview_raises_mapping_unresolved_when_mapping_is_null(tmp_project: Path):
    """If the annotation has no latex_file / line_range, preview raises
    MappingUnresolvedError (mapped to exit code 8 by the CLI)."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)

    # Overwrite mapping.json so ann-001 has no resolved location.
    state_mod.atomic_write_json(
        sd.mapping_path,
        {
            "schema_version": 1,
            "mappings": {
                "ann-001": {
                    "latex_file": None,
                    "line_range": None,
                    "confidence": 0.0,
                    "method": "failed",
                    "needs_review": True,
                    "candidates": [],
                },
            },
        },
    )

    with pytest.raises(preview.MappingUnresolvedError):
        preview.preview(sd, annotation_id="ann-001", new_text="...")


def test_preview_raises_annotation_not_found_for_unknown_id(tmp_project: Path):
    """An unknown annotation ID raises AnnotationNotFoundError."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)

    with pytest.raises(preview.AnnotationNotFoundError):
        preview.preview(sd, annotation_id="ann-999", new_text="...")


def test_preview_propagates_build_failure(tmp_project: Path):
    """If the speculative build fails, preview re-raises (the CLI maps it
    to exit code 11). The .tex file is still restored."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)
    tex = tmp_project / "templates" / "intro.tex"
    original = tex.read_bytes()

    class _BuildFailed(Exception):
        pass

    def fake_build(state_dir, **kwargs):  # type: ignore[no-untyped-def]
        raise _BuildFailed("pdflatex exit code 1")

    with patch.object(preview, "_invoke_build", side_effect=fake_build):
        with pytest.raises(_BuildFailed):
            preview.preview(
                sd, annotation_id="ann-001", new_text="WILL_FAIL\n"
            )

    # File restored even though build crashed.
    assert tex.read_bytes() == original
