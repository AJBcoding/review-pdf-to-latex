"""WebSocket terminal bridge for the viewer (rev-dyn).

Pairs the in-page xterm.js terminal (templates/static/xterm.js) with a
subprocess running inside a pty. The viewer opens a WebSocket to
``/ws/terminal``; this module upgrades the connection, spawns the configured
command (default ``claude``) in a pty, and ferries bytes both directions
until either side closes.

Why no asyncio / no ``websockets`` dependency: the project has only four
runtime deps (pdfannots, pdfplumber, rapidfuzz, jinja2) and the rest of the
viewer is stdlib ``http.server``. The WebSocket framing we need is the
small subset of RFC 6455 (text + binary + close + ping/pong; no extensions;
fragmented frames re-assembled in-process). About 150 lines of framing
beats pulling in an asyncio runtime alongside the threaded HTTP server.

Bind: localhost only — same constraint as the HTTP server. The bead
(rev-dyn) explicitly lists multi-user auth as out of scope for v1; that
gate is a Gas City prerequisite, filed as a follow-up.
"""

from __future__ import annotations

import base64
import errno
import fcntl
import hashlib
import http.server
import os
import pty
import select
import shlex
import signal
import struct
import termios
import threading
from typing import BinaryIO

# RFC 6455 §1.3 magic GUID — concatenated with the client's
# Sec-WebSocket-Key and SHA-1'd to produce the Accept value.
_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Frame opcodes (RFC 6455 §5.2).
_OP_CONT = 0x0
_OP_TEXT = 0x1
_OP_BINARY = 0x2
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA

# Cap the size of any single inbound frame's payload. xterm.js sends one
# frame per keystroke (~bytes) or per paste (potentially larger). 1 MiB is
# generous; anything larger is almost certainly a misbehaving client.
_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024

# Bridge read chunk size. The pty has its own ~64 KiB ring; reading 4 KiB
# at a time keeps latency low without thrashing the event loop.
_PTY_READ_CHUNK = 4096


def compute_accept_key(client_key: str) -> str:
    """Return the RFC 6455 §4.2.2 Sec-WebSocket-Accept value for client_key."""
    digest = hashlib.sha1(
        (client_key + _WS_MAGIC).encode("ascii"),
        usedforsecurity=False,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def is_websocket_upgrade(headers: object) -> bool:
    """True iff the request headers carry a valid WebSocket upgrade.

    We accept the request when both ``Connection`` contains "upgrade" and
    ``Upgrade`` equals "websocket" (both case-insensitive, per RFC 6455
    §4.2.1). ``Sec-WebSocket-Key`` must be present; ``Sec-WebSocket-Version``
    must be 13.
    """
    get = headers.get  # type: ignore[attr-defined]
    upgrade = (get("Upgrade") or "").strip().lower()
    connection = (get("Connection") or "").lower()
    key = get("Sec-WebSocket-Key") or ""
    version = (get("Sec-WebSocket-Version") or "").strip()
    if upgrade != "websocket":
        return False
    if "upgrade" not in connection:
        return False
    if not key:
        return False
    if version != "13":
        return False
    return True


def send_handshake(wfile: BinaryIO, client_key: str) -> None:
    """Write the HTTP/1.1 101 Switching Protocols response to ``wfile``.

    ``wfile`` is the BaseHTTPRequestHandler's ``self.wfile`` — a buffered
    writer wrapping the raw socket. We bypass the handler's ``send_response``
    helpers because they enforce ``Content-Length``/``Connection: close``
    semantics that conflict with the WebSocket upgrade. After this call the
    connection is owned by the WebSocket protocol, not HTTP.
    """
    accept = compute_accept_key(client_key)
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    )
    wfile.write(response.encode("ascii"))
    wfile.flush()


def _read_exact(rfile: BinaryIO, n: int) -> bytes:
    """Read exactly ``n`` bytes from ``rfile`` or raise ``ConnectionError``."""
    out = bytearray()
    while len(out) < n:
        chunk = rfile.read(n - len(out))
        if not chunk:
            raise ConnectionError("websocket peer closed mid-frame")
        out.extend(chunk)
    return bytes(out)


class _FrameTooLarge(Exception):
    """Raised when an inbound frame's declared payload length exceeds the cap."""


