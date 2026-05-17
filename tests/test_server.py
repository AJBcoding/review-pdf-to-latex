"""Tests for review_pdf_to_latex.server."""

from __future__ import annotations

import importlib
import json
import socket
import threading
import urllib.request
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest

from review_pdf_to_latex import server as server_mod


def test_server_module_importable() -> None:
    """server.py must be importable and expose the public symbols used by cli.py."""
    mod = importlib.import_module("review_pdf_to_latex.server")
    assert hasattr(mod, "ReviewHandler"), "ReviewHandler class must be exposed"
    assert hasattr(mod, "wait_for_events"), "wait_for_events function must be exposed"
    assert hasattr(mod, "build_server"), "build_server factory must be exposed"
    assert hasattr(mod, "EVENTS_FILENAME"), "EVENTS_FILENAME constant must be exposed"
    assert mod.EVENTS_FILENAME == "state-events.jsonl"


def _pick_port() -> int:
    s = socket.socket()
    s.bind(("", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def running_server(minimal_project: Path, monkeypatch: pytest.MonkeyPatch):
    """Start an HTTPServer in a background thread; yield (base_url, project_dir).

    Stops the server cleanly on teardown via shutdown() + server_close().
    """
    # Stub frame.html rendering so this fixture does not depend on chunk E.
    # The test for the real template is in tests/test_templates.py (chunk E).
    rendered_html = b"<!doctype html><html><body>frame-stub</body></html>"

    def fake_render(self: server_mod.ReviewHandler) -> bytes:
        # Capture mode so the mapping-mode test (Task 8.4) can assert on it.
        return rendered_html + f"<!-- mode={self.mode} -->".encode()

    monkeypatch.setattr(
        server_mod.ReviewHandler, "_render_frame", fake_render, raising=True
    )

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port, mode="normal")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield (f"http://127.0.0.1:{port}", minimal_project)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def _get(base_url: str, path: str) -> tuple[int, str, bytes]:
    req = urllib.request.Request(base_url + path, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except HTTPError as e:
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", e.read()


def test_get_root_returns_rendered_frame(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/")
    assert status == HTTPStatus.OK
    assert ctype.startswith("text/html")
    assert b"frame-stub" in body
    assert b"mode=normal" in body


def test_get_page_png_served_from_pages_dir(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/pages/page-1.png")
    assert status == HTTPStatus.OK
    assert ctype.startswith("image/png")
    assert body.startswith(b"\x89PNG")


def test_get_build_page_png_served_from_build_dir(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/builds/build-001/page-1.png")
    assert status == HTTPStatus.OK
    assert ctype.startswith("image/png")


def test_get_api_state_returns_state_json(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/api/state")
    assert status == HTTPStatus.OK
    assert ctype.startswith("application/json")
    payload = json.loads(body.decode())
    assert payload["phase"] == "2a-ratify"
    assert "ann-001" in payload["annotations"]


def test_get_unknown_path_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _, _ = _get(base_url, "/does-not-exist")
    assert status == HTTPStatus.NOT_FOUND


def test_path_traversal_in_pages_returns_404(running_server) -> None:
    base_url, _ = running_server
    # %2e%2e%2f%2e%2e%2f is "../../" — traversal attempt
    status, _, _ = _get(base_url, "/pages/%2e%2e%2f%2e%2e%2fmain.tex")
    assert status == HTTPStatus.NOT_FOUND


def test_path_traversal_in_builds_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _, _ = _get(base_url, "/builds/build-001/%2e%2e/page-1.png")
    assert status == HTTPStatus.NOT_FOUND


def test_invalid_build_id_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _, _ = _get(base_url, "/builds/not_a_build/page-1.png")
    assert status == HTTPStatus.NOT_FOUND


# ---- Task 8.2: POST /api/events tests ----------------------------------------

import time
from concurrent.futures import ThreadPoolExecutor


def _post_json(
    base_url: str,
    path: str,
    payload: dict | None,
    raw_body: bytes | None = None,
) -> tuple[int, bytes]:
    body = raw_body if raw_body is not None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        method="POST",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except HTTPError as e:
        return e.code, e.read()


def test_post_events_happy_path_returns_204(running_server) -> None:
    base_url, project_dir = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {"annotation_id": "ann-001", "action": "approve"},
    )
    assert status == HTTPStatus.NO_CONTENT
    assert body == b""
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    assert events_path.exists()
    lines = events_path.read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["annotation_id"] == "ann-001"
    assert rec["action"] == "approve"
    assert rec["ts"].endswith("Z")  # ISO8601 UTC with Z suffix
    assert "speculative_text" not in rec  # omitted when not supplied


def test_post_events_with_speculative_text(running_server) -> None:
    base_url, project_dir = running_server
    status, _ = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-001",
            "action": "preview",
            "speculative_text": "COTA enrollment grew 12% YoY.",
        },
    )
    assert status == HTTPStatus.NO_CONTENT
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    rec = json.loads(events_path.read_text().splitlines()[-1])
    assert rec["speculative_text"] == "COTA enrollment grew 12% YoY."


@pytest.mark.parametrize(
    "action", ["approve", "reject", "redraft", "preview", "skip", "surface"]
)
def test_post_events_accepts_six_status_only_actions(running_server, action: str) -> None:
    base_url, _ = running_server
    status, _ = _post_json(
        base_url,
        "/api/events",
        {"annotation_id": "ann-001", "action": action},
    )
    assert status == HTTPStatus.NO_CONTENT


def test_post_events_override_mapping_roundtrip(running_server) -> None:
    """override-mapping requires file/line_start/line_end and persists them."""
    base_url, project_dir = running_server
    payload = {
        "annotation_id": "ann-007",
        "action": "override-mapping",
        "file": "src/coverletter.tex",
        "line_start": 42,
        "line_end": 47,
    }
    status, _ = _post_json(base_url, "/api/events", payload)
    assert status == HTTPStatus.NO_CONTENT
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    rec = json.loads(events_path.read_text().splitlines()[-1])
    assert rec["annotation_id"] == "ann-007"
    assert rec["action"] == "override-mapping"
    assert rec["file"] == "src/coverletter.tex"
    assert rec["line_start"] == 42
    assert rec["line_end"] == 47


def test_post_events_override_mapping_missing_file_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-007",
            "action": "override-mapping",
            "line_start": 42,
            "line_end": 47,
        },
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"file" in body


def test_post_events_override_mapping_missing_line_start_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-007",
            "action": "override-mapping",
            "file": "src/coverletter.tex",
            "line_end": 47,
        },
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"line_start" in body


def test_post_events_override_mapping_bad_line_end_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-007",
            "action": "override-mapping",
            "file": "src/coverletter.tex",
            "line_start": 50,
            "line_end": 47,
        },
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"line_end" in body


