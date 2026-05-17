"""Tests for review_pdf_to_latex.state — schemas, atomic writes, readers."""

import json
import os
import threading
from pathlib import Path

import pytest

from review_pdf_to_latex import state


def test_statedir_paths_resolve(tmp_project: Path):
    """StateDir computes the four canonical .review-state/ paths from a project root."""
    sd = state.StateDir(tmp_project)
    assert sd.annotations_path == tmp_project / ".review-state" / "annotations.json"
    assert sd.mapping_path == tmp_project / ".review-state" / "mapping.json"
    assert sd.state_path == tmp_project / ".review-state" / "state.json"
    assert sd.events_path == tmp_project / ".review-state" / "state-events.jsonl"


def test_statedir_root_property(tmp_project: Path):
    """StateDir exposes the parent project root and the .review-state/ dir."""
    sd = state.StateDir(tmp_project)
    assert sd.project_root == tmp_project
    assert sd.dir == tmp_project / ".review-state"


def test_statedir_str_path_accepted(tmp_project: Path):
    """StateDir accepts a str path and converts to Path internally."""
    sd = state.StateDir(str(tmp_project))
    assert isinstance(sd.project_root, Path)
    assert sd.project_root == tmp_project


def test_atomic_write_json_writes_valid_json(tmp_project: Path):
    """atomic_write_json produces a file that round-trips as JSON."""
    sd = state.StateDir(tmp_project)
    payload = {"schema_version": 1, "hello": "world"}
    state.atomic_write_json(sd.state_path, payload)
    assert sd.state_path.exists()
    loaded = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert loaded == payload


def test_atomic_write_json_creates_parent_dir(tmp_path: Path):
    """atomic_write_json creates the parent directory if it does not exist."""
    target = tmp_path / "nested" / "deep" / "file.json"
    state.atomic_write_json(target, {"ok": True})
    assert target.exists()


def test_atomic_write_json_failure_leaves_original_intact(
    tmp_project: Path, monkeypatch: pytest.MonkeyPatch
):
    """If fsync raises, the original file is unchanged and no .tmp lingers."""
    sd = state.StateDir(tmp_project)
    sd.state_path.write_text('{"schema_version": 1, "original": true}', encoding="utf-8")

    def boom(fd: int) -> None:
        raise OSError("simulated fsync failure")

    monkeypatch.setattr(os, "fsync", boom)
    with pytest.raises(OSError, match="simulated fsync failure"):
        state.atomic_write_json(sd.state_path, {"schema_version": 1, "new": True})

    # Original survives.
    loaded = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert loaded == {"schema_version": 1, "original": True}
    # No leftover .tmp files in the parent dir.
    leftover = [p for p in sd.dir.iterdir() if p.name.startswith(".tmp.")]
    assert leftover == []


def test_atomic_write_json_concurrent_writers_do_not_corrupt(tmp_project: Path):
    """Two threads writing concurrently leave a syntactically valid JSON file.

    Atomicity guarantees that the on-disk file is always the complete
    output of exactly one writer; it is never partial.
    """
    sd = state.StateDir(tmp_project)

    def writer(value: int) -> None:
        for _ in range(20):
            state.atomic_write_json(sd.state_path, {"schema_version": 1, "v": value})

    t1 = threading.Thread(target=writer, args=(1,))
    t2 = threading.Thread(target=writer, args=(2,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Whichever writer landed last, the file is valid JSON with a known shape.
    loaded = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert loaded["schema_version"] == 1
    assert loaded["v"] in (1, 2)
