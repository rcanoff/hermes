#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${BRAVE_GOOGLE_PROFILE:-$ROOT/data/brave-google-profile}"
CONFIG_FILE="${HERMES_CONFIG_FILE:-$ROOT/data/config.yaml}"
BRAVE_APP="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
PORT="${BRAVE_DEBUG_PORT:-9222}"
CDP_HOST="${BRAVE_CDP_HOST:-host.docker.internal}"
HERMES_CONTAINER="${HERMES_CONTAINER:-hermes}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|sync-config|url|status|stop>

  start       Launch Brave with the Hermes profile and CDP on port $PORT
  sync-config Optional: pin browser.cdp_url for manual CDP attach (not default)
  url         Print a /browser connect command for Hermes (Docker-safe ws URL)
  status      Show whether Brave CDP is listening
  stop        Stop the debug Brave instance

Profile: $PROFILE

After start:
  1. Log into Google in the Brave window (once; session persists in the profile).
  2. Ask Hermes to browse or search Google — browser tools use Brave automatically.

Browser tools use Brave via browser.cdp_url. The web toolset is disabled; browse and search via browser tools.
EOF
}

require_brave() {
  if [[ ! -x "$BRAVE_APP" ]]; then
    echo "Brave not found at: $BRAVE_APP" >&2
    exit 1
  fi
}

cdp_ready() {
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1
}

start_brave() {
  require_brave
  mkdir -p "$PROFILE"

  if cdp_ready; then
    echo "Brave CDP already listening on port $PORT"
    return 0
  fi

  open -na "Brave Browser" --args \
    "--remote-debugging-port=${PORT}" \
    "--user-data-dir=${PROFILE}" \
    "--no-first-run" \
    "--no-default-browser-check" \
    "about:blank"

  for _ in $(seq 1 20); do
    if cdp_ready; then
      echo "Brave started (profile: $PROFILE, CDP: 127.0.0.1:$PORT)"
      echo "Log into Google in that window if you have not already."
      return 0
    fi
    sleep 0.5
  done

  echo "Brave launched but CDP port $PORT is not responding yet." >&2
  exit 1
}

resolve_ws_url() {
  if ! cdp_ready; then
    echo "Brave CDP is not running. Run: $(basename "$0") start" >&2
    return 1
  fi

  local ws_url
  ws_url="$(python3 - <<'PY' "$PORT"
import json, sys, urllib.request
port = sys.argv[1]
with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as resp:
    data = json.load(resp)
print(data["webSocketDebuggerUrl"])
PY
)"

  printf '%s' "${ws_url//127.0.0.1/${CDP_HOST}}"
}

print_connect_url() {
  local ws_url
  ws_url="$(resolve_ws_url)" || exit 1
  echo "/browser connect ${ws_url}"
}

sync_hermes_config() {
  local ws_url
  ws_url="$(resolve_ws_url)" || exit 1

  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$HERMES_CONTAINER"; then
    docker exec "$HERMES_CONTAINER" hermes config set browser.cloud_provider local >/dev/null
    docker exec "$HERMES_CONTAINER" hermes config set browser.cdp_url "$ws_url" >/dev/null
    echo "Synced Hermes browser config (cloud_provider: local, cdp_url set)."
    docker restart "$HERMES_CONTAINER" >/dev/null
    echo "Restarted $HERMES_CONTAINER."
    return 0
  fi

  python3 - <<'PY' "$CONFIG_FILE" "$ws_url"
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
ws_url = sys.argv[2]
lines = config_path.read_text().splitlines()
out = []
in_browser = False
browser_indent = 0
seen_cloud_provider = False
seen_cdp_url = False

for line in lines:
    stripped = line.lstrip()
    indent = len(line) - len(stripped)

    if stripped == "browser:" and not line.startswith(" "):
        in_browser = True
        browser_indent = indent
        out.append(line)
        continue

    if in_browser and stripped and indent <= browser_indent and stripped != "browser:":
        if not seen_cloud_provider:
            out.append(" " * (browser_indent + 2) + "cloud_provider: local")
        if not seen_cdp_url:
            out.append(" " * (browser_indent + 2) + f"cdp_url: {ws_url}")
        in_browser = False

    if in_browser and stripped.startswith("cloud_provider:"):
        out.append(" " * indent + "cloud_provider: local")
        seen_cloud_provider = True
        continue

    if in_browser and stripped.startswith("cdp_url:"):
        out.append(" " * indent + f"cdp_url: {ws_url}")
        seen_cdp_url = True
        continue

    out.append(line)

if in_browser:
    if not seen_cloud_provider:
        out.append(" " * (browser_indent + 2) + "cloud_provider: local")
    if not seen_cdp_url:
        out.append(" " * (browser_indent + 2) + f"cdp_url: {ws_url}")

config_path.write_text("\n".join(out) + "\n")
print(f"Updated {config_path}")
PY
}

status_brave() {
  if cdp_ready; then
    echo "CDP ready on 127.0.0.1:$PORT"
    print_connect_url
  else
    echo "CDP not running on port $PORT"
    exit 1
  fi
}

stop_brave() {
  pkill -f "Brave Browser.*--remote-debugging-port=${PORT}" 2>/dev/null || true
  echo "Stopped Brave debug instances on port $PORT (if any were running)."
}

cmd="${1:-}"
case "$cmd" in
  start) start_brave ;;
  sync-config) sync_hermes_config ;;
  url) print_connect_url ;;
  status) status_brave ;;
  stop) stop_brave ;;
  -h|--help|help|"") usage ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac