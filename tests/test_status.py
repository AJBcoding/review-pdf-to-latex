"""Tests for the read-only status reporter (spec §8 `status`)."""

from __future__ import annotations

from pathlib import Path

import pytest

from review_pdf_to_latex import state as state_mod
from review_pdf_to_latex import status as status_mod


def _seed_state(tmp_project: Path, payload: dict) -> state_mod.StateDir:
    sd = state_mod.StateDir(tmp_project)
    state_mod.atomic_write_json(sd.state_path, payload)
    return sd


def _minimal_state(phase: str = "0-setup") -> dict:
    return {
        "schema_version": 1,
        "phase": phase,
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {},
        "builds": [],
    }


def test_compute_status_report_on_empty_state(tmp_project: Path):
    """Empty annotations dict — all counts zero, last build None."""
    sd = _seed_state(tmp_project, _minimal_state())
    report = status_mod.compute_status_report(sd)

    assert report.phase == "0-setup"
    assert report.order == "mechanical-first"
    assert report.current_annotation_id is None
    assert report.total == 0
    assert report.terminal_count == 0
    assert report.non_terminal_count == 0
    assert report.unresolved_needs_review == 0
    assert report.most_recent_build is None
    # Every status enum key must be present with count 0.
    expected_keys = {
        "pending", "applied", "accepted", "rejected", "redrafted",
        "deferred", "surfaced_pending", "surfaced_resolved", "needs_review",
    }
    assert set(report.counts.keys()) == expected_keys
    assert all(v == 0 for v in report.counts.values())


def test_compute_status_report_counts_each_status(tmp_project: Path):
    """One annotation per status: counts correctly partition terminal vs not."""
    statuses = [
        "pending", "applied", "accepted", "rejected", "redrafted",
        "deferred", "surfaced_pending", "surfaced_resolved", "needs_review",
    ]
    annotations = {}
    for i, s in enumerate(statuses, start=1):
        annotations[f"ann-{i:03d}"] = {
            "status": s,
            "before_text": None,
            "proposed_text": None,
            "applied_text": None,
            "applied_at": None,
            "last_build_id": None,
            "surface_chat_log": None,
            "failure_log_path": None,
            "failure_edit_text": None,
        }
    payload = _minimal_state(phase="2a-ratify")
    payload["annotations"] = annotations
    payload["current_annotation_id"] = "ann-001"
    sd = _seed_state(tmp_project, payload)

    report = status_mod.compute_status_report(sd)
    assert report.phase == "2a-ratify"
    assert report.current_annotation_id == "ann-001"
    assert report.total == 9
    # Terminal: accepted, rejected, redrafted, deferred, surfaced_resolved → 5
    assert report.terminal_count == 5
    # Non-terminal: pending, applied, surfaced_pending, needs_review → 4
    assert report.non_terminal_count == 4
    assert report.unresolved_needs_review == 1
    for s in statuses:
        assert report.counts[s] == 1


def test_compute_status_report_picks_most_recent_build(tmp_project: Path):
    """most_recent_build is the LAST entry of state.builds[]."""
    payload = _minimal_state(phase="1-batch")
    payload["builds"] = [
        {
            "id": "build-001",
            "pdf_path": ".review-state/builds/build-001.pdf",
            "page_count": 24,
            "compiled_at": "2026-05-16T20:00:00Z",
            "log_path": ".review-state/builds/build-001.log",
            "ok": True,
            "page_md5": ["a"] * 24,
        },
        {
            "id": "build-002",
            "pdf_path": ".review-state/builds/build-002.pdf",
            "page_count": 25,
            "compiled_at": "2026-05-16T20:05:00Z",
            "log_path": ".review-state/builds/build-002.log",
            "ok": False,
            "page_md5": [],
        },
    ]
    sd = _seed_state(tmp_project, payload)

    report = status_mod.compute_status_report(sd)
    assert report.most_recent_build is not None
    assert report.most_recent_build["id"] == "build-002"
    assert report.most_recent_build["ok"] is False


def test_compute_status_report_raises_state_missing(tmp_path: Path):
    """A project dir without state.json raises StateMissingError.

    The CLI handler maps that to exit code 6 per spec §8.
    """
    # Note: do NOT use tmp_project fixture (it creates .review-state/).
    sd = state_mod.StateDir(tmp_path)
    with pytest.raises(status_mod.StateMissingError):
        status_mod.compute_status_report(sd)


def test_status_report_to_dict_keys_match_human_format(tmp_project: Path):
    """to_dict() produces a stable shape that the CLI's --json flag consumes."""
    sd = _seed_state(tmp_project, _minimal_state())
    report = status_mod.compute_status_report(sd)
    d = report.to_dict()
    assert set(d.keys()) == {
        "phase",
        "order",
        "current_annotation_id",
        "counts",
        "total",
        "terminal_count",
        "non_terminal_count",
        "unresolved_needs_review",
        "most_recent_build",
    }
