"""Tests for review_pdf_to_latex.server."""

from __future__ import annotations

import importlib
import json
import os
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

    def fake_render(self: server_mod.ReviewHandler, query: str = "") -> bytes:
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


@pytest.mark.parametrize("direction", ["next", "previous"])
def test_post_events_navigate_roundtrip(running_server, direction: str) -> None:
    """navigate requires direction='next'|'previous' and persists it (rev-bus)."""
    base_url, project_dir = running_server
    status, _ = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-001",
            "action": "navigate",
            "direction": direction,
        },
    )
    assert status == HTTPStatus.NO_CONTENT
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    rec = json.loads(events_path.read_text().splitlines()[-1])
    assert rec["action"] == "navigate"
    assert rec["direction"] == direction


def test_post_events_navigate_missing_direction_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {"annotation_id": "ann-001", "action": "navigate"},
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"direction" in body


def test_post_events_navigate_bad_direction_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-001",
            "action": "navigate",
            "direction": "sideways",
        },
    )
    assert status == HTTPStatus.BAD_REQUEST
    assert b"direction" in body


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


def test_render_frame_real_template_renders_against_minimal_project(
    minimal_project: Path,
) -> None:
    """Smoke test for the real Jinja render path.

    Regression guard for the BLOCKER bug where ``_render_frame`` only passed
    ``current_state`` and ``mode``, causing ``StrictUndefined`` to raise on
    the first ``{% if diff2html_present %}`` reference. The rest of the
    server test suite stubs ``_render_frame``; this test exercises it for
    real so any future missing-kwarg slips fail loudly here.
    """
    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port, mode="normal")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, ctype, body = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK, body
        assert ctype.startswith("text/html")
        # Top bar + 3-pane content rendered (no StrictUndefined error).
        assert b"<!DOCTYPE html>" in body
        assert b"ann-001" in body
        assert b"2a-ratify" in body
        assert b"three-pane" in body
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_render_frame_real_template_renders_mapping_mode(
    minimal_project: Path,
) -> None:
    """Mapping-mode counterpart of the real-render smoke test."""
    # Flip the one annotation to needs_review so the mapping list is non-empty.
    mapping_path = minimal_project / ".review-state" / "mapping.json"
    doc = json.loads(mapping_path.read_text())
    doc["mappings"]["ann-001"]["needs_review"] = True
    mapping_path.write_text(json.dumps(doc, indent=2, sort_keys=True))

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port, mode="mapping")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, body = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK, body
        assert b"Mapping mode" in body
        assert b"ann-001" in body
        # The 3-pane content must NOT render in mapping mode (the class
        # selector still appears in the inline <style>, so check for the
        # element itself).
        assert b'class="three-pane"' not in body
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


# ---- rev-s1o: unresolved-by-default counter + frame ------------------------


