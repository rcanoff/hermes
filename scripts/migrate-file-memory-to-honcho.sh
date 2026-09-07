#!/usr/bin/env bash
# One-shot: post USER.md / MEMORY.md § records into Honcho session file-memory-migration.
# Idempotent via data/memories/.honcho-migrated. Live files stay in place.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEMORIES="${ROOT}/data/memories"
USER_MD="${MEMORIES}/USER.md"
MEMORY_MD="${MEMORIES}/MEMORY.md"
BACKUP="${MEMORIES}/backup"
STAMP="${MEMORIES}/.honcho-migrated"
HONCHO_URL="${HONCHO_URL:-http://127.0.0.1:${HONCHO_API_PORT:-8000}}"
WORKSPACE="${HONCHO_WORKSPACE:-hermes}"
USER_PEER="${HONCHO_USER_PEER:-roberto}"
AI_PEER="${HONCHO_AI_PEER:-hermes}"
SESSION_ID="${HONCHO_MIGRATION_SESSION:-file-memory-migration}"

if [[ ! -f "$USER_MD" || ! -f "$MEMORY_MD" ]]; then
  printf 'missing %s or %s\n' "$USER_MD" "$MEMORY_MD" >&2
  exit 1
fi

if [[ -f "$STAMP" ]]; then
  printf 'already migrated (%s); skip\n' "$STAMP"
  cat "$STAMP"
  exit 0
fi

printf 'waiting for %s/health\n' "$HONCHO_URL"
ok=0
for _ in $(seq 1 30); do
  if curl -sf "${HONCHO_URL}/health" >/dev/null; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" -ne 1 ]]; then
  printf 'Honcho health failed at %s\n' "$HONCHO_URL" >&2
  exit 1
fi

mkdir -p "$BACKUP"
cp "$USER_MD" "$BACKUP/USER.md"
cp "$MEMORY_MD" "$BACKUP/MEMORY.md"

export HONCHO_URL WORKSPACE USER_PEER AI_PEER SESSION_ID USER_MD MEMORY_MD STAMP

python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base = os.environ["HONCHO_URL"].rstrip("/")
workspace = os.environ["WORKSPACE"]
user_peer = os.environ["USER_PEER"]
ai_peer = os.environ["AI_PEER"]
session_id = os.environ["SESSION_ID"]
user_md = os.environ["USER_MD"]
memory_md = os.environ["MEMORY_MD"]
stamp_path = os.environ["STAMP"]


def request(method, path, body=None, expected=(200, 201)):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            payload = json.loads(raw) if raw else None
            if resp.status not in expected:
                raise SystemExit(f"{method} {path} -> {resp.status}: {payload}")
            return payload
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{method} {path} -> {e.code}: {detail}") from e


def split_records(path):
    text = open(path, encoding="utf-8").read()
    return [part.strip() for part in text.split("§") if part.strip()]


user_records = split_records(user_md)
ai_records = split_records(memory_md)
expected = len(user_records) + len(ai_records)
if expected == 0:
    raise SystemExit("no § records found in USER.md / MEMORY.md")

request("POST", "/v3/workspaces", {"id": workspace, "metadata": {"source": "hermes-file-memory"}})
request("POST", f"/v3/workspaces/{workspace}/peers", {"id": user_peer, "metadata": {"role": "user"}})
request("POST", f"/v3/workspaces/{workspace}/peers", {"id": ai_peer, "metadata": {"role": "assistant"}})
request(
    "POST",
    f"/v3/workspaces/{workspace}/sessions",
    {
        "id": session_id,
        "metadata": {"source": "file-memory-migration"},
        "peers": {
            user_peer: {"observe_me": True, "observe_others": False},
            ai_peer: {"observe_me": True, "observe_others": False},
        },
    },
)

listed = request(
    "POST",
    f"/v3/workspaces/{workspace}/sessions/{session_id}/messages/list",
    {},
    expected=(200,),
)
existing = listed.get("total", len(listed.get("items") or []))
if existing:
    stamp = {
        "workspace": workspace,
        "session_id": session_id,
        "user_peer": user_peer,
        "ai_peer": ai_peer,
        "user_records": len(user_records),
        "assistant_records": len(ai_records),
        "messages_posted": existing,
        "skipped": "session already had messages",
    }
    open(stamp_path, "w", encoding="utf-8").write(json.dumps(stamp, indent=2) + "\n")
    print(f"session already has {existing} messages; wrote stamp and skip post")
    sys.exit(0)

messages = [
    {
        "content": content,
        "peer_id": user_peer,
        "metadata": {"source": "USER.md", "index": i},
    }
    for i, content in enumerate(user_records)
] + [
    {
        "content": content,
        "peer_id": ai_peer,
        "metadata": {"source": "MEMORY.md", "index": i},
    }
    for i, content in enumerate(ai_records)
]

created = []
batch_size = 100
for start in range(0, len(messages), batch_size):
    chunk = messages[start : start + batch_size]
    created.extend(
        request(
            "POST",
            f"/v3/workspaces/{workspace}/sessions/{session_id}/messages",
            {"messages": chunk},
            expected=(201,),
        )
    )

listed = request(
    "POST",
    f"/v3/workspaces/{workspace}/sessions/{session_id}/messages/list",
    {},
    expected=(200,),
)
total = listed.get("total", len(listed.get("items") or []))
stamp = {
    "workspace": workspace,
    "session_id": session_id,
    "user_peer": user_peer,
    "ai_peer": ai_peer,
    "user_records": len(user_records),
    "assistant_records": len(ai_records),
    "messages_posted": len(created),
    "session_message_total": total,
}
open(stamp_path, "w", encoding="utf-8").write(json.dumps(stamp, indent=2) + "\n")
print(
    f"posted {len(created)} messages "
    f"(USER.md={len(user_records)} MEMORY.md={len(ai_records)}); "
    f"session total={total}"
)
if total != expected:
    raise SystemExit(f"session total {total} != expected {expected}")
PY
