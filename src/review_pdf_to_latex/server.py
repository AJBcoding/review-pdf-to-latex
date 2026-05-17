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
from pathlib import Path
from typing import Any

EVENTS_FILENAME = "state-events.jsonl"
STATE_DIR_NAME = ".review-state"  # mirrors state.STATE_DIR_NAME for module independence


class ReviewHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP request handler for the review viewer.

    Subclasses SimpleHTTPRequestHandler so the static-file plumbing
    (range requests, content-types, HEAD support) is inherited. We override
    do_GET to dispatch to specific routes and do_POST for /api/events.

    Configured via class attributes set by build_server():
    - project_dir: Path to the LaTeX project root.
    - mode: "normal" or "mapping" (mapping-mode UI dispatch).
    """

    project_dir: Path = Path(".")
    mode: str = "normal"

    def do_GET(self) -> None:  # noqa: N802 (stdlib name)
        raise NotImplementedError  # filled in by Task 8.1

    def do_POST(self) -> None:  # noqa: N802 (stdlib name)
        raise NotImplementedError  # filled in by Task 8.2

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Silence default stderr access-log spam; tests reach in if they care."""
        return


def build_server(
    project_dir: Path, port: int, mode: str = "normal"
) -> http.server.HTTPServer:
    """Factory for the HTTPServer bound to ReviewHandler with closures over config.

    Returns an HTTPServer ready to serve; the caller drives serve_forever().
    """
    handler_cls = type(
        "BoundReviewHandler",
        (ReviewHandler,),
        {"project_dir": Path(project_dir), "mode": mode},
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