def _multi_annotation_project(tmp_path: Path, statuses: list[tuple[str, str]]) -> Path:
    """Seed a minimal_project-shaped tree with N annotations and given statuses.

    ``statuses`` is a list of ``(annotation_id, status)``. The first entry is
    written to state.current_annotation_id (matching the production invariant
    where the engine seeds current_annotation_id to the first annotation).
    """
    project = tmp_path / "multi-project"
    state_dir = project / ".review-state"
    pages = state_dir / "pages"
    build_dir = state_dir / "builds" / "build-001"
    pages.mkdir(parents=True)
    build_dir.mkdir(parents=True)
    (project / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n"
    )
    (pages / "page-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (build_dir / "page-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    annotations = {}
    annotations_list = []
    mappings = {}
    for ann_id, status in statuses:
        annotations[ann_id] = {
            "status": status,
            "before_text": "old",
            "proposed_text": "new",
            "applied_text": "new" if status not in ("pending", "needs_review") else None,
            "applied_at": "2026-05-16T20:45:12Z",
            "last_build_id": "build-001",
            "surface_chat_log": None,
            "failure_log_path": None,
            "failure_edit_text": None,
        }
        annotations_list.append(
            {
                "id": ann_id,
                "page": 1,
                "bbox": [72.0, 510.5, 540.0, 542.5],
                "highlighted_text": "old",
                "author": "anonymous",
                "comment": "Tighten this",
                "created": "2026-05-16T20:30:00Z",
                "trigger_match": False,
            }
        )
        mappings[ann_id] = {
            "latex_file": "main.tex",
            "line_range": [1, 4],
            "method": "fuzzy",
            "confidence": 0.91,
            "needs_review": False,
            "candidates": [],
        }

    state = {
        "schema_version": 1,
        "phase": "2a-ratify",
        "order": "mechanical-first",
        "current_annotation_id": statuses[0][0],
        "annotations": annotations,
        "builds": [
            {
                "id": "build-001",
                "pdf_path": ".review-state/builds/build-001.pdf",
                "page_count": 1,
                "compiled_at": "2026-05-16T20:46:00Z",
                "log_path": ".review-state/builds/build-001.log",
                "ok": True,
                "page_md5": ["d41d8cd98f00b204e9800998ecf8427e"],
            }
        ],
    }
    (state_dir / "state.json").write_text(json.dumps(state, indent=2, sort_keys=True))
    (state_dir / "annotations.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source_pdf": "/dev/null/source.pdf",
                "source_pdf_md5": "d41d8cd98f00b204e9800998ecf8427e",
                "extracted_at": "2026-05-16T20:40:00Z",
                "extractor": "pdfannots-test",
                "annotations": annotations_list,
            },
            indent=2,
            sort_keys=True,
        )
    )
    (state_dir / "mapping.json").write_text(
        json.dumps({"schema_version": 1, "mappings": mappings}, indent=2, sort_keys=True)
    )
    return project


def _capture_render_kwargs(
    project: Path, monkeypatch: pytest.MonkeyPatch, query: str = ""
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    class FakeTemplate:
        def render(self, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "<html>ok</html>"

    fake_env = MagicMock()
    fake_env.get_template.return_value = FakeTemplate()
    monkeypatch.setattr(server_mod, "_jinja_env", fake_env)

    port = _pick_port()
    httpd = server_mod.build_server(project, port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        path = "/" + (("?" + query) if query else "")
        status, _, _ = _get(f"http://127.0.0.1:{port}", path)
        assert status == HTTPStatus.OK
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)
    return captured


def test_render_frame_default_skips_terminal_current_to_first_unresolved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When current_annotation_id is a terminal status, jump to first unresolved."""
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "deferred"),  # current_annotation_id; terminal
            ("ann-002", "deferred"),
            ("ann-003", "pending"),   # first unresolved
            ("ann-004", "applied"),
        ],
    )
    captured = _capture_render_kwargs(project, monkeypatch)
    assert captured["view_filter"] == "unresolved"
    assert captured["current_annotation"]["id"] == "ann-003"
    # Two unresolved: ann-003 (pending) and ann-004 (applied). ann-003 is #1.
    assert captured["annotation_index"] == 1
    assert captured["total_annotations"] == 2
    assert captured["total_all_annotations"] == 4


def test_render_frame_default_preserves_current_when_non_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "applied"),   # non-terminal; should stay current
            ("ann-002", "deferred"),
            ("ann-003", "pending"),
        ],
    )
    captured = _capture_render_kwargs(project, monkeypatch)
    assert captured["current_annotation"]["id"] == "ann-001"
    # Unresolved set: ann-001, ann-003. ann-001 is index 1.
    assert captured["annotation_index"] == 1
    assert captured["total_annotations"] == 2


def test_render_frame_include_terminal_uses_all_view(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "deferred"),
            ("ann-002", "deferred"),
            ("ann-003", "pending"),
        ],
    )
    captured = _capture_render_kwargs(project, monkeypatch, query="include=terminal")
    assert captured["view_filter"] == "all"
    # With include=terminal, the saved current_annotation_id (ann-001) is shown
    # even though it is terminal — the toggle exposes the prior behaviour.
    assert captured["current_annotation"]["id"] == "ann-001"
    assert captured["annotation_index"] == 1
    assert captured["total_annotations"] == 3
    assert captured["total_all_annotations"] == 3


def test_render_frame_all_terminal_falls_back_to_saved_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When every annotation is terminal, render the saved current so the
    3-pane keeps working; total is 0 (phase-complete indicator)."""
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "accepted"),
            ("ann-002", "deferred"),
        ],
    )
    captured = _capture_render_kwargs(project, monkeypatch)
    assert captured["view_filter"] == "unresolved"
    assert captured["current_annotation"]["id"] == "ann-001"
    assert captured["total_annotations"] == 0
    assert captured["annotation_index"] == 0


