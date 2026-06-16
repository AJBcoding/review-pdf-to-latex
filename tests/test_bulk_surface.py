"""Tests for the ``bulk-surface`` engine subcommand (rev-l13).

``bulk-surface`` is the ``--order surface-first`` shortcut (spec §9.5, rev-bwi):
it promotes every ``status=pending`` annotation whose ``annotations.json`` entry
has ``trigger_match: true`` to ``surfaced_pending``, leaving everything else
untouched. The behaviour lived only behind the live viewer until now; this
module covers the CLI surface directly (the engine contract the polecat skill
consumes), including the uniform ``--json`` envelope.

Coverage:
- the promotion predicate (pending AND trigger_match), and what it skips;
- human stdout (``promoted N: id1 id2`` / ``promoted 0``);
- ``--json`` success payload (``{"promoted": [...]}``);
- the source-PDF guard error path, in both human and ``--json`` modes;
- exit codes (0 on success, 21 when the source PDF changed).
"""

import hashlib
import json
from pathlib import Path

import pytest

from review_pdf_to_latex import cli


def _make_bulk_surface_project(
    tmp_path: Path, *, source_pdf_md5: str | None = None
) -> Path:
    """Build a project wired for ``bulk-surface`` and return its root.

    Three annotations exercise every branch of the promotion predicate:

    - ``ann-trig-pending``: trigger_match + pending          → promoted
    - ``ann-trig-applied``: trigger_match but already applied → skipped
    - ``ann-plain-pending``: pending but no trigger_match     → skipped

    ``source_pdf_md5`` overrides the recorded MD5 so the source-PDF guard can
    be tripped on demand; by default the real fixture MD5 is recorded so the
    guard passes.
    """
    project = tmp_path / "proj"
    project.mkdir()

    pdf = project / "source.pdf"
    pdf.write_bytes(b"%PDF-1.4 fixture\n")
    md5 = source_pdf_md5 or hashlib.md5(pdf.read_bytes()).hexdigest()

    state_dir = project / ".review-state"
    state_dir.mkdir()

    def _entry(status: str) -> dict:
        return {
            "status": status,
            "before_text": None,
            "proposed_text": None,
            "applied_text": None,
            "applied_at": None,
            "last_build_id": None,
            "surface_chat_log": None,
            "failure_log_path": None,
            "failure_edit_text": None,
        }

    state = {
        "schema_version": 2,
        "phase": "1-batch",
        "order": "surface-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-trig-pending": _entry("pending"),
            "ann-trig-applied": _entry("applied"),
            "ann-plain-pending": _entry("pending"),
        },
        "builds": [],
    }

    def _ann(ann_id: str, trigger: bool) -> dict:
        return {
            "id": ann_id,
            "page": 1,
            "bbox": [0, 0, 0, 0],
            "highlighted_text": "",
            "author": "anon",
            "comment": "c",
            "created": "2026-05-15T14:22:11Z",
            "trigger_match": trigger,
        }

    annotations = {
        "schema_version": 2,
        "source_pdf": str(pdf.resolve()),
        "source_pdf_md5": md5,
        "extracted_at": "2026-05-16T20:30:00Z",
        "extractor": "pdfannots-fake",
        "annotations": [
            _ann("ann-trig-pending", True),
            _ann("ann-trig-applied", True),
            _ann("ann-plain-pending", False),
        ],
    }

    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "annotations.json").write_text(
        json.dumps(annotations), encoding="utf-8"
    )
    # mapping.json is not consulted by bulk-surface, but keep the directory
    # shaped like a real project so unrelated readers don't choke.
    (state_dir / "mapping.json").write_text(
        json.dumps({"schema_version": 2, "mappings": {}}), encoding="utf-8"
    )
    return project


def _statuses(project: Path) -> dict[str, str]:
    state = json.loads(
        (project / ".review-state" / "state.json").read_text(encoding="utf-8")
    )
    return {k: v["status"] for k, v in state["annotations"].items()}


def test_bulk_surface_promotes_only_pending_trigger_matches(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    project = _make_bulk_surface_project(tmp_path)
    rc = cli.main(["--project-dir", str(project), "bulk-surface"])
    assert rc == cli.EXIT_OK

    statuses = _statuses(project)
    assert statuses["ann-trig-pending"] == "surfaced_pending"  # promoted
    assert statuses["ann-trig-applied"] == "applied"  # skipped (not pending)
    assert statuses["ann-plain-pending"] == "pending"  # skipped (no trigger)


def test_bulk_surface_human_output_lists_promoted_ids(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    project = _make_bulk_surface_project(tmp_path)
    cli.main(["--project-dir", str(project), "bulk-surface"])
    out = capsys.readouterr().out.strip()
    assert out == "promoted 1: ann-trig-pending"


def test_bulk_surface_json_output_emits_promoted_array(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    project = _make_bulk_surface_project(tmp_path)
    rc = cli.main(["--project-dir", str(project), "--json", "bulk-surface"])
    assert rc == cli.EXIT_OK
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload == {"promoted": ["ann-trig-pending"]}


def test_bulk_surface_idempotent_second_run_promotes_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    project = _make_bulk_surface_project(tmp_path)
    cli.main(["--project-dir", str(project), "bulk-surface"])
    capsys.readouterr()  # drain first-run output

    rc = cli.main(["--project-dir", str(project), "bulk-surface"])
    assert rc == cli.EXIT_OK
    assert capsys.readouterr().out.strip() == "promoted 0"
    # No further mutation: the already-promoted annotation stays put.
    assert _statuses(project)["ann-trig-pending"] == "surfaced_pending"


def test_bulk_surface_json_empty_promotion(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    project = _make_bulk_surface_project(tmp_path)
    cli.main(["--project-dir", str(project), "bulk-surface"])
    capsys.readouterr()

    rc = cli.main(["--project-dir", str(project), "--json", "bulk-surface"])
    assert rc == cli.EXIT_OK
    assert json.loads(capsys.readouterr().out.strip()) == {"promoted": []}


def test_bulk_surface_source_pdf_changed_exits_21(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """A stale source_pdf_md5 trips the guard before any promotion (exit 21)."""
    project = _make_bulk_surface_project(tmp_path, source_pdf_md5="deadbeef" * 4)
    rc = cli.main(["--project-dir", str(project), "bulk-surface"])
    assert rc == cli.EXIT_SOURCE_PDF_CHANGED
    # Guard aborts before writing: the candidate is untouched.
    assert _statuses(project)["ann-trig-pending"] == "pending"
    assert "error" in capsys.readouterr().err.lower()


def test_bulk_surface_source_pdf_changed_json_envelope(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    """The error path honours the uniform --json envelope (rev-l13)."""
    project = _make_bulk_surface_project(tmp_path, source_pdf_md5="deadbeef" * 4)
    rc = cli.main(["--project-dir", str(project), "--json", "bulk-surface"])
    assert rc == cli.EXIT_SOURCE_PDF_CHANGED
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["exit_code"] == cli.EXIT_SOURCE_PDF_CHANGED
    assert "error" in payload
