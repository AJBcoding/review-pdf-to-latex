"""Tests for the embedded terminal WebSocket bridge (rev-dyn).

Splits into three layers:

1. Pure WS framing — pin frame parsing/building against RFC 6455 §5.2 and
   the §1.3 handshake-key example.
2. Server route surface — GET /ws/terminal returns 403 when disabled, 426
   when the request isn't a WS upgrade.
3. End-to-end bridge — spawn ``cat`` through the real pty path, exchange
   masked client frames over a raw socket, verify echo. The bridge tests
   are skipped on platforms without ``pty`` (e.g. Windows), but macOS +
   Linux are covered.
"""

from __future__ import annotations

import http.client
import io
import os
import shutil
import socket
import struct
import sys
import threading
import time
from http import HTTPStatus
from pathlib import Path

import pytest

from review_pdf_to_latex import server as server_mod
from review_pdf_to_latex import terminal as terminal_mod


# ---- 1. Pure framing unit tests --------------------------------------------


def test_compute_accept_key_matches_rfc6455_example() -> None:
    # RFC 6455 §1.3 worked example.
    got = terminal_mod.compute_accept_key("dGhlIHNhbXBsZSBub25jZQ==")
    assert got == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def test_is_websocket_upgrade_accepts_well_formed_headers() -> None:
    headers = _make_headers(
        {
            "Upgrade": "websocket",
            "Connection": "keep-alive, Upgrade",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
        }
    )
    assert terminal_mod.is_websocket_upgrade(headers) is True


@pytest.mark.parametrize(
    "override",
    [
        {"Upgrade": "websocket-broken"},
        {"Connection": "keep-alive"},
        {"Sec-WebSocket-Version": "8"},
        {"Sec-WebSocket-Key": ""},
    ],
)
def test_is_websocket_upgrade_rejects_invalid(override: dict[str, str]) -> None:
    base = {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Key": "abc",
        "Sec-WebSocket-Version": "13",
    }
    base.update(override)
    assert terminal_mod.is_websocket_upgrade(_make_headers(base)) is False


def test_read_frame_parses_masked_client_text() -> None:
    payload = b"hello"
    frame = _build_client_text_frame(payload)
    opcode, fin, decoded = terminal_mod.read_frame(io.BytesIO(frame))
    assert opcode == 0x1
    assert fin is True
    assert decoded == payload


def test_read_frame_rejects_unmasked_client_frame() -> None:
    # FIN+TEXT, no mask bit, len=1, body="x"
    frame = bytes([0x81, 0x01, ord("x")])
    with pytest.raises(ConnectionError):
        terminal_mod.read_frame(io.BytesIO(frame))


def test_read_frame_rejects_oversized_payload() -> None:
    # Use the 8-byte extended length form to claim a payload way over the cap.
    frame = bytes([0x82, 0xFF]) + struct.pack("!Q", 10 * 1024 * 1024) + b"\x00" * 4
    with pytest.raises(terminal_mod._FrameTooLarge):
        terminal_mod.read_frame(io.BytesIO(frame))


def test_write_frame_produces_unmasked_server_frame() -> None:
    out = io.BytesIO()
    terminal_mod.write_frame(out, 0x2, b"abc", lock=threading.Lock())
    data = out.getvalue()
    # FIN=1, opcode=BINARY → 0x82; mask bit unset; len=3.
    assert data == bytes([0x82, 0x03]) + b"abc"


def test_write_frame_uses_extended_length_for_large_payloads() -> None:
    out = io.BytesIO()
    body = b"x" * 200
    terminal_mod.write_frame(out, 0x1, body, lock=threading.Lock())
    data = out.getvalue()
    assert data[0] == 0x81  # FIN+TEXT
    assert data[1] == 126  # extended length sentinel
    assert struct.unpack("!H", data[2:4])[0] == 200
    assert data[4:] == body


# ---- 2. Route surface tests ------------------------------------------------


def test_ws_terminal_returns_403_when_disabled(minimal_project: Path) -> None:
    httpd = server_mod.build_server(
        minimal_project,
        _pick_port(),
        mode="normal",
        terminal_command="cat",
        terminal_enabled=False,
    )
    with _serving(httpd) as base_url:
        conn = http.client.HTTPConnection(*_split_host(base_url), timeout=5)
        conn.request("GET", "/ws/terminal")
        resp = conn.getresponse()
        assert resp.status == HTTPStatus.FORBIDDEN
        resp.read()


