#!/usr/bin/env bash
# Grok MCP bridge: headless Grok delegate rooted at hermes/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node "$ROOT/scripts/grok-mcp-server.mjs"