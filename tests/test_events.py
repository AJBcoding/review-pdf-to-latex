"""Tests for review_pdf_to_latex.events (the format-agnostic event bus).

This module was extracted from server.py in rev-l7. The polling/validation
behaviours that previously lived under ``test_server.py`` continue to exercise
``server.wait_for_events`` (re-exported), so the tests here focus on:

- the event-bus contract at its own module boundary (import hygiene);
- the rev-l7 ``--since`` same-second-drop fix (microsecond ``ts``);
- ``handle_wait_event`` end-to-end, which previously had no functional test
  (only CLI arg-parsing coverage) — the "missing tests" called out on rev-l7;
- the rev-l7 kqueue side-effect fix (waiting never creates the events file).
"""

from __future__ import annotations

import json
import os
import signal
import threading
import time
from pathlib import Path

import pytest

from review_pdf_to_latex import events
from review_pdf_to_latex.exit_codes import (
    EXIT_OK,
    EXIT_STATE_MISSING,
    EXIT_WAIT_TIMEOUT,
)


# ---- module boundary: zero viewer imports ----------------------------------


def test_events_module_has_no_viewer_imports() -> None:
    """events.py must not import the viewer (server.py): the edge is one-way.

    The dependency direction is viewer → events. If events ever imported
    server we'd risk a cycle and defeat the point of the extraction.
    """
    source = Path(events.__file__).read_text()
    assert "import server" not in source
    assert "from review_pdf_to_latex.server" not in source
    assert "import review_pdf_to_latex.server" not in source
    # And no viewer/rendering symbols leaked into the event bus.
    assert not hasattr(events, "ReviewHandler")
    assert not hasattr(events, "build_server")


def test_events_exposes_extracted_symbols() -> None:
    """The four functions named in rev-l7's done-criteria live here."""
    for name in (
        "_validate_event",
        "_append_event_line",
        "wait_for_events",
        "handle_wait_event",
    ):
        assert hasattr(events, name), f"events.{name} must be exposed"
    assert events.EVENTS_FILENAME == "state-events.jsonl"


# ---- _utc_now_iso: sub-second precision (rev-l7 --since fix) ----------------


def test_utc_now_iso_has_microsecond_precision_and_z_suffix() -> None:
    """ts must carry sub-second precision so same-second events don't collide."""
    ts = events._utc_now_iso()
    assert ts.endswith("Z")
    assert "+00:00" not in ts
    # "2026-06-15T12:00:00.123456Z" — a dot plus 6 fractional digits.
    frac = ts[:-1].split(".")
    assert len(frac) == 2, f"expected fractional seconds, got {ts!r}"
    assert len(frac[1]) == 6, f"expected microsecond precision, got {ts!r}"
    assert frac[1].isdigit()


def test_utc_now_iso_is_non_decreasing_within_a_second() -> None:
    """Successive timestamps in the same wall-clock second stay ordered."""
    stamps = [events._utc_now_iso() for _ in range(50)]
    assert stamps == sorted(stamps)


# ---- the regression: same-second events are NOT dropped by --since ----------


def test_back_to_back_timestamps_are_distinct_within_a_second(tmp_path: Path) -> None:
    """rev-l7 root cause: two events in the same wall second need distinct ts.

    The old ``timespec="seconds"`` format gave them identical ``ts`` values;
    the consumer's ``ts > since`` cursor then dropped the second one. The two
    appends below happen as fast as possible — overwhelmingly the same wall
    second — yet microsecond precision keeps their timestamps strictly ordered.
    """
    events_path = tmp_path / "state-events.jsonl"
    rec1 = {"ts": events._utc_now_iso(), "annotation_id": "ann-001", "action": "approve"}
    events._append_event_line(events_path, rec1)
    rec2 = {"ts": events._utc_now_iso(), "annotation_id": "ann-002", "action": "reject"}
    events._append_event_line(events_path, rec2)

    lines = [json.loads(ln) for ln in events_path.read_text().splitlines()]
    assert [r["annotation_id"] for r in lines] == ["ann-001", "ann-002"]
    assert lines[0]["ts"] != lines[1]["ts"], "same-second ts must not collide"
    assert lines[1]["ts"] > lines[0]["ts"]


def test_same_second_followup_event_is_not_dropped_by_since(tmp_path: Path) -> None:
    """End-to-end: a consumer that saw event #1 still receives event #2.

    A consumer's loop is ``wait-event --since <ts-of-last-seen>``. Here #1 is
    already on disk (cursor = its ts) and #2 is appended in the *same wall
    second* while ``wait_for_events`` is tailing. Under the old seconds-only
    format #2 shared #1's ts and ``ts > since`` dropped it (timeout, []);
    microsecond ts makes #2.ts strictly greater, so it is delivered.
    """
    events_path = tmp_path / "state-events.jsonl"
    rec1 = {"ts": events._utc_now_iso(), "annotation_id": "ann-001", "action": "approve"}
    events._append_event_line(events_path, rec1)
    cursor = rec1["ts"]

    def writer() -> None:
        time.sleep(0.2)
        events._append_event_line(
            events_path,
            {"ts": events._utc_now_iso(), "annotation_id": "ann-002", "action": "reject"},
        )

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    fresh = events.wait_for_events(events_path, since_ts=cursor, timeout_sec=3)
    t.join(timeout=2)
    assert [r["annotation_id"] for r in fresh] == ["ann-002"]
    assert fresh[0]["ts"] > cursor


# ---- _validate_event: schema enforcement -----------------------------------


def test_validate_event_minimal_ok() -> None:
    rec = events._validate_event({"annotation_id": "ann-1", "action": "approve"})
    assert rec == {"annotation_id": "ann-1", "action": "approve"}


