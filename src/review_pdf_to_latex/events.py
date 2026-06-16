"""Format-agnostic event bus: state-events.jsonl writer + wait-event poller.

This module owns the ``state-events.jsonl`` contract end-to-end: validating an
inbound event payload (§7.4 schema), appending one JSONL line atomically, and
the blocking ``wait-event`` poller the skill drives from a bash loop (§10.5).

It is deliberately **viewer-free**: nothing here imports
:mod:`review_pdf_to_latex.server` (the HTTP viewer), Jinja, or any rendering
code. The dependency edge points viewer → events, never the reverse, so the
event bus can be reused by any front-end (HTTP viewer, Electron, headless
test harness) without dragging in the viewer.

See spec sections:
- §7.4 — state-events.jsonl line schema and action enum.
- §8 — wait-event CLI row (exit codes).
- §10.5 — blocking-call lifecycle (signals, compaction, timeout).
"""

from __future__ import annotations

import fcntl
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from review_pdf_to_latex.exit_codes import (
    EXIT_OK,
    EXIT_STATE_MISSING,
    EXIT_WAIT_TIMEOUT,
)

# Ctrl-C during wait-event exits 128 + SIGINT(2) by shell convention. Not part
# of the spec-§8 contract table, so it stays a documented literal here rather
# than a named exit_codes.py constant.
_EXIT_SIGINT = 130

EVENTS_FILENAME = "state-events.jsonl"
STATE_DIR_NAME = ".review-state"  # mirrors state.STATE_DIR_NAME for module independence

_VALID_ACTIONS = frozenset(
    {
        "approve",
        "reject",
        "redraft",
        "preview",
        "skip",
        "surface",
        "override-mapping",
        "navigate",
    }
)
_VALID_NAVIGATE_DIRECTIONS = frozenset({"next", "previous"})
_VALID_NAVIGATE_VIEWS = frozenset({"unresolved", "all"})


