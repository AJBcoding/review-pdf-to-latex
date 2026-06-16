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


# ---- rev-l13: canonical status enum is the single source of truth ----------


def test_canonical_status_sets_are_internally_consistent():
    """state.STATUSES, the frozensets, and the Status Literal agree.

    state.py is the single source of truth for the status enum (rev-l13).
    The ordered tuple (STATUSES), the membership frozensets
    (TERMINAL/NON_TERMINAL/ALL), and the typing Literal (Status) must all
    describe exactly the same nine values, or a consumer that trusts one will
    silently diverge from one that trusts another.
    """
    from typing import get_args

    # The ordered tuple has no dupes and matches the union of the two sets.
    assert len(state.STATUSES) == len(set(state.STATUSES))
    assert set(state.STATUSES) == state.ALL_STATUSES
    # Terminal and non-terminal partition ALL (disjoint + covering).
    assert state.TERMINAL_STATUSES.isdisjoint(state.NON_TERMINAL_STATUSES)
    assert state.TERMINAL_STATUSES | state.NON_TERMINAL_STATUSES == state.ALL_STATUSES
    # The typing Literal stays in sync with the runtime sets.
    assert set(get_args(state.Status)) == state.ALL_STATUSES


def test_status_consumer_orderings_cover_all_statuses():
    """Presentation orderings in other modules enumerate exactly ALL_STATUSES.

    cli._format_status_human's `headline_order` and commit._SUMMARY_STATUSES
    are display orderings (deliberately not the spec §7.3 order), but their
    *membership* must match the canonical set so no status is ever dropped
    from a status line or commit summary. This pins them without forcing the
    canonical order onto presentation code (rev-l13).
    """
    from review_pdf_to_latex import cli as _cli
    from review_pdf_to_latex import commit as _commit

    assert set(_commit._SUMMARY_STATUSES) == state.ALL_STATUSES
    assert len(_commit._SUMMARY_STATUSES) == len(state.ALL_STATUSES)  # no dupes
    assert set(_cli._STATUS_HEADLINE_ORDER) == state.ALL_STATUSES
    assert len(_cli._STATUS_HEADLINE_ORDER) == len(state.ALL_STATUSES)  # no dupes


@pytest.mark.parametrize(
    "from_status,to_status,action",
    [
        # Apply: any non-terminal → applied (engine-internal action used by
        # `review-pdf apply` from Phase 1 batch apply and Phase 2a/2b re-apply).
        ("pending", "applied", "apply"),
        ("applied", "applied", "apply"),
        ("rejected", "applied", "apply"),
        ("redrafted", "applied", "apply"),
        ("needs_review", "applied", "apply"),
        ("surfaced_pending", "applied", "apply"),
        # Approve: applied → accepted; redrafted → accepted (spec §10.3)
        ("applied", "accepted", "approve"),
        ("redrafted", "accepted", "approve"),
        # Reject: applied → rejected; redrafted → rejected (spec §10.3)
        ("applied", "rejected", "reject"),
        ("redrafted", "rejected", "reject"),
        # Redraft: applied → redrafted; rejected → redrafted;
        # redrafted → redrafted (spec §10.3 — successive redrafts allowed)
        ("applied", "redrafted", "redraft"),
        ("rejected", "redrafted", "redraft"),
        ("redrafted", "redrafted", "redraft"),
        # Skip: pending|applied|redrafted|rejected|needs_review|surfaced_pending → deferred
        ("pending", "deferred", "skip"),
        ("applied", "deferred", "skip"),
        ("redrafted", "deferred", "skip"),
        ("rejected", "deferred", "skip"),
        ("needs_review", "deferred", "skip"),
        ("surfaced_pending", "deferred", "skip"),
        # Surface: pending|applied|deferred|needs_review → surfaced_pending (spec §10.3)
        ("pending", "surfaced_pending", "surface"),
        ("applied", "surfaced_pending", "surface"),
        ("deferred", "surfaced_pending", "surface"),
        ("needs_review", "surfaced_pending", "surface"),
        # Phase 1 failure recovery: applied → needs_review via revert --failure-log
        # (spec §9.2, §12.2)
        ("applied", "needs_review", "redraft"),
        # Phase 2b resolution: surfaced_pending → surfaced_resolved (spec §9.4)
        ("surfaced_pending", "surfaced_resolved", "resolve-surface"),
    ],
)
def test_validate_status_transition_legal(
    from_status: str, to_status: str, action: str
):
    """Every legal transition documented in spec §10.3 returns True."""
    assert state.validate_status_transition(from_status, to_status, action) is True


