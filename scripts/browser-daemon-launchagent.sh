#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT/browser-daemon"
TEMPLATE="$DAEMON_DIR/launchd/com.hermes.browser-daemon.plist"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/com.hermes.browser-daemon.plist"
LABEL="com.hermes.browser-daemon"
GUI_DOMAIN="gui/$(id -u)"
LOG_FILE="$ROOT/data/browser-daemon.log"

usage() {
  cat <<EOF
Usage: $(basename "$0") <install|uninstall|status>

  install    Build browser-daemon and install a Login Item LaunchAgent
  uninstall  Stop and remove the LaunchAgent
  status     Show whether the LaunchAgent is loaded
EOF
}

ensure_built() {
  if test ! -f "$DAEMON_DIR/dist/index.js"; then
    (cd "$DAEMON_DIR" && npm install && npm run build)
  fi
}

resolve_node() {
  if test -n "${NODE_BIN:-}"; then
    printf '%s' "$NODE_BIN"
    return 0
  fi
  command -v node
}

render_plist() {
  local node_path="$1"
  mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
  sed \
    -e "s|__NODE_PATH__|${node_path//|/\\|}|g" \
    -e "s|__DAEMON_ENTRY__|${DAEMON_DIR//|/\\|}/dist/index.js|g" \
    -e "s|__WORKING_DIRECTORY__|${DAEMON_DIR//|/\\|}|g" \
    -e "s|__HERMES_DATA_DIR__|${ROOT//|/\\|}/data|g" \
    -e "s|__PATH__|${PATH//|/\\|}|g" \
    -e "s|__LOG_FILE__|${LOG_FILE//|/\\|}|g" \
    "$TEMPLATE" >"$INSTALLED_PLIST"
}

is_loaded() {
  launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1
}

install_launchagent() {
  ensure_built
  local node_path
  node_path="$(resolve_node)"

  "$ROOT/scripts/browser-daemon.sh" stop >/dev/null 2>&1 || true
  render_plist "$node_path"

  if is_loaded; then
    launchctl bootout "$GUI_DOMAIN" "$INSTALLED_PLIST" >/dev/null 2>&1 || true
  fi

  launchctl bootstrap "$GUI_DOMAIN" "$INSTALLED_PLIST"
  echo "Installed LaunchAgent: $INSTALLED_PLIST"
  echo "browser-daemon will start at login and stay running."
}

uninstall_launchagent() {
  if is_loaded; then
    launchctl bootout "$GUI_DOMAIN" "$INSTALLED_PLIST"
  fi
  rm -f "$INSTALLED_PLIST"
  "$ROOT/scripts/browser-daemon.sh" stop >/dev/null 2>&1 || true
  echo "Removed LaunchAgent: $LABEL"
}

status_launchagent() {
  if is_loaded; then
    echo "LaunchAgent loaded: $LABEL"
    curl -fsS "http://127.0.0.1:9221/health" || true
    echo
    return 0
  fi
  echo "LaunchAgent not loaded: $LABEL"
  return 1
}

cmd="${1:-}"
case "$cmd" in
  install) install_launchagent ;;
  uninstall) uninstall_launchagent ;;
  status) status_launchagent ;;
  -h|--help|help|"") usage ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac