#!/bin/sh

set -eu

ENV_FILE=${1:-.env}
CONFIG_FILE=${2:-data/config.yaml}

if [ ! -f "$ENV_FILE" ]; then
  printf 'Missing env file: %s\n' "$ENV_FILE" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  printf 'Missing config file: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

case "$ENV_FILE" in
  */*) SOURCE_ENV_FILE=$ENV_FILE ;;
  *) SOURCE_ENV_FILE=./$ENV_FILE ;;
esac

set -a
. "$SOURCE_ENV_FILE"
set +a

if [ -z "${CALDAV_MCP_BEARER_TOKEN:-}" ]; then
  printf 'CALDAV_MCP_BEARER_TOKEN is empty in %s\n' "$ENV_FILE" >&2
  exit 1
fi

tmp_file=$(mktemp)
updated_flag=$(mktemp)
cleanup() {
  rm -f "$tmp_file" "$updated_flag"
}
trap cleanup EXIT

awk '
  BEGIN {
    inside_apple_calendar = 0
    inside_headers = 0
    updated = 0
    token = ENVIRON["CALDAV_MCP_BEARER_TOKEN"]
  }
  {
    line = $0
    sub(/\r$/, "", line)

    if (line == "  apple_calendar:") {
      inside_apple_calendar = 1
      inside_headers = 0
      print line
      next
    }

    if (inside_apple_calendar && substr(line, 1, 2) == "  " && substr(line, 1, 4) != "    ") {
      inside_apple_calendar = 0
      inside_headers = 0
    }

    if (inside_apple_calendar && line == "    headers:") {
      inside_headers = 1
      print line
      next
    }

    if (inside_headers && index(line, "      Authorization: Bearer ") == 1) {
      print "      Authorization: Bearer " token
      inside_headers = 0
      updated = 1
      next
    }

    print line
  }
  END {
    if (updated) {
      print "1" > updated_flag
    }
  }
' updated_flag="$updated_flag" "$CONFIG_FILE" > "$tmp_file"

if [ ! -s "$updated_flag" ]; then
  printf 'Apple Calendar Authorization header not found in %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

mv "$tmp_file" "$CONFIG_FILE"

printf 'Synced Apple Calendar MCP token in %s from %s\n' "$CONFIG_FILE" "$ENV_FILE"