class _BadRequest(Exception):
    """Raised by validation helpers to short-circuit do_POST with a 400 body."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _utc_now_iso() -> str:
    """ISO8601 UTC timestamp with microsecond precision and a ``Z`` suffix.

    rev-l7: the cursor that ``wait-event --since`` compares against is the ``ts``
    string itself (``ts > since_ts``, lexicographic). The original format used
    ``timespec="seconds"``, so two events appended within the same wall-clock
    second carried identical ``ts`` values; the second one was silently dropped
    because ``ts > since`` is false when they are equal. Microsecond precision
    makes every appended event's ``ts`` strictly monotonic for a single writer,
    closing the same-second drop while preserving the §7.4 ``…Z`` shape and the
    cheap string-comparison cursor (no schema-version bump, no seq field).
    """
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _validate_event(payload: object) -> dict[str, Any]:
    """Validate a parsed JSON payload against the §7.4 schema.

    Returns the cleaned record (no ts).

    For action == "override-mapping" (spec §10.6), the payload MUST also
    include `file: str`, `line_start: int`, `line_end: int`. These are
    threaded through into the JSONL record so the consuming skill (via
    `review-pdf wait-event`) can reconstruct the override and invoke
    `review-pdf override-mapping --file <f> --lines START:END`.
    """
    if not isinstance(payload, dict):
        raise _BadRequest("body must be a JSON object")
    ann = payload.get("annotation_id")
    if not isinstance(ann, str) or not ann:
        raise _BadRequest("missing field: annotation_id")
    action = payload.get("action")
    if not isinstance(action, str) or not action:
        raise _BadRequest("missing field: action")
    if action not in _VALID_ACTIONS:
        raise _BadRequest(f"invalid action: {action}")
    record: dict[str, Any] = {"annotation_id": ann, "action": action}
    if "speculative_text" in payload:
        spec_text = payload["speculative_text"]
        if not isinstance(spec_text, str):
            raise _BadRequest("speculative_text must be a string")
        record["speculative_text"] = spec_text
    if action == "navigate":
        # Status-neutral navigation (rev-bus). The engine maps
        # direction to the next/previous annotation_id and calls
        # apply.set_current_annotation; no status changes.
        direction = payload.get("direction")
        if not isinstance(direction, str) or direction not in _VALID_NAVIGATE_DIRECTIONS:
            raise _BadRequest(
                "missing field: direction (must be 'next' or 'previous' for navigate)"
            )
        record["direction"] = direction
        # Optional view filter (rev-3pm). 'unresolved' (default) walks the
        # non-terminal subset to match the viewer's default counter; 'all'
        # walks every annotation in extraction order. Anything else falls
        # back to 'unresolved' to keep the silent-no-op contract closed.
        view = payload.get("view", "unresolved")
        if not isinstance(view, str) or view not in _VALID_NAVIGATE_VIEWS:
            view = "unresolved"
        record["view"] = view
    if action == "override-mapping":
        # Required override-mapping fields per spec §10.6.
        file_val = payload.get("file")
        if not isinstance(file_val, str) or not file_val:
            raise _BadRequest(
                "missing field: file (required for override-mapping)"
            )
        line_start = payload.get("line_start")
        if (
            not isinstance(line_start, int)
            or isinstance(line_start, bool)
            or line_start < 1
        ):
            raise _BadRequest(
                "missing field: line_start (positive int required for override-mapping)"
            )
        line_end = payload.get("line_end")
        if (
            not isinstance(line_end, int)
            or isinstance(line_end, bool)
            or line_end < line_start
        ):
            raise _BadRequest(
                "missing field: line_end (int >= line_start required for override-mapping)"
            )
        record["file"] = file_val
        record["line_start"] = line_start
        record["line_end"] = line_end
    return record


def _append_event_line(events_path: Path, record: dict[str, Any]) -> None:
    """Append one JSONL line to events_path; fcntl.flock-serialized."""
    events_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
    data = line.encode("utf-8")
    fd = os.open(str(events_path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            written = 0
            while written < len(data):
                n = os.write(fd, data[written:])
                if n <= 0:
                    raise OSError("short write to state-events.jsonl")
                written += n
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


_POLL_INTERVAL_SEC = 0.25
_SENTINEL_TS = "1970-01-01T00:00:00Z"


def _read_last_event_ts(events_path: Path) -> str:
    """Return the ts of the last well-formed event in events_path, or the sentinel."""
    if not events_path.exists():
        return _SENTINEL_TS
    try:
        text = events_path.read_text()
    except OSError:
        return _SENTINEL_TS
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = obj.get("ts")
        if isinstance(ts, str):
            return ts
    return _SENTINEL_TS


def wait_for_events(
    events_path: Path,
    since_ts: str | None,
    timeout_sec: int = 60,
) -> list[dict[str, Any]]:
    """Block until new event(s) appear in events_path, or timeout fires.

    Returns the events with ts > since_ts (in file order) on growth, [] on timeout.

    Defaults:
    - If since_ts is None, use the ts of the last existing event in the file
      (or "1970-01-01T00:00:00Z" if the file is empty/missing).

    Side effects: NONE. The function only reads events_path; it never writes.
    (The kqueue watcher watches the parent directory rather than touching the
    events file into existence — see ``_make_watcher`` — so a missing file is
    never created as a side effect of waiting.)

    Lifecycle properties (spec §10.5):
    - Browser closed mid-wait: invisible to this function. The function tails a
      file, not a socket; closing the browser does not affect the wait. The
      caller (skill) re-opens its loop normally.
    - Server crashed mid-wait: this function continues polling; the caller is
      responsible for noticing serve.lock disappearance and re-launching serve.
    - SIGTERM mid-wait: handled by the wait-event CLI wrapper in cli.py
      (see Task 8.7), which catches the signal and exits 0 with no output.
    - SIGINT mid-wait: also handled by the CLI wrapper — exit 130 (standard).
    """
    events_path = Path(events_path)
    if since_ts is None:
        since_ts = _read_last_event_ts(events_path)

    last_size = events_path.stat().st_size if events_path.exists() else 0
    pending_partial = b""
    watcher = _make_watcher(events_path)
    deadline = time.monotonic() + timeout_sec

    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return []

            # Wait for change. Prefer the watcher if available; otherwise sleep.
            slice_sec = min(remaining, _POLL_INTERVAL_SEC)
            if watcher is not None:
                try:
                    watcher.wait(slice_sec)
                except OSError:
                    time.sleep(slice_sec)
            else:
                time.sleep(slice_sec)

            if not events_path.exists():
                continue

            try:
                cur_size = events_path.stat().st_size
            except FileNotFoundError:
                continue

            if cur_size < last_size:
                # Truncation: reset and rescan from start.
                last_size = 0
                pending_partial = b""

            if cur_size == last_size:
                continue

            # Read the new bytes.
            try:
                with events_path.open("rb") as f:
                    f.seek(last_size)
                    new_bytes = f.read(cur_size - last_size)
            except OSError:
                continue
            last_size = cur_size

            chunk = pending_partial + new_bytes
            lines = chunk.split(b"\n")
            # Last element after split is the partial tail (empty if chunk ends with \n).
            pending_partial = lines[-1]
            complete_lines = lines[:-1]

            fresh: list[dict[str, Any]] = []
            for raw_line in complete_lines:
                if not raw_line.strip():
                    continue
                try:
                    obj = json.loads(raw_line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if not isinstance(obj, dict):
                    continue
                ts = obj.get("ts")
                if not isinstance(ts, str):
                    continue
                if ts > since_ts:
                    fresh.append(obj)
            if fresh:
                return fresh
    finally:
        if watcher is not None:
            try:
                watcher.close()
            except Exception:
                pass


def _make_watcher(path: Path):  # noqa: ANN201 (returns watcher or None)
    """Return a watcher object with .wait(timeout) and .close(), or None.

    Best-effort: silently falls back to None (stat-poll only) on any error.

    Side-effect-free for a missing target: when ``path`` does not yet exist the
    watcher watches the *parent directory* (both inotify and kqueue surface a
    directory-write notification when a file is created inside it). It never
    creates ``path`` itself — ``wait_for_events`` documents "Side effects: NONE",
    and an earlier kqueue branch violated that by ``path.touch()``-ing the events
    file into existence (rev-l7).
    """
    # Try inotify_simple (Linux). Not in our dep list — only used if installed.
    try:
        import inotify_simple  # type: ignore[import-not-found]  # pragma: no cover
        from inotify_simple import flags  # type: ignore[import-not-found]  # pragma: no cover

        if not path.parent.exists():  # pragma: no cover
            return None
        inot = inotify_simple.INotify()  # pragma: no cover
        inot.add_watch(str(path.parent), flags.MODIFY | flags.CREATE)  # pragma: no cover

        class _InotifyWatcher:  # pragma: no cover
            def wait(self, timeout: float) -> None:
                inot.read(timeout=int(timeout * 1000))

            def close(self) -> None:
                inot.close()

        return _InotifyWatcher()  # pragma: no cover
    except ImportError:
        pass
    except OSError:
        pass

    # Try kqueue (macOS / BSD).
    try:
        import select

        if not hasattr(select, "kqueue"):
            return None
        # kqueue VNODE needs a real fd. Watch the file when it exists, else the
        # parent directory — KQ_NOTE_WRITE on a dir fires when an entry (the
        # events file) is created inside it. This avoids creating the events
        # file as a side effect of merely waiting for it.
        if path.exists():
            watch_target = path
        elif path.parent.exists():
            watch_target = path.parent
        else:
            return None

        kq = select.kqueue()
        fd = os.open(str(watch_target), os.O_RDONLY)
        kev = select.kevent(
            fd,
            filter=select.KQ_FILTER_VNODE,
            flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR,
            fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND,
        )
        kq.control([kev], 0, 0)

        class _KqueueWatcher:
            def wait(self, timeout: float) -> None:
                kq.control([], 1, timeout)

            def close(self) -> None:
                try:
                    kq.close()
                finally:
                    os.close(fd)

        return _KqueueWatcher()
    except (ImportError, OSError):
        return None


# ---- Task 8.7: blocking-call lifecycle (signals + compaction) --------------
#
# Sentinel exceptions raised by signal handlers installed around
# `wait_for_events` to translate POSIX signals into deterministic CLI exits:
#
# | Spec §10.5 bullet | Behavior |
# |---|---|
# | Idle wait timeout | wait_for_events returns []; CLI exits 20. |
# | Browser closed mid-wait | Invisible (we tail a file, not a socket). |
# | Context compaction (SIGTERM) | _SigTermExit → CLI exits 0, no stdout. |
# | User Ctrl-C (SIGINT) | _SigIntExit → CLI exits 130 (128 + SIGINT=2). |
#
# The compaction case (SIGTERM) is what makes this non-default: the standard
# Python handler treats SIGTERM as fatal with rc != 0, but the skill needs
# the post-compaction re-call (with --since <last_observed_ts>) to be able
# to pick up any concurrent event from the file without false positives.


class _SigTermExit(BaseException):
    """Raised internally when SIGTERM arrives during wait-event."""


class _SigIntExit(BaseException):
    """Raised internally when SIGINT arrives during wait-event."""


def _install_wait_event_signal_handlers() -> tuple[Any, Any]:
    """Install SIGTERM/SIGINT handlers that raise our sentinels.

    Returns (prev_sigterm, prev_sigint) so the caller can restore them
    via ``signal.signal`` in a finally block. Used by ``handle_wait_event``
    (wired by the CLI batcher in chunk A) to bracket the blocking
    ``wait_for_events`` call.
    """

    def _sigterm(signum: int, frame: Any) -> None:
        raise _SigTermExit()

    def _sigint(signum: int, frame: Any) -> None:
        raise _SigIntExit()

    prev_term = signal.signal(signal.SIGTERM, _sigterm)
    prev_int = signal.signal(signal.SIGINT, _sigint)
    return prev_term, prev_int


def handle_wait_event(
    *,
    project_dir: Path,
    since: str | None,
    timeout: int,
) -> int:
    """Implement ``review-pdf wait-event``. Returns exit code.

    Spec §10.5 lifecycle handling:
    - Idle timeout: wait_for_events returns []; exit 20.
    - Browser closed mid-wait: invisible (we tail a file, not a socket).
    - Context compaction (SIGTERM): exit 0, no stdout. Post-compaction
      skill re-call with --since picks up any concurrent event.
    - User Ctrl-C (SIGINT): exit 130 (standard, 128 + SIGINT=2).
    """
    project_dir = Path(project_dir).resolve()
    state_path = project_dir / STATE_DIR_NAME / "state.json"
    if not state_path.exists():
        sys.stderr.write("state missing; run 'review-pdf extract' first\n")
        return EXIT_STATE_MISSING

    events_path = project_dir / STATE_DIR_NAME / EVENTS_FILENAME

    prev_term, prev_int = _install_wait_event_signal_handlers()
    try:
        try:
            events = wait_for_events(
                events_path, since_ts=since, timeout_sec=timeout,
            )
        except _SigTermExit:
            return EXIT_OK
        except _SigIntExit:
            return _EXIT_SIGINT
        if not events:
            return EXIT_WAIT_TIMEOUT
        for event in events:
            sys.stdout.write(
                json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"
            )
        sys.stdout.flush()
        return EXIT_OK
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        signal.signal(signal.SIGINT, prev_int)
