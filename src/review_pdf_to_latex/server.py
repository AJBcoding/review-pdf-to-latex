"""Local HTTP viewer + state-events.jsonl writer + wait-event poller.

The viewer is intentionally tiny: stdlib http.server, Jinja2 templates rendered
on the fly, no JS bundling. The single non-static endpoint is POST /api/events,
which appends one JSONL line to .review-state/state-events.jsonl. The engine
never writes that file; only this server does.

See spec sections:
- §7.4 — state-events.jsonl line schema and action enum.
- §8 — serve and wait-event CLI rows (exit codes).
- §10.5 — click→engine path and blocking-call lifecycle.
- §10.6 — manual-mapping UI dispatch via --mapping-mode.
"""

from __future__ import annotations

import fcntl
import http.server
import json
import mimetypes
import os
import re
import signal
import time
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import jinja2

EVENTS_FILENAME = "state-events.jsonl"
STATE_DIR_NAME = ".review-state"  # mirrors state.STATE_DIR_NAME for module independence

_PAGE_FILENAME_RE = re.compile(r"^page-\d+\.png$")
_BUILD_ID_RE = re.compile(r"^build-\d+$")
_STATIC_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# Package root for template lookups. The templates/ directory lives under the
# review_pdf_to_latex package so it is importable via importlib.resources.
_PACKAGE_ROOT = Path(__file__).resolve().parent
_TEMPLATES_DIR = _PACKAGE_ROOT / "templates"
_STATIC_DIR = _TEMPLATES_DIR / "static"

_jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=jinja2.select_autoescape(["html"]),
    undefined=jinja2.StrictUndefined,
)

_VALID_ACTIONS = frozenset(
    {
        "approve",
        "reject",
        "redraft",
        "preview",
        "skip",
        "surface",
        "override-mapping",
    }
)
_MAX_BODY_BYTES = 64 * 1024


class _BadRequest(Exception):
    """Raised by validation helpers to short-circuit do_POST with a 400 body."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _utc_now_iso() -> str:
    """ISO8601 UTC timestamp matching the spec §7.4 examples (Z suffix, seconds)."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
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


