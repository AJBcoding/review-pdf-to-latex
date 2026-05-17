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