def test_post_events_rejects_invalid_action(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {"annotation_id": "ann-001", "action": "yeet"},
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"invalid action" in body


def test_post_events_rejects_missing_annotation_id(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events", {"action": "approve"})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"annotation_id" in body


def test_post_events_rejects_missing_action(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events", {"annotation_id": "ann-001"})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"action" in body


def test_post_events_rejects_non_json_body(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events", None, raw_body=b"not json")
    assert status == HTTPStatus.BAD_REQUEST
    assert b"invalid JSON" in body


def test_post_events_rejects_oversized_body(running_server) -> None:
    base_url, _ = running_server
    big = "x" * (64 * 1024 + 1)
    status, body = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-001",
            "action": "preview",
            "speculative_text": big,
        },
    )
    assert status == HTTPStatus.REQUEST_ENTITY_TOO_LARGE
    assert b"body too large" in body


def test_post_events_rejects_non_string_speculative_text(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {"annotation_id": "ann-001", "action": "preview", "speculative_text": 42},
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"speculative_text" in body


def test_post_events_concurrent_appends_do_not_tear(running_server) -> None:
    base_url, project_dir = running_server
    N = 16
    payloads = [
        {"annotation_id": f"ann-{i:03d}", "action": "approve"} for i in range(N)
    ]
    with ThreadPoolExecutor(max_workers=N) as pool:
        results = list(
            pool.map(lambda p: _post_json(base_url, "/api/events", p), payloads)
        )
    assert all(s == HTTPStatus.NO_CONTENT for s, _ in results)
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    lines = events_path.read_text().splitlines()
    assert len(lines) == N
    seen_ids = set()
    for line in lines:
        rec = json.loads(line)  # must parse cleanly — no torn writes
        seen_ids.add(rec["annotation_id"])
    assert seen_ids == {f"ann-{i:03d}" for i in range(N)}


def test_post_unknown_path_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _ = _post_json(base_url, "/api/nope", {"x": 1})
    assert status == HTTPStatus.NOT_FOUND


def test_post_events_503_when_state_dir_missing(tmp_path) -> None:
    # Bare project with no .review-state/
    project = tmp_path / "bare"
    project.mkdir()
    port = _pick_port()
    httpd = server_mod.build_server(project, port, mode="normal")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = _post_json(
            f"http://127.0.0.1:{port}",
            "/api/events",
            {"annotation_id": "ann-001", "action": "approve"},
        )
        assert status == HTTPStatus.SERVICE_UNAVAILABLE
        assert b"no review state" in body
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


# ---- Task 8.4: --mapping-mode template dispatch -----------------------------

from unittest.mock import MagicMock


def test_render_frame_passes_mode_kwarg_to_template(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Jinja2 template render must receive mode= as a kwarg."""
    captured: dict[str, Any] = {}

    class FakeTemplate:
        def render(self, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "<html>ok</html>"

    fake_env = MagicMock()
    fake_env.get_template.return_value = FakeTemplate()
    monkeypatch.setattr(server_mod, "_jinja_env", fake_env)

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port, mode="mapping")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, body = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK
        assert b"<html>ok</html>" in body
        assert captured.get("mode") == "mapping"
        assert "current_state" in captured
        assert captured["current_state"]["phase"] == "2a-ratify"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_render_frame_default_mode_is_normal(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    class FakeTemplate:
        def render(self, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "<html>ok</html>"

    fake_env = MagicMock()
    fake_env.get_template.return_value = FakeTemplate()
    monkeypatch.setattr(server_mod, "_jinja_env", fake_env)

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port)  # default mode="normal"
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, _ = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK
        assert captured.get("mode") == "normal"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)
