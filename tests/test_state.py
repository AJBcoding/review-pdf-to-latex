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


def test_read_json_round_trips_supported_schema(tmp_project: Path):
    """read_json returns the parsed dict for schema_version == SUPPORTED_SCHEMA."""
    sd = state.StateDir(tmp_project)
    payload = {"schema_version": 1, "hello": "world"}
    state.atomic_write_json(sd.state_path, payload)
    loaded = state.read_json(sd.state_path)
    assert loaded == payload


def test_read_json_missing_schema_version_raises(tmp_project: Path):
    """A JSON file without schema_version raises SchemaVersionError."""
    sd = state.StateDir(tmp_project)
    state.atomic_write_json(sd.state_path, {"no_version": True})
    with pytest.raises(state.SchemaVersionError, match="missing schema_version"):
        state.read_json(sd.state_path)


def test_read_json_future_schema_raises(tmp_project: Path):
    """A schema_version higher than SUPPORTED_SCHEMA raises SchemaVersionError."""
    sd = state.StateDir(tmp_project)
    state.atomic_write_json(sd.state_path, {"schema_version": state.SUPPORTED_SCHEMA + 1})
    with pytest.raises(state.SchemaVersionError, match="unsupported"):
        state.read_json(sd.state_path)


def test_read_json_older_schema_raises_migration_required(tmp_project: Path):
    """A schema_version below SUPPORTED_SCHEMA raises MigrationRequiredError."""
    if state.SUPPORTED_SCHEMA <= 1:
        pytest.skip("No older schema exists yet at SUPPORTED_SCHEMA=1")
    sd = state.StateDir(tmp_project)
    state.atomic_write_json(sd.state_path, {"schema_version": state.SUPPORTED_SCHEMA - 1})
    with pytest.raises(state.MigrationRequiredError):
        state.read_json(sd.state_path)


def test_read_json_supported_schema_constant_is_one():
    """SUPPORTED_SCHEMA is 1 in v1 (spec §7)."""
    assert state.SUPPORTED_SCHEMA == 1


def test_annotation_dataclass_round_trip():
    """Annotation dataclass round-trips through to_dict / from_dict using spec §7.1 example."""
    raw = {
        "id": "ann-001",
        "page": 4,
        "bbox": [72.0, 510.5, 540.0, 542.5],
        "highlighted_text": "The college experienced a substantial increase…",
        "author": "commenter-name-or-anonymous",
        "comment": "Tighten this — too academic",
        "created": "2026-05-15T14:22:11Z",
        "trigger_match": False,
    }
    obj = state.Annotation.from_dict(raw)
    assert obj.id == "ann-001"
    assert obj.bbox == (72.0, 510.5, 540.0, 542.5)
    assert obj.trigger_match is False
    assert obj.to_dict() == raw


def test_mapping_dataclass_round_trip_resolved():
    """Mapping with method=fuzzy_text round-trips per spec §7.2 example."""
    raw = {
        "latex_file": "templates/enrollment_growth.tex",
        "line_range": [47, 52],
        "confidence": 0.92,
        "method": "fuzzy_text",
        "needs_review": False,
        "candidates": [],
    }
    obj = state.Mapping.from_dict(raw)
    assert obj.latex_file == "templates/enrollment_growth.tex"
    assert obj.line_range == (47, 52)
    assert obj.confidence == 0.92
    assert obj.method == "fuzzy_text"
    assert obj.needs_review is False
    assert obj.to_dict() == raw


def test_mapping_dataclass_round_trip_needs_review():
    """Mapping with method=failed round-trips with null line_range and candidates list."""
    raw = {
        "latex_file": None,
        "line_range": None,
        "confidence": 0.0,
        "method": "failed",
        "needs_review": True,
        "candidates": [
            {"file": "templates/equity_findings.tex", "line_range": [22, 28], "score": 0.34},
            {"file": "templates/student_success.tex", "line_range": [88, 91], "score": 0.31},
        ],
    }
    obj = state.Mapping.from_dict(raw)
    assert obj.latex_file is None
    assert obj.line_range is None
    assert obj.needs_review is True
    assert len(obj.candidates) == 2
    assert obj.to_dict() == raw


def test_annotation_state_dataclass_round_trip_applied():
    """AnnotationState with status=applied round-trips per spec §7.3 example."""
    raw = {
        "status": "applied",
        "before_text": "The college experienced a substantial increase…",
        "proposed_text": "COTA enrollment grew 12% YoY…",
        "applied_text": "COTA enrollment grew 12% YoY…",
        "applied_at": "2026-05-16T20:45:12Z",
        "last_build_id": "build-007",
        "surface_chat_log": None,
        "failure_log_path": None,
        "failure_edit_text": None,
    }
    obj = state.AnnotationState.from_dict(raw)
    assert obj.status == "applied"
    assert obj.applied_at == "2026-05-16T20:45:12Z"
    assert obj.to_dict() == raw


def test_annotation_state_dataclass_round_trip_needs_review_with_failure():
    """AnnotationState with status=needs_review carries failure metadata."""
    raw = {
        "status": "needs_review",
        "before_text": "Original snippet that broke the build…",
        "proposed_text": "Claude's proposal that failed to compile…",
        "applied_text": None,
        "applied_at": None,
        "last_build_id": None,
        "failure_log_path": ".review-state/builds/build-011.log",
        "failure_edit_text": "Claude's proposal that failed to compile…",
        "surface_chat_log": None,
    }
    obj = state.AnnotationState.from_dict(raw)
    assert obj.failure_log_path == ".review-state/builds/build-011.log"
    assert obj.to_dict() == raw


def test_build_dataclass_round_trip():
    """Build dataclass round-trips per spec §7.3 example."""
    raw = {
        "id": "build-007",
        "pdf_path": ".review-state/builds/build-007.pdf",
        "page_count": 24,
        "compiled_at": "2026-05-16T20:45:30Z",
        "log_path": ".review-state/builds/build-007.log",
        "ok": True,
        "page_md5": ["aaa", "bbb", "ccc"],
    }
    obj = state.Build.from_dict(raw)
    assert obj.id == "build-007"
    assert obj.page_count == 24
    assert obj.ok is True
    assert obj.page_md5 == ("aaa", "bbb", "ccc")
    assert obj.to_dict() == raw


def test_state_file_round_trip():
    """StateFile round-trips through to_dict / from_dict on a minimal example."""
    raw = {
        "schema_version": 1,
        "phase": "0-setup",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {},
        "builds": [],
    }
    obj = state.StateFile.from_dict(raw)
    assert obj.phase == "0-setup"
    assert obj.order == "mechanical-first"
    assert obj.current_annotation_id is None
    assert obj.to_dict() == raw


@pytest.mark.parametrize(
    "status,expected_terminal",
    [
        # Terminal per spec §7.3
        ("accepted", True),
        ("rejected", True),
        ("redrafted", True),
        ("deferred", True),
        ("surfaced_resolved", True),
        # Non-terminal per spec §7.3
        ("pending", False),
        ("applied", False),
        ("surfaced_pending", False),
        ("needs_review", False),
    ],
)
def test_status_is_terminal(status: str, expected_terminal: bool):
    """status_is_terminal returns True only for the spec §7.3 terminal set."""
    assert state.status_is_terminal(status) is expected_terminal


def test_status_is_terminal_rejects_unknown_status():
    """An unknown status raises ValueError (defensive — schema violation)."""
    with pytest.raises(ValueError, match="unknown status"):
        state.status_is_terminal("invalid-status")
