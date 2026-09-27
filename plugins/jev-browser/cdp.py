"""Minimal sync Chrome DevTools Protocol client for the Brave browser-daemon."""

from __future__ import annotations

import contextlib
import itertools
import json
import time

import httpx
from websockets.exceptions import WebSocketException
from websockets.sync.client import ClientConnection, connect


class CdpError(RuntimeError):
    """A CDP error reply or a failure talking to the browser-daemon."""


class CdpClient:
    def __init__(self, base_url: str, *, timeout_s: float = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self._ws: ClientConnection | None = None
        self._stack: contextlib.ExitStack | None = None
        self._ids = itertools.count(1)

    def connect(self) -> None:
        version_url = f"{self.base_url}/json/version"
        try:
            response = httpx.get(version_url, timeout=self.timeout_s)
        except httpx.HTTPError as exc:
            raise CdpError(f"GET {version_url} failed: {exc}") from exc
        if response.is_error:
            raise CdpError(
                f"GET {version_url} returned {response.status_code}: {_error_message(response)}"
            )
        try:
            ws_url = response.json()["webSocketDebuggerUrl"]
        except (ValueError, KeyError, TypeError) as exc:
            raise CdpError(f"GET {version_url} returned no webSocketDebuggerUrl") from exc
        stack = contextlib.ExitStack()
        try:
            # Entered as a context manager: portable across websockets 15 and
            # 17.1+, which deprecates using connect() without `with`.
            self._ws = stack.enter_context(
                connect(ws_url, open_timeout=self.timeout_s, max_size=None)
            )
        except (OSError, TimeoutError, WebSocketException) as exc:
            raise CdpError(f"websocket connect to {ws_url} failed: {exc}") from exc
        self._stack = stack

    def call(self, method: str, session_id: str | None = None, **params) -> dict:
        if self._ws is None:
            raise CdpError("CdpClient is not connected")
        msg_id = next(self._ids)
        frame: dict = {"id": msg_id, "method": method, "params": params}
        if session_id is not None:
            frame["sessionId"] = session_id
        deadline = time.monotonic() + self.timeout_s
        try:
            self._ws.send(json.dumps(frame))
            while True:
                # One deadline for the whole call: event frames must not reset it.
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CdpError(f"{method} timed out after {self.timeout_s}s")
                reply = json.loads(self._ws.recv(timeout=remaining))
                if reply.get("id") == msg_id:
                    break
        except (OSError, TimeoutError, WebSocketException) as exc:
            raise CdpError(f"{method} failed: {type(exc).__name__}: {exc}") from exc
        if "error" in reply:
            error = reply["error"]
            raise CdpError(error.get("message") or json.dumps(error))
        return reply.get("result", {})

    def close(self) -> None:
        if self._stack is not None:
            self._stack.close()
        self._stack = None
        self._ws = None


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text
    if isinstance(body, dict):
        return body.get("message") or body.get("error") or response.text
    return response.text
