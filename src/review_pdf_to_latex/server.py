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

        Chunk E owns the template content; this method only guarantees that
        current_state (dict) and mode (str) are always passed as kwargs.
        """
        state_path = self.project_dir / STATE_DIR_NAME / "state.json"
        try:
            current_state: dict[str, Any] = json.loads(state_path.read_text())
        except FileNotFoundError:
            raise
        template = _jinja_env.get_template("frame.html")
        return template.render(current_state=current_state, mode=self.mode).encode(
            "utf-8"
        )

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


def wait_for_events(
    events_path: Path,
    since_ts: str | None,
    timeout_sec: int = 60,
) -> list[dict[str, Any]]:
    """Block until new event(s) land in events_path or the timeout fires.

    See Task 8.5 for the full implementation; this stub is replaced incrementally.
    """
    raise NotImplementedError  # filled in by Task 8.5