def test_ws_terminal_returns_426_when_not_upgrade(minimal_project: Path) -> None:
    httpd = server_mod.build_server(
        minimal_project,
        _pick_port(),
        mode="normal",
        terminal_command="cat",
        terminal_enabled=True,
    )
    with _serving(httpd) as base_url:
        conn = http.client.HTTPConnection(*_split_host(base_url), timeout=5)
        conn.request("GET", "/ws/terminal")
        resp = conn.getresponse()
        assert resp.status == HTTPStatus.UPGRADE_REQUIRED
        assert resp.headers.get("Upgrade") == "websocket"
        resp.read()


def test_load_terminal_command_reads_review_config(tmp_path: Path) -> None:
    (tmp_path / ".review-config.toml").write_text(
        'terminal_command = "bash -l"\nterminal_enabled = true\n'
    )
    cmd, enabled = server_mod._load_terminal_command(tmp_path)
    assert cmd == "bash -l"
    assert enabled is True


def test_load_terminal_command_disable_flag(tmp_path: Path) -> None:
    (tmp_path / ".review-config.toml").write_text("terminal_enabled = false\n")
    cmd, enabled = server_mod._load_terminal_command(tmp_path)
    assert cmd == server_mod.DEFAULT_TERMINAL_COMMAND
    assert enabled is False


def test_load_terminal_command_missing_config_uses_defaults(tmp_path: Path) -> None:
    cmd, enabled = server_mod._load_terminal_command(tmp_path)
    assert cmd == server_mod.DEFAULT_TERMINAL_COMMAND
    assert enabled is True


def test_load_terminal_command_handles_broken_toml(tmp_path: Path) -> None:
    (tmp_path / ".review-config.toml").write_text("this is not valid toml [[[")
    cmd, enabled = server_mod._load_terminal_command(tmp_path)
    # Broken config silently degrades, matching surface_trigger semantics.
    assert cmd == server_mod.DEFAULT_TERMINAL_COMMAND
    assert enabled is True


# ---- 3. End-to-end bridge --------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="pty not supported on Windows")
def test_bridge_echoes_through_cat(minimal_project: Path) -> None:
    """Connect to /ws/terminal, send bytes, see them echoed back.

    Uses ``cat`` as the bridge subprocess so we can assert deterministically
    on the bytes round-tripped. The pty runs cat in line-buffered cooked
    mode by default, but we send a full line + LF and read until we see it,
    so cooked-vs-raw doesn't matter.
    """
    cat_path = shutil.which("cat")
    assert cat_path, "cat not found on PATH; cannot run bridge integration test"

    httpd = server_mod.build_server(
        minimal_project,
        _pick_port(),
        mode="normal",
        terminal_command=cat_path,
        terminal_enabled=True,
    )
    with _serving(httpd) as base_url:
        host, port = _split_host(base_url)
        sock = _open_ws(host, port, path="/ws/terminal")
        try:
            payload = b"polecat-chrome\n"
            _send_client_text_frame(sock, payload)
            echoed = _drain_until_contains(sock, b"polecat-chrome", timeout=5.0)
            assert b"polecat-chrome" in echoed
            # Polite close — server should echo close back and tear down.
            _send_client_close(sock)
        finally:
            sock.close()


@pytest.mark.skipif(sys.platform == "win32", reason="pty not supported on Windows")
def test_bridge_resize_message_is_consumed_not_forwarded(
    minimal_project: Path,
) -> None:
    """A resize control text-frame must apply TIOCSWINSZ, not echo via cat.

    Strategy: send a literal-looking JSON resize control, then send a unique
    string. Read what comes back. The resize JSON should NOT appear in the
    echoed output; the unique string should.
    """
    cat_path = shutil.which("cat")
    assert cat_path

    httpd = server_mod.build_server(
        minimal_project,
        _pick_port(),
        mode="normal",
        terminal_command=cat_path,
        terminal_enabled=True,
    )
    with _serving(httpd) as base_url:
        host, port = _split_host(base_url)
        sock = _open_ws(host, port, path="/ws/terminal")
        try:
            _send_client_text_frame(sock, b'{"t":"resize","cols":120,"rows":40}')
            sentinel = b"after-resize-marker\n"
            _send_client_text_frame(sock, sentinel)
            echoed = _drain_until_contains(sock, b"after-resize-marker", timeout=5.0)
            assert b"after-resize-marker" in echoed
            assert b'"t":"resize"' not in echoed
            _send_client_close(sock)
        finally:
            sock.close()


# ---- Helpers ---------------------------------------------------------------


class _DictHeaders:
    """Minimal stand-in for ``email.message.Message`` exposing ``.get``."""

    def __init__(self, data: dict[str, str]) -> None:
        # Header lookup must be case-insensitive (per HTTP), so normalize keys.
        self._data = {k.lower(): v for k, v in data.items()}

    def get(self, key: str, default: str | None = None) -> str | None:
        return self._data.get(key.lower(), default)


