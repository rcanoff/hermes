#!/usr/bin/env python3
"""Lightweight HTTP bridge to Hermes agent.auxiliary_client.call_llm."""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

try:
    from agent.auxiliary_client import call_llm
except ImportError as exc:
    print(f"Failed to import agent.auxiliary_client: {exc}", file=sys.stderr)
    sys.exit(1)

API_KEY = os.environ.get("HERMES_API_SERVER_KEY", "").strip()
PORT = int(os.environ.get("PORT", "8750"))


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "hermes-auxiliary-bridge/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/v1/complete":
            self._send_json(404, {"error": "not found"})
            return

        auth = self.headers.get("Authorization", "")
        expected = f"Bearer {API_KEY}" if API_KEY else ""
        if not API_KEY or auth != expected:
            self._send_json(401, {"error": "unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": f"invalid request: {exc}"})
            return

        provider = payload.get("provider")
        model = payload.get("model")
        messages = payload.get("messages")
        if not provider or not model or not isinstance(messages, list):
            self._send_json(400, {"error": "provider, model, and messages are required"})
            return

        max_tokens = payload.get("max_tokens", 64)
        temperature = payload.get("temperature", 0.3)
        timeout = payload.get("timeout")

        try:
            kwargs: dict[str, Any] = {
                "provider": provider,
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
            if timeout is not None:
                kwargs["timeout"] = timeout

            content = call_llm(**kwargs)
            if content is None:
                content = ""
            elif not isinstance(content, str):
                content = str(content)

            self._send_json(200, {"content": content})
        except Exception as exc:
            self._send_json(502, {"error": str(exc)})


def main() -> None:
    server = HTTPServer(("0.0.0.0", PORT), BridgeHandler)
    print(f"hermes-auxiliary-bridge listening on 0.0.0.0:{PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()