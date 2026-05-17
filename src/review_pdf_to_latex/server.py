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

import http.server
import json
import mimetypes
import re
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

    def do_POST(self) -> None:  # noqa: N802 (stdlib name)
        raise NotImplementedError  # filled in by Task 8.2

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
