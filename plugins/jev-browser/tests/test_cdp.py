import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve

from cdp import CdpClient, CdpError


def _serve_http(status: int, body: dict):
    payload = json.dumps(body).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/json/version":
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop_http(server, thread):
    server.shutdown()
    server.server_close()
    thread.join()


@dataclass
class ScriptedCdp:
    base_url: str = ""
    replies: list = field(default_factory=list)
    received: list = field(default_factory=list)
    # When set, every request is answered only by an endless event stream.
    event_interval_s: float | None = None


@pytest.fixture
def cdp_server():
    state = ScriptedCdp()

    def handler(ws):
        for raw in ws:
            state.received.append(json.loads(raw))
            if state.event_interval_s is not None:
                while True:
                    try:
                        ws.send(json.dumps({"method": "Network.dataReceived", "params": {}}))
                    except ConnectionClosed:
                        return
                    time.sleep(state.event_interval_s)
            for reply in state.replies:
                ws.send(json.dumps(reply))

    ws_server = serve(handler, "127.0.0.1", 0)
    ws_port = ws_server.socket.getsockname()[1]
    ws_thread = threading.Thread(target=ws_server.serve_forever, daemon=True)
    ws_thread.start()

    http_server, http_thread = _serve_http(
        200,
        {
            "Browser": "Brave/1.0",
            "webSocketDebuggerUrl": f"ws://127.0.0.1:{ws_port}/devtools/browser/abc",
        },
    )
    state.base_url = f"http://127.0.0.1:{http_server.server_address[1]}"
    try:
        yield state
    finally:
        _stop_http(http_server, http_thread)
        ws_server.shutdown()
        ws_thread.join()


@pytest.fixture
def client(cdp_server):
    c = CdpClient(cdp_server.base_url, timeout_s=5)
    c.connect()
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def http_503_server():
    server, thread = _serve_http(
        503, {"error": "browser_unavailable", "message": "Brave did not start"}
    )
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        _stop_http(server, thread)


def test_call_returns_result_and_skips_events(cdp_server, client):
    cdp_server.replies = [
        {"method": "Page.frameNavigated", "params": {"frame": {"id": "F1"}}},
        {"id": 99, "result": {"wrong": True}},
        {"id": 1, "result": {"targetId": "T1"}},
    ]

    assert client.call("Target.createTarget", url="about:blank") == {"targetId": "T1"}
    assert cdp_server.received == [
        {"id": 1, "method": "Target.createTarget", "params": {"url": "about:blank"}}
    ]


def test_session_id_is_forwarded(cdp_server, client):
    cdp_server.replies = [{"id": 1, "result": {}}]

    assert client.call("Page.enable", session_id="S1") == {}
    assert cdp_server.received[0]["sessionId"] == "S1"
    assert cdp_server.received[0]["method"] == "Page.enable"


def test_error_reply_raises_cdp_error(cdp_server, client):
    cdp_server.replies = [{"id": 1, "error": {"code": -32000, "message": "No target"}}]

    with pytest.raises(CdpError, match="No target"):
        client.call("Target.attachToTarget", targetId="missing", flatten=True)


def test_chatty_events_do_not_extend_call_timeout(cdp_server):
    cdp_server.event_interval_s = 0.01
    client = CdpClient(cdp_server.base_url, timeout_s=0.1)
    client.connect()
    try:
        started = time.monotonic()
        with pytest.raises(CdpError):
            client.call("Page.navigate", url="https://example.com")
        assert time.monotonic() - started < 0.2
    finally:
        client.close()


def test_daemon_503_on_version_raises_cdp_error(http_503_server):
    client = CdpClient(http_503_server, timeout_s=5)
    try:
        with pytest.raises(CdpError, match="Brave did not start"):
            client.connect()
    finally:
        client.close()