@pytest.mark.parametrize(
    "from_status,to_status,action",
    [
        # Cannot approve from pending — must apply first
        ("pending", "accepted", "approve"),
        # Cannot reject something that was never applied
        ("pending", "rejected", "reject"),
        # Cannot un-defer back to pending
        ("deferred", "pending", "skip"),
        # Cannot surface a terminal accepted annotation (spec §10.3 — Surface
        # column shows pending|applied|deferred|needs_review only)
        ("accepted", "surfaced_pending", "surface"),
        ("rejected", "surfaced_pending", "surface"),
        # Cannot resolve-surface from a non-surface status
        ("applied", "surfaced_resolved", "resolve-surface"),
        # Approve does not lead to redrafted
        ("applied", "redrafted", "approve"),
    ],
)
def test_validate_status_transition_illegal_raises(
    from_status: str, to_status: str, action: str
):
    """Illegal transitions raise IllegalTransitionError."""
    with pytest.raises(state.IllegalTransitionError):
        state.validate_status_transition(from_status, to_status, action)


def test_validate_status_transition_override_mapping_is_status_neutral():
    """override-mapping does not transition annotation status (it edits mapping.json).

    The action is included in the action enum (spec §10.6) but every call
    with this action must be a no-op transition (from == to).
    """
    assert (
        state.validate_status_transition("needs_review", "needs_review", "override-mapping")
        is True
    )
    with pytest.raises(state.IllegalTransitionError):
        state.validate_status_transition("needs_review", "applied", "override-mapping")


def test_validate_status_transition_unknown_action_raises():
    """An unrecognized action raises IllegalTransitionError."""
    with pytest.raises(state.IllegalTransitionError, match="unknown action"):
        state.validate_status_transition("applied", "accepted", "explode")


import hashlib

from review_pdf_to_latex import state


def _write_annotations_doc(state_dir: Path, source_pdf: Path, md5: str | None) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "schema_version": 1,
        "source_pdf": str(source_pdf.resolve()),
        "extracted_at": "2026-05-16T00:00:00Z",
        "extractor": "pdfannots-0.4.1",
        "annotations": [],
    }
    if md5 is not None:
        doc["source_pdf_md5"] = md5
    (state_dir / "annotations.json").write_text(
        json.dumps(doc), encoding="utf-8",
    )


def test_assert_source_pdf_unchanged_passes_when_md5_matches(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake content")
    md5 = hashlib.md5(pdf.read_bytes()).hexdigest()
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, md5)
    # Should not raise.
    state.assert_source_pdf_unchanged(sd)


def test_assert_source_pdf_unchanged_raises_when_md5_differs(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    pdf.write_bytes(b"%PDF-1.4 original")
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, "deadbeef" * 4)  # 32-char garbage hash
    with pytest.raises(state.SourcePdfChangedError, match="source PDF changed"):
        state.assert_source_pdf_unchanged(sd)


def test_assert_source_pdf_unchanged_raises_when_pdf_missing(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, "deadbeef" * 4)
    # PDF was deleted between extract and apply.
    with pytest.raises(state.SourcePdfChangedError, match="not found"):
        state.assert_source_pdf_unchanged(sd)


def test_assert_source_pdf_unchanged_legacy_state_raises(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    pdf.write_bytes(b"%PDF-1.4 content")
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, md5=None)  # No source_pdf_md5 field
    with pytest.raises(state.LegacyStateError, match="extract --force"):
        state.assert_source_pdf_unchanged(sd)


def test_file_md5_caches_by_path_mtime_size(tmp_path: Path, monkeypatch) -> None:
    """rev-l12: a second hash of an unchanged file is served from cache."""
    p = tmp_path / "src.pdf"
    p.write_bytes(b"%PDF-1.4 cache me")
    state._MD5_CACHE.clear()

    first = state._file_md5(p)
    assert hashlib.md5(p.read_bytes()).hexdigest() == first

    # On the second call the file must not be re-opened (cache hit).
    real_open = Path.open
    opens = {"n": 0}

    def counting_open(self, *args, **kwargs):
        if self == p:
            opens["n"] += 1
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", counting_open)
    second = state._file_md5(p)

    assert second == first
    assert opens["n"] == 0


def test_file_md5_recomputes_when_size_changes(tmp_path: Path) -> None:
    """A changed file (new size) invalidates the cache key and re-hashes."""
    p = tmp_path / "src.pdf"
    p.write_bytes(b"%PDF-1.4 short")
    state._MD5_CACHE.clear()

    first = state._file_md5(p)
    p.write_bytes(b"%PDF-1.4 a longer different body")
    second = state._file_md5(p)

    assert second != first
    assert second == hashlib.md5(p.read_bytes()).hexdigest()
