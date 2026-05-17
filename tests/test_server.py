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
