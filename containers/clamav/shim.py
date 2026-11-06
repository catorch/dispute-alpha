"""HTTP shim in front of clamd (contract relied on by da-jobs ClamAvContainer / doc-scan consumer).

POST /scan   raw bytes -> 200 {"result":"clean"} | 200 {"result":"infected","signature":...}
                          503 {"result":"error","message":...} | 413 over MAX_BYTES
GET  /healthz            -> 200 if clamd answers PING, else 503
"""

import json
import os
import socket
import struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOCK = os.environ.get("CLAMD_SOCKET", "/run/clamav/clamd.sock")
MAX_BYTES = int(os.environ.get("MAX_BYTES", 30 * 1024 * 1024))
CHUNK = 64 * 1024


class TooLarge(Exception):
    pass


def clamd(timeout=120):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK)
    return s


def read_reply(s):
    buf = b""
    while not buf.endswith(b"\0"):
        part = s.recv(4096)
        if not part:
            break
        buf += part
    return buf.rstrip(b"\0").decode(errors="replace").strip()


def ping():
    try:
        with clamd(timeout=5) as s:
            s.sendall(b"zPING\0")
            return read_reply(s) == "PONG"
    except OSError:
        return False


class Handler(BaseHTTPRequestHandler):
    def body_chunks(self):
        """Yields the request body (Content-Length or chunked), raising TooLarge past MAX_BYTES."""
        total = 0
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):  # trailers
                        pass
                    return
                total += size
                if total > MAX_BYTES:
                    raise TooLarge
                left = size
                while left:
                    data = self.rfile.read(min(CHUNK, left))
                    if not data:
                        raise ConnectionError("client closed mid-chunk")
                    left -= len(data)
                    yield data
                self.rfile.readline()  # CRLF after chunk
        else:
            left = int(self.headers.get("Content-Length") or 0)
            if left > MAX_BYTES:
                raise TooLarge
            while left:
                data = self.rfile.read(min(CHUNK, left))
                if not data:
                    raise ConnectionError("client closed early")
                left -= len(data)
                yield data

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/healthz":
            return self.send_json(404, {"error": "not_found"})
        ok = ping()
        self.send_json(200 if ok else 503, {"status": "ok" if ok else "clamd_unavailable"})

    def do_POST(self):
        if self.path != "/scan":
            return self.send_json(404, {"error": "not_found"})
        try:
            with clamd() as s:
                s.sendall(b"zINSTREAM\0")
                for data in self.body_chunks():
                    s.sendall(struct.pack("!I", len(data)) + data)
                s.sendall(struct.pack("!I", 0))
                reply = read_reply(s)
        except TooLarge:
            self.close_connection = True
            return self.send_json(413, {"result": "error", "message": f"body exceeds {MAX_BYTES} bytes"})
        except (OSError, ValueError) as e:  # clamd down, timeout, bad chunk framing
            self.close_connection = True
            return self.send_json(503, {"result": "error", "message": f"scanner unavailable: {e}"})

        # Replies: "stream: OK" | "stream: <Signature> FOUND" | "<message> ERROR"
        if reply.endswith(" FOUND"):
            sig = reply.removeprefix("stream:").removesuffix("FOUND").strip()
            return self.send_json(200, {"result": "infected", "signature": sig})
        if reply == "stream: OK":
            return self.send_json(200, {"result": "clean"})
        self.send_json(503, {"result": "error", "message": reply or "empty reply from clamd"})

    def log_message(self, fmt, *args):  # one JSON line per request, no body content
        print(json.dumps({"msg": "http", "line": fmt % args}), flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", 8080))), Handler).serve_forever()