class ReviewHandler(http.server.SimpleHTTPRequestHandler):
    """Routing + rendering. See module docstring for spec links."""

    project_dir: Path = Path(".")
    mode: str = "normal"

    # ---- GET dispatch -------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/":
            self._serve_frame()
            return
        if path == "/api/state":
            self._serve_state_json()
            return
        if path.startswith("/pages/"):
            self._serve_page_png(path[len("/pages/") :])
            return
        if path.startswith("/builds/"):
            self._serve_build_png(path[len("/builds/") :])
            return
        if path.startswith("/static/"):
            self._serve_static_file(path[len("/static/") :])
            return
        self._send_404()

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path != "/api/events":
            self._send_404()
            return
        self._handle_events_post()

    def _handle_events_post(self) -> None:
        # Enforce the body-size cap BEFORE reading so a malicious client can't OOM us.
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_simple(HTTPStatus.BAD_REQUEST, b"invalid Content-Length\n")
            return
        if content_length > _MAX_BODY_BYTES:
            self._send_simple(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE, b"body too large\n"
            )
            return

        events_path = self.project_dir / STATE_DIR_NAME / EVENTS_FILENAME
        if not events_path.parent.exists():
            self._send_simple(
                HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n"
            )
            return

        raw = self.rfile.read(content_length) if content_length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_simple(HTTPStatus.BAD_REQUEST, b"invalid JSON\n")
            return

        try:
            record = _validate_event(payload)
        except _BadRequest as e:
            self._send_simple(
                HTTPStatus.BAD_REQUEST, (e.message + "\n").encode("utf-8")
            )
            return

        # Build the on-disk record: ts first, then annotation_id/action/speculative_text.
        full_record = {"ts": _utc_now_iso(), **record}
        try:
            _append_event_line(events_path, full_record)
        except OSError as e:
            self._send_simple(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                f"append failed: {e}\n".encode(),
            )
            return

        self.send_response(int(HTTPStatus.NO_CONTENT))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    # ---- per-route helpers --------------------------------------------------

    def _serve_frame(self) -> None:
        try:
            body = self._render_frame()
        except FileNotFoundError:
            # state.json missing — degrade to a clean 503 so the viewer can show
            # a "no review session" page; we surface 503 (Service Unavailable)
            # rather than 404 because the URL itself is valid.
            self._send_simple(HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n")
            return
        self._send_bytes(HTTPStatus.OK, body, "text/html; charset=utf-8")

    def _render_frame(self) -> bytes:
        """Render frame.html. The template branches on `mode` ("normal" or "mapping").

        Loads state.json + annotations.json + mapping.json and assembles the
        Jinja context required by ``templates/frame.html`` and the included
        ``templates/annotation.html``. Both are rendered with
        ``jinja2.StrictUndefined``, so every variable they reference must be
        present in the returned context.
        """
        state_dir = self.project_dir / STATE_DIR_NAME
        state_path = state_dir / "state.json"
        annotations_path = state_dir / "annotations.json"
        mapping_path = state_dir / "mapping.json"

        current_state: dict[str, Any] = json.loads(state_path.read_text())
        annotations_doc = json.loads(annotations_path.read_text())
        mapping_doc = json.loads(mapping_path.read_text())

        annotations_list: list[dict[str, Any]] = annotations_doc.get(
            "annotations", []
        )
        mappings: dict[str, dict[str, Any]] = mapping_doc.get("mappings", {})

        current_id = current_state.get("current_annotation_id")
        if current_id is None and annotations_list:
            current_id = annotations_list[0]["id"]

        by_id = {a["id"]: a for a in annotations_list}
        current_annotation = by_id.get(current_id) if current_id else None

        annotation_index = 0
        if current_id and current_id in by_id:
            annotation_index = (
                list(by_id.keys()).index(current_id) + 1
            )

        diff2html_present = (_STATIC_DIR / "diff2html.min.js").exists()

        context: dict[str, Any] = {
            "current_state": current_state,
            "mode": self.mode,
            "project_root": str(self.project_dir),
            "phase": current_state.get("phase", ""),
            "order": current_state.get("order", ""),
            "annotation_index": annotation_index,
            "total_annotations": len(annotations_list),
            "current_annotation": current_annotation,
            "diff2html_present": diff2html_present,
        }

        if self.mode == "mapping":
            context["needs_review_annotations"] = [
                {"annotation": ann, "mapping": mappings[ann["id"]]}
                for ann in annotations_list
                if ann["id"] in mappings
                and mappings[ann["id"]].get("needs_review")
            ]
            context["tex_files"] = _list_project_tex_files(self.project_dir)
        else:
            context.update(
                self._build_normal_mode_context(
                    current_state=current_state,
                    current_annotation=current_annotation,
                    current_mapping=(
                        mappings.get(current_id) if current_id else None
                    ),
                )
            )

        template = _jinja_env.get_template("frame.html")
        return template.render(**context).encode("utf-8")

    def _build_normal_mode_context(
        self,
        *,
        current_state: dict[str, Any],
        current_annotation: dict[str, Any] | None,
        current_mapping: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Assemble the 3-pane fields consumed by ``annotation.html``."""
        # LaTeX snippet — slice the mapped file by line_range.
        latex_snippet = ""
        snippet_start_line = 1
        if (
            current_mapping
            and current_mapping.get("latex_file")
            and current_mapping.get("line_range")
        ):
            tex_path = self.project_dir / current_mapping["latex_file"]
            try:
                lines = tex_path.read_text().splitlines()
            except OSError:
                lines = []
            start, end = current_mapping["line_range"]
            snippet_start_line = start
            if lines:
                latex_snippet = "\n".join(lines[start - 1 : end])

        # Image + PDF dimensions. Pages are rendered at 150 DPI by
        # extract.render_pages (1 pt = 72 in / DPI); derive page dims from
        # the PNG header so we don't have to re-parse the source PDF.
        image_width_px, image_height_px = 1275, 1650  # US letter @ 150 DPI fallback
        if current_annotation is not None:
            page_png = (
                self.project_dir
                / STATE_DIR_NAME
                / "pages"
                / f"page-{current_annotation['page']}.png"
            )
            dims = _png_dimensions(page_png)
            if dims is not None:
                image_width_px, image_height_px = dims
        pdf_page_width_pt = image_width_px * 72 / 150
        pdf_page_height_pt = image_height_px * 72 / 150

        builds = current_state.get("builds", []) or []
        current_build = builds[-1] if builds else None
        target_page = current_annotation["page"] if current_annotation else 1

        ann_state = (
            current_state.get("annotations", {}).get(current_annotation["id"], {})
            if current_annotation
            else {}
        )
        proposed_text = ann_state.get("proposed_text")

        return {
            "current_mapping": current_mapping or {
                "latex_file": None,
                "line_range": None,
            },
            "current_build": current_build,
            "latex_snippet": latex_snippet,
            "snippet_start_line": snippet_start_line,
            "proposed_text": proposed_text,
            "pagination_indicator": "",
            "target_page": target_page,
            "image_width_px": image_width_px,
            "image_height_px": image_height_px,
            "pdf_page_width_pt": pdf_page_width_pt,
            "pdf_page_height_pt": pdf_page_height_pt,
        }

    def _serve_state_json(self) -> None:
        state_path = self.project_dir / STATE_DIR_NAME / "state.json"
        try:
            raw = state_path.read_bytes()
        except FileNotFoundError:
            self._send_simple(HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n")
            return
        self._send_bytes(HTTPStatus.OK, raw, "application/json; charset=utf-8")

    def _serve_page_png(self, leaf: str) -> None:
        leaf = unquote(leaf)
        if not _PAGE_FILENAME_RE.fullmatch(leaf):
            self._send_404()
            return
        base = (self.project_dir / STATE_DIR_NAME / "pages").resolve()
        target = (base / leaf).resolve()
        if not _is_within(target, base):
            self._send_404()
            return
        self._send_file(target, "image/png")

    def _serve_build_png(self, tail: str) -> None:
        tail = unquote(tail)
        # tail is "<build_id>/<filename>"
        parts = tail.split("/", 1)
        if len(parts) != 2:
            self._send_404()
            return
        build_id, leaf = parts
        if not _BUILD_ID_RE.fullmatch(build_id) or not _PAGE_FILENAME_RE.fullmatch(leaf):
            self._send_404()
            return
        base = (self.project_dir / STATE_DIR_NAME / "builds" / build_id).resolve()
        target = (base / leaf).resolve()
        if not _is_within(target, base):
            self._send_404()
            return
        self._send_file(target, "image/png")

    def _serve_static_file(self, leaf: str) -> None:
        leaf = unquote(leaf)
        if not _STATIC_FILENAME_RE.fullmatch(leaf):
            self._send_404()
            return
        base = _STATIC_DIR.resolve()
        target = (base / leaf).resolve()
        if not _is_within(target, base):
            self._send_404()
            return
        ctype, _ = mimetypes.guess_type(leaf)
        if ctype is None:
            ctype = "application/octet-stream"
        self._send_file(target, ctype)

    # ---- byte/file plumbing -------------------------------------------------

    def _send_file(self, path: Path, content_type: str) -> None:
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            self._send_404()
            return
        except IsADirectoryError:
            self._send_404()
            return
        self._send_bytes(HTTPStatus.OK, data, content_type)

    def _send_bytes(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_simple(self, status: HTTPStatus, body: bytes) -> None:
        self._send_bytes(status, body, "text/plain; charset=utf-8")

    def _send_404(self) -> None:
        self._send_simple(HTTPStatus.NOT_FOUND, b"not found\n")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Silence default stderr access-log spam; tests reach in if they care."""
        return


def _is_within(target: Path, base: Path) -> bool:
    """True iff target is base or a descendant. Both arguments must be resolved."""
    try:
        target.relative_to(base)
        return True
    except ValueError:
        return False


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_dimensions(path: Path) -> tuple[int, int] | None:
    """Return (width, height) in pixels from a PNG's IHDR chunk, or None.

    PNG layout: 8-byte signature, then a chunk preamble (4-byte length +
    4-byte type "IHDR"), then width (uint32 BE) at bytes 16:20 and height
    at 20:24. Reads only the first 24 bytes — avoids pulling in Pillow.
    """
    try:
        with path.open("rb") as f:
            header = f.read(24)
    except OSError:
        return None
    if len(header) < 24 or header[:8] != _PNG_SIGNATURE:
        return None
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width <= 0 or height <= 0:
        return None
    return width, height


def _list_project_tex_files(project_dir: Path) -> list[str]:
    """Return posix-relative paths of every .tex file under project_dir.

    Skips ``build/`` and ``.review-state/`` to mirror ``extract.fuzzy_map``'s
    default scan scope.
    """
    excluded = ("build", STATE_DIR_NAME)
    out: list[str] = []
    for path in sorted(project_dir.rglob("*.tex")):
        try:
            rel = path.relative_to(project_dir)
        except ValueError:
            continue
        parts = rel.parts
        if parts and parts[0] in excluded:
            continue
        out.append(rel.as_posix())
    return out


def build_server(
    project_dir: Path, port: int, mode: str = "normal"
) -> http.server.HTTPServer:
    """Factory for the HTTPServer bound to ReviewHandler with closures over config.

    Returns an HTTPServer ready to serve; the caller drives serve_forever().
    """
    handler_cls = type(
        "BoundReviewHandler",
        (ReviewHandler,),
        {"project_dir": Path(project_dir).resolve(), "mode": mode},
    )
    return http.server.HTTPServer(("127.0.0.1", port), handler_cls)


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
    """
    # Try inotify_simple (Linux). Not in our dep list — only used if installed.
    try:
        import inotify_simple  # type: ignore[import-not-found]  # pragma: no cover
        from inotify_simple import flags  # type: ignore[import-not-found]  # pragma: no cover

        path.parent.mkdir(parents=True, exist_ok=True)  # pragma: no cover
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
        if not path.exists():
            # Watch the parent dir instead — kqueue needs a real fd.
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

        kq = select.kqueue()
        fd = os.open(str(path), os.O_RDONLY)
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


# ---- Task 8.3: serve CLI helpers + handler ---------------------------------

import socket
import sys
import threading


def pick_free_port() -> int:
    """Bind to port 0, read the assigned port, close. Caller binds again immediately."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def acquire_serve_lock(lock_path: Path) -> int:
    """Open ``lock_path`` and acquire an exclusive non-blocking flock.

    Returns the open file descriptor (caller keeps it for the process lifetime).
    Raises ``BlockingIOError`` if another process holds the lock.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise
    # Record PID for debuggability; not used for locking semantics.
    os.write(fd, f"{os.getpid()}\n".encode())
    return fd


def _atomic_write_state(path: Path, data: dict[str, Any]) -> None:
    """Local atomic write — mirrors state.atomic_write_json from chunk A."""
    import tempfile

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".tmp.{path.name}.",
        suffix=".json",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def handle_serve(
    *,
    project_dir: Path,
    port: int,
    order: str,
    mapping_mode: bool,
) -> int:
    """Implement ``review-pdf serve``. Returns the process exit code (0/5/6).

    Blocks on serve_forever until SIGINT/SIGTERM or another shutdown trigger.
    """
    project_dir = Path(project_dir).resolve()
    state_path = project_dir / STATE_DIR_NAME / "state.json"
    if not state_path.exists():
        sys.stderr.write("state missing; run 'review-pdf extract' first\n")
        return 6

    lock_path = project_dir / STATE_DIR_NAME / "serve.lock"
    try:
        lock_fd = acquire_serve_lock(lock_path)
    except BlockingIOError:
        sys.stderr.write("another serve instance is running (lock held)\n")
        return 5

    # Persist --order into state.json if it differs.
    try:
        current = json.loads(state_path.read_text())
        if current.get("order") != order:
            current["order"] = order
            _atomic_write_state(state_path, current)
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"state.json read failed: {e}\n")
        os.close(lock_fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        return 6

    if port == 0:
        port = pick_free_port()
    mode = "mapping" if mapping_mode else "normal"
    httpd = build_server(project_dir, port, mode=mode)
    sys.stderr.write(f"Viewer: http://127.0.0.1:{port}/\n")
    sys.stderr.flush()

    def _shutdown_handler(signum: int, frame: Any) -> None:
        # Run shutdown from a separate thread because HTTPServer.shutdown()
        # blocks until serve_forever() returns, and serve_forever() drives
        # the main thread here.
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown_handler)
    signal.signal(signal.SIGTERM, _shutdown_handler)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        os.close(lock_fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
    return 0


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
        return 6

    events_path = project_dir / STATE_DIR_NAME / EVENTS_FILENAME

    prev_term, prev_int = _install_wait_event_signal_handlers()
    try:
        try:
            events = wait_for_events(
                events_path, since_ts=since, timeout_sec=timeout,
            )
        except _SigTermExit:
            return 0
        except _SigIntExit:
            return 130
        if not events:
            return 20
        for event in events:
            sys.stdout.write(
                json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"
            )
        sys.stdout.flush()
        return 0
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        signal.signal(signal.SIGINT, prev_int)
