"""Local HTTP viewer for the review session (3-pane frame + page PNGs).

The viewer is intentionally tiny: stdlib http.server, Jinja2 templates rendered
on the fly, no JS bundling. The single non-static endpoint is POST /api/events,
which appends one JSONL line to .review-state/state-events.jsonl. The engine
never writes that file; only this server does.

The format-agnostic event bus (validation, the JSONL append, the ``wait-event``
poller and its signal lifecycle) lives in :mod:`review_pdf_to_latex.events`
(rev-l7). This module imports it; the dependency edge points viewer → events,
never the reverse. A few wait-event symbols are re-exported below for the
``cli.py`` / test-suite call sites that historically imported them from here.

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
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import jinja2

from review_pdf_to_latex import terminal as terminal_bridge
from review_pdf_to_latex.events import (
    EVENTS_FILENAME,
    STATE_DIR_NAME,
    _append_event_line,
    _BadRequest,
    _utc_now_iso,
    _validate_event,
)

# Re-exported for backward compatibility: cli.py and the test suite import
# these wait-event symbols from server. The implementations now live in
# events.py (rev-l7); the viewer imports the event bus, never the reverse.
from review_pdf_to_latex.events import (  # noqa: F401
    _install_wait_event_signal_handlers,
    _SigIntExit,
    _SigTermExit,
    handle_wait_event,
    wait_for_events,
)
from review_pdf_to_latex.exit_codes import (
    EXIT_OK,
    EXIT_PORT_UNAVAILABLE,
    EXIT_STATE_MISSING,
)
from review_pdf_to_latex.state import status_is_terminal

# Default subprocess spawned by the viewer's embedded terminal pane
# (rev-dyn). Overridable via ``.review-config.toml``'s ``terminal_command``
# key — see ``_load_terminal_command`` below. Default is ``claude`` because
# the embedded terminal exists to host SURFACE-intent Phase 2b conversations
# without alt-tabbing.
DEFAULT_TERMINAL_COMMAND = "claude"

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

# Body-size cap for POST /api/events. An HTTP concern, so it stays with the
# viewer rather than moving to the event bus in events.py.
_MAX_BODY_BYTES = 64 * 1024


def _resolve_navigate_target(
    state_dir: Path,
    from_id: str,
    direction: str,
    view: str = "unresolved",
) -> str | None:
    """Return the annotation_id that a navigate event should land on.

    rev-3pm: status-neutral navigation is auto-dispatched server-side so the
    viewer's Prev/Next buttons work without a Claude consumer attached. The
    resolver reads annotations.json + state.json, builds the visible set
    (per ``view``: "unresolved" excludes spec §7.3 terminal statuses, "all"
    includes them), and walks one step from ``from_id``.

    Returns ``None`` when no movement is possible — empty visible set,
    ``from_id`` already at the requested boundary, or state files missing.
    Returning None means "do nothing"; the caller must not call
    ``set_current_annotation``.
    """
    annotations_path = state_dir / "annotations.json"
    state_path = state_dir / "state.json"
    try:
        annotations = json.loads(annotations_path.read_text()).get("annotations", [])
        state = json.loads(state_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    ann_state = state.get("annotations", {})

    if view == "unresolved":
        def _visible(ann_id: str) -> bool:
            status = ann_state.get(ann_id, {}).get("status", "pending")
            try:
                return not status_is_terminal(status)
            except ValueError:
                # Unknown status — keep visible so it isn't silently skipped.
                return True

        visible_ids = [a["id"] for a in annotations if _visible(a["id"])]
    else:
        visible_ids = [a["id"] for a in annotations]

    if not visible_ids:
        return None

    if from_id not in visible_ids:
        # from_id is filtered out (e.g., terminal under unresolved view) or
        # unknown. Land on the first visible so Next/Prev always advances
        # somewhere useful rather than no-op'ing.
        return visible_ids[0]

    idx = visible_ids.index(from_id)
    if direction == "next":
        if idx + 1 < len(visible_ids):
            return visible_ids[idx + 1]
        return None
    if direction == "previous":
        if idx > 0:
            return visible_ids[idx - 1]
        return None
    return None


class ReviewHandler(http.server.SimpleHTTPRequestHandler):
    """Routing + rendering. See module docstring for spec links."""

    project_dir: Path = Path(".")
    mode: str = "normal"
    terminal_command: str = DEFAULT_TERMINAL_COMMAND
    terminal_enabled: bool = True

    # ---- GET dispatch -------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        split = urlsplit(self.path)
        path = split.path
        if path == "/":
            self._serve_frame(split.query)
            return
        if path == "/api/state":
            self._serve_state_json()
            return
        if path == "/ws/terminal":
            self._serve_terminal_ws()
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

    def _serve_terminal_ws(self) -> None:
        """Upgrade the connection and hand off to the pty bridge (rev-dyn).

        Rejects the upgrade with 403 when the terminal is disabled
        (no command configured) or 426 when the request isn't a valid
        WebSocket upgrade. Otherwise this method does not return until the
        bridge tears down — the connection is "stolen" from http.server.
        """
        if not self.terminal_enabled or not self.terminal_command:
            self._send_simple(HTTPStatus.FORBIDDEN, b"terminal disabled\n")
            return
        if not terminal_bridge.is_websocket_upgrade(self.headers):
            self.send_response(int(HTTPStatus.UPGRADE_REQUIRED))
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        client_key = self.headers.get("Sec-WebSocket-Key", "")
        terminal_bridge.send_handshake(self.wfile, client_key)
        # After this returns the socket is consumed; we deliberately do
        # not call any send_response helpers. The handler's do_GET caller
        # ends here.
        terminal_bridge.run_bridge(self, self.terminal_command)

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

        # rev-3pm: auto-dispatch status-neutral navigation server-side so the
        # Prev/Next buttons don't silently no-op when no Claude consumer is
        # attached. Resolved BEFORE the event is appended so the audit line
        # can carry the resolved target. State-mutating actions (approve /
        # reject / redraft / preview / skip / surface) still require a
        # consumer; the frontend surfaces a "no consumer attached" warning
        # via watchdog when their reload doesn't fire.
        resolved_target: str | None = None
        if record["action"] == "navigate":
            resolved_target = _resolve_navigate_target(
                self.project_dir / STATE_DIR_NAME,
                record["annotation_id"],
                record["direction"],
                view=record.get("view", "unresolved"),
            )
            if resolved_target is not None:
                record["resolved_annotation_id"] = resolved_target

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

        if resolved_target is not None:
            # Engine call lives inline — the server IS calling the engine, so
            # the "engine-is-sole-writer" invariant holds. Failures here are
            # logged-but-tolerated: the event is already in state-events.jsonl
            # so a consumer can still pick up the navigate intent.
            try:
                from review_pdf_to_latex.apply import set_current_annotation

                set_current_annotation(
                    self.project_dir / STATE_DIR_NAME, resolved_target
                )
            except Exception:  # noqa: BLE001 - we deliberately swallow.
                pass

        self.send_response(int(HTTPStatus.NO_CONTENT))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    # ---- per-route helpers --------------------------------------------------

    def _serve_frame(self, query: str = "") -> None:
        try:
            body = self._render_frame(query=query)
        except FileNotFoundError:
            # state.json missing — degrade to a clean 503 so the viewer can show
            # a "no review session" page; we surface 503 (Service Unavailable)
            # rather than 404 because the URL itself is valid.
            self._send_simple(HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n")
            return
        self._send_bytes(HTTPStatus.OK, body, "text/html; charset=utf-8")

    def _render_frame(self, query: str = "") -> bytes:
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

        by_id = {a["id"]: a for a in annotations_list}
        ann_state = current_state.get("annotations", {})

        # rev-s1o: counter and current-frame default to "unresolved only".
        # The viewer skips terminal-status annotations (accepted, rejected,
        # redrafted, deferred, surfaced_resolved) when picking the rendered
        # frame and computing the "X of Y" counter. Pass ?include=terminal
        # to revert to the original "X of TOTAL" behaviour (e.g., to scroll
        # back through already-decided annotations).
        params = parse_qs(query) if query else {}
        view_filter = "all" if "terminal" in params.get("include", []) else "unresolved"

        def _is_unresolved(ann_id: str) -> bool:
            status = ann_state.get(ann_id, {}).get("status", "pending")
            try:
                return not status_is_terminal(status)
            except ValueError:
                # Unknown status — treat as unresolved so it remains visible
                # rather than silently hidden behind the default filter.
                return True

        unresolved_ids = [a["id"] for a in annotations_list if _is_unresolved(a["id"])]

        def _pick_default_id(ids: list[str]) -> str | None:
            """When no saved_id matches, pick the best default based on order."""
            if current_state.get("order") == "surface-first":
                for aid in ids:
                    if ann_state.get(aid, {}).get("status") == "surfaced_pending":
                        return aid
            return ids[0] if ids else None

        saved_id = current_state.get("current_annotation_id")
        if view_filter == "unresolved":
            visible_ids = unresolved_ids
            if saved_id in visible_ids:
                current_id = saved_id
            elif visible_ids:
                current_id = _pick_default_id(visible_ids)
            else:
                # All annotations terminal — fall back to saved/first so the
                # 3-pane still renders something rather than crashing on a
                # None current_annotation.
                current_id = saved_id if saved_id in by_id else (
                    annotations_list[0]["id"] if annotations_list else None
                )
        else:
            visible_ids = [a["id"] for a in annotations_list]
            current_id = saved_id if saved_id in by_id else (
                annotations_list[0]["id"] if annotations_list else None
            )

        current_annotation = by_id.get(current_id) if current_id else None

        annotation_index = 0
        if current_id and current_id in visible_ids:
            annotation_index = visible_ids.index(current_id) + 1

        diff2html_present = (_STATIC_DIR / "diff2html.min.js").exists()
        xterm_present = (_STATIC_DIR / "xterm.js").exists()

        context: dict[str, Any] = {
            "current_state": current_state,
            "mode": self.mode,
            "project_root": str(self.project_dir),
            "phase": current_state.get("phase", ""),
            "order": current_state.get("order", ""),
            "annotation_index": annotation_index,
            "total_annotations": len(visible_ids),
            "total_all_annotations": len(annotations_list),
            "view_filter": view_filter,
            "current_annotation": current_annotation,
            "diff2html_present": diff2html_present,
            "xterm_present": xterm_present,
            "terminal_enabled": bool(self.terminal_enabled and self.terminal_command),
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


def _load_terminal_command(project_dir: Path) -> tuple[str, bool]:
    """Return ``(command, enabled)`` for the embedded terminal pane.

    Reads ``<project_dir>/.review-config.toml``:

    * ``terminal_command`` (str): override the subprocess to spawn. Empty
      string or missing key uses :data:`DEFAULT_TERMINAL_COMMAND`.
    * ``terminal_enabled`` (bool): explicit kill switch. Defaults to True.
      Setting this to ``false`` makes ``GET /ws/terminal`` return 403 and
      hides the toggle in the viewer.

    Parse failures degrade silently to the default, matching the
    ``surface_trigger`` config in :mod:`extract` — a broken config never
    blocks the viewer.
    """
    import tomllib

    config_path = project_dir / ".review-config.toml"
    if not config_path.exists():
        return DEFAULT_TERMINAL_COMMAND, True
    try:
        with config_path.open("rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return DEFAULT_TERMINAL_COMMAND, True
    enabled = bool(data.get("terminal_enabled", True))
    command = data.get("terminal_command")
    if not isinstance(command, str) or not command.strip():
        command = DEFAULT_TERMINAL_COMMAND
    return command, enabled


def build_server(
    project_dir: Path,
    port: int,
    mode: str = "normal",
    *,
    terminal_command: str | None = None,
    terminal_enabled: bool | None = None,
) -> http.server.HTTPServer:
    """Factory for the HTTPServer bound to ReviewHandler with closures over config.

    Returns a :class:`ThreadingHTTPServer` so a long-lived WebSocket (the
    embedded terminal pane, rev-dyn) doesn't block concurrent HTTP requests
    on the same port. Caller drives ``serve_forever()``.
    """
    resolved = Path(project_dir).resolve()
    if terminal_command is None or terminal_enabled is None:
        cfg_cmd, cfg_enabled = _load_terminal_command(resolved)
        if terminal_command is None:
            terminal_command = cfg_cmd
        if terminal_enabled is None:
            terminal_enabled = cfg_enabled
    handler_cls = type(
        "BoundReviewHandler",
        (ReviewHandler,),
        {
            "project_dir": resolved,
            "mode": mode,
            "terminal_command": terminal_command,
            "terminal_enabled": terminal_enabled,
        },
    )
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler_cls)


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
        return EXIT_STATE_MISSING

    lock_path = project_dir / STATE_DIR_NAME / "serve.lock"
    try:
        lock_fd = acquire_serve_lock(lock_path)
    except BlockingIOError:
        sys.stderr.write("another serve instance is running (lock held)\n")
        return EXIT_PORT_UNAVAILABLE

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
        return EXIT_STATE_MISSING

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
    return EXIT_OK