def _make_headers(data: dict[str, str]) -> _DictHeaders:
    return _DictHeaders(data)


def _pick_port() -> int:
    return server_mod.pick_free_port()


def _split_host(base_url: str) -> tuple[str, int]:
    # base_url is like "http://127.0.0.1:54321"
    rest = base_url.split("://", 1)[1]
    host, port = rest.rsplit(":", 1)
    return host, int(port)


class _ServerContext:
    def __init__(self, httpd) -> None:  # type: ignore[no-untyped-def]
        self.httpd = httpd
        self.thread: threading.Thread | None = None

    def __enter__(self) -> str:
        host, port = self.httpd.server_address
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return f"http://{host}:{port}"

    def __exit__(self, *exc) -> None:  # type: ignore[no-untyped-def]
        self.httpd.shutdown()
        self.httpd.server_close()
        if self.thread is not None:
            self.thread.join(timeout=2.0)


def _serving(httpd):  # type: ignore[no-untyped-def]
    return _ServerContext(httpd)


# ---- Raw WebSocket client (just enough for the tests) ----------------------


def _open_ws(host: str, port: int, path: str) -> socket.socket:
    """Open a TCP socket, perform a WebSocket handshake, return the socket."""
    sock = socket.create_connection((host, port), timeout=5)
    sock.settimeout(5)
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode("ascii"))

    # Read the response headers up through the blank line.
    buf = bytearray()
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(1024)
        if not chunk:
            raise ConnectionError("server closed during handshake")
        buf.extend(chunk)
    head, sep, _rest = buf.partition(b"\r\n\r\n")
    status_line = head.split(b"\r\n", 1)[0]
    assert b"101" in status_line, f"unexpected status: {status_line!r}"
    return sock


def _build_client_text_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    mask = b"\xa1\xb2\xc3\xd4"
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    length = len(payload)
    out = bytearray([0x80 | opcode])  # FIN + opcode
    if length < 126:
        out.append(0x80 | length)
    elif length < 65536:
        out.append(0x80 | 126)
        out.extend(struct.pack("!H", length))
    else:
        out.append(0x80 | 127)
        out.extend(struct.pack("!Q", length))
    out.extend(mask)
    out.extend(masked)
    return bytes(out)


def _send_client_text_frame(sock: socket.socket, payload: bytes) -> None:
    sock.sendall(_build_client_text_frame(payload))


def _send_client_close(sock: socket.socket, code: int = 1000) -> None:
    body = struct.pack("!H", code)
    sock.sendall(_build_client_text_frame(body, opcode=0x8))


def _read_server_frame(sock: socket.socket) -> tuple[int, bytes]:
    """Read one server → client frame. Returns (opcode, payload)."""
    header = _recv_exact(sock, 2)
    b1, b2 = header[0], header[1]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8))[0]
    assert not masked, "server frames must not be masked"
    payload = _recv_exact(sock, length) if length else b""
    return opcode, payload


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise ConnectionError("socket closed mid-frame")
        out.extend(chunk)
    return bytes(out)


def _drain_until_contains(
    sock: socket.socket, needle: bytes, timeout: float
) -> bytes:
    """Read frames until ``needle`` appears in the accumulated payload or timeout."""
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while time.monotonic() < deadline:
        remaining = max(0.05, deadline - time.monotonic())
        sock.settimeout(remaining)
        try:
            opcode, payload = _read_server_frame(sock)
        except (TimeoutError, socket.timeout):
            break
        if opcode in (0x1, 0x2):
            buf.extend(payload)
            if needle in buf:
                return bytes(buf)
        elif opcode == 0x8:
            break
    return bytes(buf)


# ---- Reuse the running-server test fixtures' minimal project setup ---------


@pytest.fixture
def minimal_project(tmp_project: Path) -> Path:
    """Bare project tree sufficient for build_server() to start.

    The terminal route does not actually need state.json, but build_server
    is shared with the rest of the viewer surface so we keep the fixture
    in line with tests/test_server.py's expectations.
    """
    # state.json — minimum schema fields touched by _render_frame.
    state = {
        "phase": "2a-ratify",
        "order": "spatial",
        "annotations": {},
        "builds": [],
        "current_annotation_id": None,
    }
    (tmp_project / ".review-state" / "state.json").write_text(__import__("json").dumps(state))
    (tmp_project / ".review-state" / "annotations.json").write_text('{"annotations": []}')
    (tmp_project / ".review-state" / "mapping.json").write_text('{"mappings": {}}')
    pages = tmp_project / ".review-state" / "pages"
    pages.mkdir()
    return tmp_project