def test_serve_frame_counter_renders_unresolved_label(
    tmp_path: Path,
) -> None:
    """End-to-end: the rendered HTML carries the "unresolved" suffix."""
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "deferred"),
            ("ann-002", "pending"),
        ],
    )
    port = _pick_port()
    httpd = server_mod.build_server(project, port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, body = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK, body
        assert b"1 of 1" in body
        assert b"unresolved" in body
        # Toggle link should advertise the all-view.
        assert b"?include=terminal" in body
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


# ---- rev-3pm: server-side auto-dispatch of navigate events ------------------


def test_resolve_navigate_target_next_within_unresolved(tmp_path: Path) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "pending"),
            ("ann-002", "deferred"),  # terminal — skipped
            ("ann-003", "pending"),
            ("ann-004", "accepted"),  # terminal — skipped
            ("ann-005", "pending"),
        ],
    )
    state_dir = project / ".review-state"
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-001", "next")
        == "ann-003"
    )
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-003", "next")
        == "ann-005"
    )
    # End of the visible (unresolved) set — no movement.
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-005", "next")
        is None
    )


def test_resolve_navigate_target_previous_within_unresolved(tmp_path: Path) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "pending"),
            ("ann-002", "deferred"),
            ("ann-003", "pending"),
        ],
    )
    state_dir = project / ".review-state"
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-003", "previous")
        == "ann-001"
    )
    # Start of visible set — no movement.
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-001", "previous")
        is None
    )


def test_resolve_navigate_target_view_all_includes_terminal(tmp_path: Path) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "pending"),
            ("ann-002", "deferred"),
            ("ann-003", "pending"),
        ],
    )
    state_dir = project / ".review-state"
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-001", "next", view="all")
        == "ann-002"
    )


def test_resolve_navigate_target_unknown_from_lands_on_first(tmp_path: Path) -> None:
    """If from_id isn't visible (e.g., a terminal id under unresolved view),
    we land on the first visible so Next/Prev never silently no-ops."""
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "deferred"),  # not in unresolved set
            ("ann-002", "pending"),
            ("ann-003", "pending"),
        ],
    )
    state_dir = project / ".review-state"
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-001", "next")
        == "ann-002"
    )


def test_resolve_navigate_target_empty_visible_returns_none(tmp_path: Path) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "accepted"),
            ("ann-002", "deferred"),
        ],
    )
    state_dir = project / ".review-state"
    assert (
        server_mod._resolve_navigate_target(state_dir, "ann-001", "next")
        is None
    )


