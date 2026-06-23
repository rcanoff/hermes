#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT/browser-daemon"
PID_FILE="$ROOT/data/browser-daemon.pid"
LOG_FILE="$ROOT/data/browser-daemon.log"
ENV_FILE="$ROOT/browser-daemon/.env"

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|status>

Runs browser-daemon on the Mac host (not in Docker).
Hermes in Docker should use browser.cdp_url=http://host.docker.internal:9221
EOF
}

ensure_built() {
  if test ! -f "$DAEMON_DIR/dist/index.js"; then
    (cd "$DAEMON_DIR" && npm install && npm run build)
  fi
}

start_daemon() {
  ensure_built
  mkdir -p "$ROOT/data"

  if test -f "$PID_FILE"; then
    old_pid="$(cat "$PID_FILE")"
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "browser-daemon already running (pid $old_pid)"
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  export HERMES_DATA_DIR="$ROOT/data"
  if test -f "$ENV_FILE"; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi

  nohup node "$DAEMON_DIR/dist/index.js" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 0.5
  echo "browser-daemon started (pid $(cat "$PID_FILE"), log: $LOG_FILE)"
}

stop_daemon() {
  if test ! -f "$PID_FILE"; then
    echo "browser-daemon is not running"
    return 0
  fi

  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped browser-daemon (pid $pid)"
  else
    echo "Stale pid file; daemon not running"
  fi
  rm -f "$PID_FILE"
}

status_daemon() {
  if test -f "$PID_FILE" && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    curl -fsS "http://127.0.0.1:9221/health" || true
    echo
    return 0
  fi
  echo "browser-daemon is not running"
  return 1
}

cmd="${1:-}"
case "$cmd" in
  start) start_daemon ;;
  stop) stop_daemon ;;
  status) status_daemon ;;
  -h|--help|help|"") usage ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac