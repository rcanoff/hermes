#!/bin/sh

# Deprecated alias — use sync-apple-mcp-token.sh. REMINDERS_MCP_BEARER_TOKEN still accepted as fallback.
exec "$(dirname "$0")/sync-apple-mcp-token.sh" "$@"