def test_validate_event_rejects_non_dict() -> None:
    with pytest.raises(events._BadRequest):
        events._validate_event(["not", "a", "dict"])


def test_validate_event_rejects_unknown_action() -> None:
    with pytest.raises(events._BadRequest):
        events._validate_event({"annotation_id": "ann-1", "action": "explode"})


def test_validate_event_navigate_requires_direction() -> None:
    with pytest.raises(events._BadRequest):
        events._validate_event({"annotation_id": "ann-1", "action": "navigate"})


def test_validate_event_navigate_defaults_view_to_unresolved() -> None:
    rec = events._validate_event(
        {"annotation_id": "ann-1", "action": "navigate", "direction": "next"}
    )
    assert rec["direction"] == "next"
    assert rec["view"] == "unresolved"


def test_validate_event_override_mapping_requires_lines() -> None:
    with pytest.raises(events._BadRequest):
        events._validate_event(
            {
                "annotation_id": "ann-1",
                "action": "override-mapping",
                "file": "main.tex",
                "line_start": 5,
                "line_end": 3,  # < line_start
            }
        )


# ---- _append_event_line + _read_last_event_ts ------------------------------


def test_append_event_line_appends_in_order(tmp_path: Path) -> None:
    events_path = tmp_path / "nested" / "state-events.jsonl"
    events._append_event_line(events_path, {"ts": "t1", "annotation_id": "a"})
    events._append_event_line(events_path, {"ts": "t2", "annotation_id": "b"})
    lines = events_path.read_text().splitlines()
    assert [json.loads(ln)["annotation_id"] for ln in lines] == ["a", "b"]


def test_read_last_event_ts_returns_sentinel_when_missing(tmp_path: Path) -> None:
    assert events._read_last_event_ts(tmp_path / "nope.jsonl") == events._SENTINEL_TS


def test_read_last_event_ts_skips_trailing_garbage(tmp_path: Path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.write_text(
        json.dumps({"ts": "2026-05-16T20:47:11.000001Z"}) + "\n" + "garbage\n"
    )
    assert events._read_last_event_ts(events_path) == "2026-05-16T20:47:11.000001Z"


# ---- kqueue side-effect fix: waiting must not create the file ---------------


def test_wait_for_events_does_not_create_missing_file(tmp_path: Path) -> None:
    """wait_for_events documents 'Side effects: NONE'.

    rev-l7: an earlier kqueue branch ``path.touch()``-ed a missing events file
    into existence just to obtain an fd to watch. Watching the parent directory
    instead keeps the wait side-effect-free.
    """
    events_path = tmp_path / "state-events.jsonl"
    assert not events_path.exists()
    result = events.wait_for_events(events_path, since_ts=None, timeout_sec=1)
    assert result == []
    assert not events_path.exists(), "wait must not create the events file"


# ---- handle_wait_event: the previously-untested CLI handler -----------------


def test_handle_wait_event_state_missing(tmp_path: Path) -> None:
    """No state.json → exit 6 (EXIT_STATE_MISSING), nothing on stdout."""
    rc = events.handle_wait_event(project_dir=tmp_path, since=None, timeout=1)
    assert rc == EXIT_STATE_MISSING


def test_handle_wait_event_timeout(minimal_project: Path) -> None:
    """No new event before timeout → exit 20 (EXIT_WAIT_TIMEOUT)."""
    rc = events.handle_wait_event(project_dir=minimal_project, since=None, timeout=1)
    assert rc == EXIT_WAIT_TIMEOUT


def test_handle_wait_event_emits_event_and_returns_ok(
    minimal_project: Path, capsys: pytest.CaptureFixture
) -> None:
    """A fresh event is printed as one JSON line and the handler exits 0."""
    events_path = minimal_project / ".review-state" / events.EVENTS_FILENAME

    def writer() -> None:
        time.sleep(0.2)
        events._append_event_line(
            events_path,
            {
                "ts": events._utc_now_iso(),
                "annotation_id": "ann-LIVE",
                "action": "approve",
            },
        )

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    rc = events.handle_wait_event(
        project_dir=minimal_project, since="1970-01-01T00:00:00Z", timeout=3
    )
    t.join(timeout=2)
    assert rc == EXIT_OK
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1
    emitted = json.loads(out[0])
    assert emitted["annotation_id"] == "ann-LIVE"


def test_handle_wait_event_sigterm_exits_zero_no_output(
    minimal_project: Path, capsys: pytest.CaptureFixture
) -> None:
    """SIGTERM mid-wait (context compaction) → exit 0 with no stdout."""

    def killer() -> None:
        time.sleep(0.2)
        os.kill(os.getpid(), signal.SIGTERM)

    prev_term = signal.getsignal(signal.SIGTERM)
    prev_int = signal.getsignal(signal.SIGINT)
    t = threading.Thread(target=killer, daemon=True)
    t.start()
    try:
        rc = events.handle_wait_event(
            project_dir=minimal_project, since=None, timeout=5
        )
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        signal.signal(signal.SIGINT, prev_int)
    t.join(timeout=2)
    assert rc == EXIT_OK
    assert capsys.readouterr().out == ""


def test_handle_wait_event_sigint_exits_130(minimal_project: Path) -> None:
    """SIGINT mid-wait → exit 130 (128 + SIGINT=2)."""

    def killer() -> None:
        time.sleep(0.2)
        os.kill(os.getpid(), signal.SIGINT)

    prev_term = signal.getsignal(signal.SIGTERM)
    prev_int = signal.getsignal(signal.SIGINT)
    t = threading.Thread(target=killer, daemon=True)
    t.start()
    try:
        rc = events.handle_wait_event(
            project_dir=minimal_project, since=None, timeout=5
        )
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        signal.signal(signal.SIGINT, prev_int)
    t.join(timeout=2)
    assert rc == 130