def read_frame(rfile: BinaryIO) -> tuple[int, bool, bytes]:
    """Read one WebSocket frame from ``rfile``.

    Returns ``(opcode, fin, payload)``. Payload bytes are already unmasked.
    A client frame that is not masked, or a payload that exceeds
    ``_MAX_PAYLOAD_BYTES``, raises a ``_FrameTooLarge`` / ``ConnectionError``
    — the caller should send a CLOSE frame with code 1009 / 1002 and tear
    down the connection.

    Continuation frames are returned as-is (opcode = 0). The bridge in
    :func:`run_bridge` re-assembles them.
    """
    header = _read_exact(rfile, 2)
    b1, b2 = header[0], header[1]
    fin = bool(b1 & 0x80)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F

    if not masked:
        # RFC 6455 §5.3: all client → server frames MUST be masked.
        raise ConnectionError("client frame missing mask bit")

    if length == 126:
        length = struct.unpack("!H", _read_exact(rfile, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(rfile, 8))[0]

    if length > _MAX_PAYLOAD_BYTES:
        raise _FrameTooLarge(f"frame payload {length} > cap {_MAX_PAYLOAD_BYTES}")

    mask = _read_exact(rfile, 4)
    payload = bytearray(_read_exact(rfile, length))
    for i in range(length):
        payload[i] ^= mask[i & 3]
    return opcode, fin, bytes(payload)


def write_frame(
    wfile: BinaryIO, opcode: int, payload: bytes, *, lock: threading.Lock
) -> None:
    """Frame ``payload`` and write it to ``wfile`` as a single un-fragmented frame.

    Server frames MUST NOT be masked (RFC 6455 §5.3). ``lock`` serializes
    writers because the bridge has two threads (pty → ws and ws control)
    that may both write — interleaved frames would corrupt the stream.
    """
    if opcode & ~0x0F:
        raise ValueError(f"invalid opcode: {opcode}")
    header = bytearray([0x80 | opcode])  # FIN=1
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", n))
    with lock:
        wfile.write(bytes(header))
        if payload:
            wfile.write(payload)
        wfile.flush()


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """Apply a TIOCSWINSZ ioctl to the pty master so child sees the new size.

    Silently ignores invalid values — xterm.js can send transient garbage
    during a fast resize and we don't want one bad ioctl to drop the bridge.
    """
    if rows <= 0 or cols <= 0 or rows > 0xFFFF or cols > 0xFFFF:
        return
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


# Inbound text frames carry small JSON control messages: window resize
# notifications from xterm-addon-fit. We tunnel them on the same channel
# (rather than opening a second WS) because the volume is trivial and a
# second socket complicates the auth story.
#
# Wire format:
#   {"t": "resize", "cols": <int>, "rows": <int>}
#
# Anything else is forwarded to the pty as UTF-8 bytes (so the user can
# paste literal JSON into the terminal without it being intercepted, we
# only treat as control if the frame parses AND has the "t" key).
def _maybe_resize(text_payload: bytes, pty_fd: int) -> bool:
    """Return True if ``text_payload`` was consumed as a resize control message."""
    if not text_payload or text_payload[0:1] != b"{":
        return False
    try:
        import json

        obj = json.loads(text_payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    if not isinstance(obj, dict) or obj.get("t") != "resize":
        return False
    cols = obj.get("cols")
    rows = obj.get("rows")
    if not isinstance(cols, int) or not isinstance(rows, int):
        return False
    _set_winsize(pty_fd, rows, cols)
    return True


class _BridgeError(Exception):
    """Internal sentinel for bridge teardown paths."""


def spawn_pty(command: str) -> tuple[int, int]:
    """Fork a child running ``command`` (shell-tokenized) with stdio on a pty.

    Returns ``(child_pid, master_fd)``. The caller owns ``master_fd`` and
    must close it. The child inherits a sane default environment plus
    ``TERM=xterm-256color`` so xterm.js's color rendering works.

    ``command`` is tokenized with ``shlex.split`` and exec'd via
    ``os.execvp`` — there is no shell in the loop. If the command doesn't
    exist the child exits 127, which the parent surfaces by closing the WS.
    """
    argv = shlex.split(command)
    if not argv:
        raise ValueError("empty terminal command")

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child. Set TERM and exec. Errors here can't propagate via
        # exception — write to stderr (which is the pty slave) and exit.
        os.environ.setdefault("TERM", "xterm-256color")
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:  # pragma: no cover — exercised via spawn failure path
            os.write(2, f"failed to exec {argv[0]!r}: {exc}\n".encode())
            os._exit(127)
    return pid, master_fd


def _close_pty(pid: int, master_fd: int) -> None:
    """Best-effort teardown: SIGHUP the child, close the fd, reap the process."""
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    try:
        os.close(master_fd)
    except OSError:
        pass
    # Reap so we don't leak zombies. WNOHANG first (child usually exits on
    # SIGHUP), then a short blocking wait. If the child ignores SIGHUP we
    # escalate to SIGKILL.
    for _ in range(20):  # ~1s
        try:
            done, _status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if done:
            return
        threading.Event().wait(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (OSError, ChildProcessError):
        pass


def run_bridge(
    handler: http.server.BaseHTTPRequestHandler, command: str
) -> None:
    """Bridge an upgraded WebSocket against a fresh ``command`` subprocess.

    Caller is responsible for having already verified the upgrade headers
    and sent the handshake response. This function blocks until either the
    WebSocket peer closes or the subprocess exits.

    Layout:
      * Reader thread: poll the pty master with ``select``; for each chunk,
        send a binary WS frame. Exits when read() returns EOF.
      * Main thread: drive ``read_frame`` in a loop; route text/binary
        frames to the pty's stdin; reply to ping; honor close.

    Both threads share a single write-lock so frames don't interleave.
    """
    sock = handler.connection
    rfile = handler.rfile
    wfile = handler.wfile

    try:
        pid, master_fd = spawn_pty(command)
    except (OSError, ValueError) as exc:
        # Can't spawn — send a close frame with a diagnostic and bail.
        message = f"terminal spawn failed: {exc}".encode("utf-8", "replace")
        payload = struct.pack("!H", 1011) + message[:120]
        try:
            write_frame(wfile, _OP_CLOSE, payload, lock=threading.Lock())
        except OSError:
            pass
        return

    write_lock = threading.Lock()
    stop = threading.Event()

    # Set pty master non-blocking so the reader thread can poll cleanly.
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def _reader() -> None:
        """pty → ws."""
        try:
            while not stop.is_set():
                try:
                    rlist, _, _ = select.select([master_fd], [], [], 0.5)
                except (OSError, ValueError):
                    # EBADF when the cleanup path closes master_fd from the
                    # other thread, or ValueError when select sees the
                    # already-closed fd. Either way, the bridge is done.
                    return
                if not rlist:
                    continue
                try:
                    data = os.read(master_fd, _PTY_READ_CHUNK)
                except OSError as exc:
                    # On macOS, reading a closed pty raises EIO instead of
                    # returning b"". Treat both as EOF.
                    if exc.errno in (errno.EIO, errno.EBADF):
                        return
                    if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        continue
                    return
                if not data:
                    return
                try:
                    write_frame(wfile, _OP_BINARY, data, lock=write_lock)
                except (OSError, ValueError):
                    return
        finally:
            stop.set()

    reader_thread = threading.Thread(target=_reader, name="ws-pty-reader", daemon=True)
    reader_thread.start()

    # Inbound loop: parse frames, re-assemble continuations, route by opcode.
    current_opcode: int | None = None
    current_buf = bytearray()
    try:
        while not stop.is_set():
            try:
                opcode, fin, payload = read_frame(rfile)
            except (_FrameTooLarge, ConnectionError, OSError):
                break

            if opcode == _OP_CLOSE:
                # Echo close (RFC 6455 §5.5.1) and exit.
                try:
                    write_frame(wfile, _OP_CLOSE, payload[:125], lock=write_lock)
                except OSError:
                    pass
                break
            if opcode == _OP_PING:
                try:
                    write_frame(wfile, _OP_PONG, payload, lock=write_lock)
                except OSError:
                    break
                continue
            if opcode == _OP_PONG:
                continue

            # Data frame: accumulate until FIN.
            if opcode == _OP_CONT:
                if current_opcode is None:
                    break  # protocol error: continuation without start
                current_buf.extend(payload)
            elif opcode in (_OP_TEXT, _OP_BINARY):
                current_opcode = opcode
                current_buf = bytearray(payload)
            else:
                # Unknown opcode → close 1002 and bail.
                try:
                    write_frame(
                        wfile,
                        _OP_CLOSE,
                        struct.pack("!H", 1002),
                        lock=write_lock,
                    )
                except OSError:
                    pass
                break

            if not fin:
                continue

            full = bytes(current_buf)
            this_opcode = current_opcode
            current_buf = bytearray()
            current_opcode = None

            if this_opcode == _OP_TEXT and _maybe_resize(full, master_fd):
                continue

            # Forward to the pty's stdin. write() can be partial under
            # backpressure, so loop until drained or the pty closes.
            view = memoryview(full)
            while view:
                try:
                    n = os.write(master_fd, view)
                except BlockingIOError:
                    # Master is full; wait briefly and retry.
                    select.select([], [master_fd], [], 0.1)
                    continue
                except OSError:
                    stop.set()
                    break
                view = view[n:]
    finally:
        stop.set()
        _close_pty(pid, master_fd)
        # Closing the socket wakes the reader thread out of select().
        try:
            sock.shutdown(2)
        except OSError:
            pass
        reader_thread.join(timeout=1.0)