def test_navigate_post_mutates_state_without_consumer(tmp_path: Path) -> None:
    """rev-3pm: clicking Next must advance state.current_annotation_id
    even when no Claude consumer is running wait-event."""
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "pending"),
            ("ann-002", "deferred"),
            ("ann-003", "pending"),
        ],
    )
    state_path = project / ".review-state" / "state.json"
    assert json.loads(state_path.read_text())["current_annotation_id"] == "ann-001"

    port = _pick_port()
    httpd = server_mod.build_server(project, port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _ = _post_json(
            f"http://127.0.0.1:{port}",
            "/api/events",
            {"annotation_id": "ann-001", "action": "navigate", "direction": "next"},
        )
        assert status == HTTPStatus.NO_CONTENT
        # State must be mutated server-side (skipping the terminal ann-002).
        assert (
            json.loads(state_path.read_text())["current_annotation_id"]
            == "ann-003"
        )
        # Event line preserves the audit trail and carries the resolved id.
        events_path = project / ".review-state" / "state-events.jsonl"
        rec = json.loads(events_path.read_text().splitlines()[-1])
        assert rec["action"] == "navigate"
        assert rec["direction"] == "next"
        assert rec["resolved_annotation_id"] == "ann-003"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_navigate_post_at_boundary_is_noop(tmp_path: Path) -> None:
    """Next at the end of the visible set: 204 with no state mutation, and
    no resolved_annotation_id on the event record."""
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "pending"),
            ("ann-002", "pending"),
        ],
    )
    state_path = project / ".review-state" / "state.json"
    # Seed current at the last visible annotation.
    state = json.loads(state_path.read_text())
    state["current_annotation_id"] = "ann-002"
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True))

    port = _pick_port()
    httpd = server_mod.build_server(project, port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _ = _post_json(
            f"http://127.0.0.1:{port}",
            "/api/events",
            {"annotation_id": "ann-002", "action": "navigate", "direction": "next"},
        )
        assert status == HTTPStatus.NO_CONTENT
        assert (
            json.loads(state_path.read_text())["current_annotation_id"]
            == "ann-002"
        )
        events_path = project / ".review-state" / "state-events.jsonl"
        rec = json.loads(events_path.read_text().splitlines()[-1])
        assert "resolved_annotation_id" not in rec
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_navigate_post_respects_view_all(tmp_path: Path) -> None:
    project = _multi_annotation_project(
        tmp_path,
        [
            ("ann-001", "pending"),
            ("ann-002", "deferred"),
            ("ann-003", "pending"),
        ],
    )
    state_path = project / ".review-state" / "state.json"
    port = _pick_port()
    httpd = server_mod.build_server(project, port)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _ = _post_json(
            f"http://127.0.0.1:{port}",
            "/api/events",
            {
                "annotation_id": "ann-001",
                "action": "navigate",
                "direction": "next",
                "view": "all",
            },
        )
        assert status == HTTPStatus.NO_CONTENT
        # With view=all the terminal ann-002 is no longer skipped.
        assert (
            json.loads(state_path.read_text())["current_annotation_id"]
            == "ann-002"
        )
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_post_navigate_unknown_view_falls_back_to_unresolved(running_server) -> None:
    """Unknown view values fall back silently to 'unresolved' (closed
    contract — never reject the click). The event still carries view in
    its record."""
    base_url, project_dir = running_server
    status, _ = _post_json(
        base_url,
        "/api/events",
        {
            "annotation_id": "ann-001",
            "action": "navigate",
            "direction": "next",
            "view": "garbage",
        },
    )
    assert status == HTTPStatus.NO_CONTENT
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    rec = json.loads(events_path.read_text().splitlines()[-1])
    assert rec["view"] == "unresolved"


# ---- Task 8.5: wait_for_events polling --------------------------------------


def test_wait_for_events_returns_new_event(tmp_path: Path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()

    # Spawn a writer that appends an event after 200ms.
    def writer() -> None:
        time.sleep(0.2)
        rec = {
            "ts": "2026-05-16T20:47:11Z",
            "annotation_id": "ann-001",
            "action": "approve",
        }
        with events_path.open("a") as f:
            f.write(json.dumps(rec) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(
        events_path, since_ts="2026-05-16T00:00:00Z", timeout_sec=3
    )
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-001"
    assert result[0]["action"] == "approve"


def test_wait_for_events_returns_empty_on_timeout(tmp_path: Path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()
    start = time.monotonic()
    result = server_mod.wait_for_events(
        events_path, since_ts="2026-05-16T00:00:00Z", timeout_sec=1
    )
    elapsed = time.monotonic() - start
    assert result == []
    # Timeout should be close to requested value, not significantly under (no spurious
    # early returns) and not significantly over (we cap polling at 250ms granularity).
    assert 0.9 <= elapsed <= 1.6, f"timeout elapsed {elapsed}s outside [0.9, 1.6]"


def test_wait_for_events_filters_by_since(tmp_path: Path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events = [
        {
            "ts": "2026-05-16T20:47:00Z",
            "annotation_id": "ann-001",
            "action": "approve",
        },
        {
            "ts": "2026-05-16T20:47:30Z",
            "annotation_id": "ann-002",
            "action": "reject",
        },
        {
            "ts": "2026-05-16T20:48:00Z",
            "annotation_id": "ann-003",
            "action": "skip",
        },
    ]
    events_path.write_text("\n".join(json.dumps(e) for e in events) + "\n")

    # Append a fourth event in the background after 200ms.
    def writer() -> None:
        time.sleep(0.2)
        with events_path.open("a") as f:
            f.write(
                json.dumps(
                    {
                        "ts": "2026-05-16T20:48:30Z",
                        "annotation_id": "ann-004",
                        "action": "surface",
                    }
                )
                + "\n"
            )

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(
        events_path, since_ts="2026-05-16T20:47:30Z", timeout_sec=3
    )
    t.join(timeout=2)
    assert len(result) >= 1
    for rec in result:
        assert rec["ts"] > "2026-05-16T20:47:30Z"
    # The fresh ann-004 must be among them (it was the only post-start growth).
    assert any(r["annotation_id"] == "ann-004" for r in result)


def test_wait_for_events_defaults_since_to_last_existing(tmp_path: Path) -> None:
    """When since_ts is None and the file has events, default to last event's ts."""
    events_path = tmp_path / "state-events.jsonl"
    existing = {
        "ts": "2026-05-16T20:47:00Z",
        "annotation_id": "ann-001",
        "action": "approve",
    }
    events_path.write_text(json.dumps(existing) + "\n")

    def writer() -> None:
        time.sleep(0.2)
        new_rec = {
            "ts": "2026-05-16T20:47:30Z",
            "annotation_id": "ann-002",
            "action": "reject",
        }
        with events_path.open("a") as f:
            f.write(json.dumps(new_rec) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(events_path, since_ts=None, timeout_sec=3)
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-002"


def test_wait_for_events_empty_file_and_no_growth_returns_empty(
    tmp_path: Path,
) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()
    result = server_mod.wait_for_events(events_path, since_ts=None, timeout_sec=1)
    assert result == []


def test_wait_for_events_missing_file_eventually_appears(tmp_path: Path) -> None:
    """If the file does not exist at call time, the watcher waits for it to appear."""
    events_path = tmp_path / "state-events.jsonl"
    assert not events_path.exists()

    def writer() -> None:
        time.sleep(0.2)
        rec = {
            "ts": "2026-05-16T20:47:11Z",
            "annotation_id": "ann-X",
            "action": "approve",
        }
        events_path.write_text(json.dumps(rec) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(
        events_path, since_ts="1970-01-01T00:00:00Z", timeout_sec=3
    )
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-X"


def test_wait_for_events_skips_malformed_lines(tmp_path: Path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()

    def writer() -> None:
        time.sleep(0.2)
        with events_path.open("a") as f:
            f.write("garbage not json\n")
            f.write(
                json.dumps(
                    {
                        "ts": "2026-05-16T20:47:11Z",
                        "annotation_id": "ann-OK",
                        "action": "approve",
                    }
                )
                + "\n"
            )

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(events_path, since_ts=None, timeout_sec=3)
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-OK"


# ---- Task 8.7: blocking-call lifecycle (signal sentinels) -------------------
#
# The CLI integration tests for SIGTERM/SIGINT behavior live in the CLI test
# suite (added when the CLI batcher wires up the `wait-event` subcommand
# and `handle_wait_event`). Here we exercise the signal-handling primitives
# directly so the contract is locked at the server-module boundary.

import signal as _signal


def test_sig_term_exit_is_base_exception() -> None:
    """SIGTERM sentinel must subclass BaseException, NOT Exception.

    BaseException ensures the sentinel is not silently swallowed by
    `except Exception:` clauses inside wait_for_events' inner loops.
    """
    assert issubclass(server_mod._SigTermExit, BaseException)
    assert not issubclass(server_mod._SigTermExit, Exception)


def test_sig_int_exit_is_base_exception() -> None:
    """Same contract for SIGINT."""
    assert issubclass(server_mod._SigIntExit, BaseException)
    assert not issubclass(server_mod._SigIntExit, Exception)


def test_install_wait_event_signal_handlers_returns_previous_handlers() -> None:
    """The installer must return the previous (SIGTERM, SIGINT) handlers."""
    prev_term_before = _signal.getsignal(_signal.SIGTERM)
    prev_int_before = _signal.getsignal(_signal.SIGINT)
    try:
        prev_term, prev_int = server_mod._install_wait_event_signal_handlers()
        # The returned values should match what was installed before our call.
        assert prev_term == prev_term_before
        assert prev_int == prev_int_before
        # And the newly installed handlers must be callable closures.
        new_term = _signal.getsignal(_signal.SIGTERM)
        new_int = _signal.getsignal(_signal.SIGINT)
        assert callable(new_term)
        assert callable(new_int)
        assert new_term != prev_term_before
        assert new_int != prev_int_before
    finally:
        _signal.signal(_signal.SIGTERM, prev_term_before)
        _signal.signal(_signal.SIGINT, prev_int_before)


def test_install_wait_event_signal_handlers_sigterm_raises_sentinel() -> None:
    """Delivering SIGTERM with our handlers installed raises _SigTermExit."""
    prev_term = _signal.getsignal(_signal.SIGTERM)
    prev_int = _signal.getsignal(_signal.SIGINT)
    try:
        server_mod._install_wait_event_signal_handlers()
        with pytest.raises(server_mod._SigTermExit):
            os.kill(os.getpid(), _signal.SIGTERM)
    finally:
        _signal.signal(_signal.SIGTERM, prev_term)
        _signal.signal(_signal.SIGINT, prev_int)


def test_install_wait_event_signal_handlers_sigint_raises_sentinel() -> None:
    """Delivering SIGINT with our handlers installed raises _SigIntExit."""
    prev_term = _signal.getsignal(_signal.SIGTERM)
    prev_int = _signal.getsignal(_signal.SIGINT)
    try:
        server_mod._install_wait_event_signal_handlers()
        with pytest.raises(server_mod._SigIntExit):
            os.kill(os.getpid(), _signal.SIGINT)
    finally:
        _signal.signal(_signal.SIGTERM, prev_term)
        _signal.signal(_signal.SIGINT, prev_int)


# ---- Task 8.3: serve CLI lifecycle ------------------------------------------

import subprocess
import sys


def _run_cli_in_background(args: list[str], **kwargs) -> subprocess.Popen:
    """Spawn the CLI via ``python -m review_pdf_to_latex``."""
    return subprocess.Popen(
        [sys.executable, "-m", "review_pdf_to_latex", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **kwargs,
    )


def _wait_for_url(url: str, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.05)
    return False


def test_pick_free_port_returns_usable_port() -> None:
    port = server_mod.pick_free_port()
    assert 1024 <= port <= 65535
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
    finally:
        s.close()


def test_handle_serve_exits_6_when_state_missing(tmp_path: Path) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    rc = server_mod.handle_serve(
        project_dir=bare,
        port=0,
        order="mechanical-first",
        mapping_mode=False,
    )
    assert rc == 6


def test_handle_serve_exits_5_when_lock_held(
    minimal_project: Path, tmp_path: Path
) -> None:
    """A second serve invocation must exit 5 while the first holds the lock."""
    proc = _run_cli_in_background(
        ["--project-dir", str(minimal_project), "serve", "--port", "0"],
    )
    try:
        deadline = time.monotonic() + 5.0
        lock = minimal_project / ".review-state" / "serve.lock"
        while time.monotonic() < deadline and not lock.exists():
            time.sleep(0.05)
        assert lock.exists(), "first serve instance never acquired the lock"

        rc = server_mod.handle_serve(
            project_dir=minimal_project,
            port=0,
            order="mechanical-first",
            mapping_mode=False,
        )
        assert rc == 5
    finally:
        proc.send_signal(_signal.SIGINT)
        proc.wait(timeout=5)


def test_serve_subcommand_starts_and_stops_cleanly(minimal_project: Path) -> None:
    proc = _run_cli_in_background(
        ["--project-dir", str(minimal_project), "serve", "--port", "0"],
    )
    try:
        url = None
        deadline = time.monotonic() + 5.0
        buf = ""
        while time.monotonic() < deadline:
            line = proc.stderr.readline()
            if not line:
                time.sleep(0.02)
                continue
            buf += line
            if "Viewer:" in line:
                url = line.split("Viewer:", 1)[1].strip()
                break
        assert url is not None, f"viewer URL never announced; stderr={buf!r}"
        assert _wait_for_url(
            url + "api/state" if url.endswith("/") else url + "/api/state"
        )
    finally:
        proc.send_signal(_signal.SIGINT)
        rc = proc.wait(timeout=5)
        assert rc == 0, f"serve did not exit cleanly: rc={rc}"
        assert not (minimal_project / ".review-state" / "serve.lock").exists()


def test_serve_subcommand_records_order_in_state(minimal_project: Path) -> None:
    proc = _run_cli_in_background(
        [
            "--project-dir",
            str(minimal_project),
            "serve",
            "--port",
            "0",
            "--order",
            "surface-first",
        ],
    )
    try:
        deadline = time.monotonic() + 5.0
        url = None
        while time.monotonic() < deadline:
            line = proc.stderr.readline()
            if line and "Viewer:" in line:
                url = line.split("Viewer:", 1)[1].strip()
                break
        assert url is not None
        state = json.loads(
            (minimal_project / ".review-state" / "state.json").read_text()
        )
        assert state["order"] == "surface-first"
    finally:
        proc.send_signal(_signal.SIGINT)
        proc.wait(timeout=5)


# ---- Task 8.6 / 8.7: wait-event CLI subcommand + signal lifecycle ----------


def test_wait_event_cli_prints_event_then_exits_0(minimal_project: Path) -> None:
    events_path = minimal_project / ".review-state" / "state-events.jsonl"
    proc = _run_cli_in_background(
        [
            "--project-dir",
            str(minimal_project),
            "wait-event",
            "--since",
            "1970-01-01T00:00:00Z",
            "--timeout",
            "5",
        ]
    )
    try:
        def writer():
            time.sleep(0.3)
            with events_path.open("a") as f:
                f.write(
                    json.dumps(
                        {
                            "ts": "2026-05-16T20:47:11Z",
                            "annotation_id": "ann-001",
                            "action": "approve",
                        }
                    )
                    + "\n"
                )

        t = threading.Thread(target=writer, daemon=True)
        t.start()

        rc = proc.wait(timeout=8)
        stdout = proc.stdout.read()
        stderr = proc.stderr.read()
        t.join(timeout=2)

        assert rc == 0, f"unexpected exit code; stderr={stderr!r}"
        lines = [line for line in stdout.splitlines() if line.strip()]
        assert len(lines) == 1
        rec = json.loads(lines[0])
        assert rec["annotation_id"] == "ann-001"
        assert rec["action"] == "approve"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)


def test_wait_event_cli_timeout_exits_20(minimal_project: Path) -> None:
    proc = _run_cli_in_background(
        [
            "--project-dir",
            str(minimal_project),
            "wait-event",
            "--since",
            "1970-01-01T00:00:00Z",
            "--timeout",
            "1",
        ]
    )
    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    assert rc == 20
    assert stdout == "" or stdout.strip() == ""


def test_wait_event_cli_state_missing_exits_6(tmp_path: Path) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    proc = _run_cli_in_background(
        [
            "--project-dir",
            str(bare),
            "wait-event",
            "--timeout",
            "1",
        ]
    )
    rc = proc.wait(timeout=5)
    stderr = proc.stderr.read()
    assert rc == 6
    assert "state missing" in stderr


def test_wait_event_cli_sigterm_exits_0_no_output(minimal_project: Path) -> None:
    proc = _run_cli_in_background(
        [
            "--project-dir",
            str(minimal_project),
            "wait-event",
            "--since",
            "1970-01-01T00:00:00Z",
            "--timeout",
            "30",
        ]
    )
    time.sleep(0.3)
    proc.send_signal(_signal.SIGTERM)
    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    assert rc == 0, f"SIGTERM should produce rc=0, got {rc}"
    assert stdout.strip() == "", f"SIGTERM must produce no stdout, got {stdout!r}"


def test_wait_event_cli_sigint_exits_130_no_output(minimal_project: Path) -> None:
    proc = _run_cli_in_background(
        [
            "--project-dir",
            str(minimal_project),
            "wait-event",
            "--since",
            "1970-01-01T00:00:00Z",
            "--timeout",
            "30",
        ]
    )
    time.sleep(0.3)
    proc.send_signal(_signal.SIGINT)
    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    assert rc == 130, f"SIGINT should produce rc=130, got {rc}"
    assert stdout.strip() == "", f"SIGINT must produce no stdout, got {stdout!r}"
