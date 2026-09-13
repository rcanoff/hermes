#!/usr/bin/env bash
# One-shot: copy global Honcho peer `roberto` + root USER.md/MEMORY.md onto
# Companion user `rcanoff`. Idempotent via data/memories/.per-user-rcanoff-migrated.
# Fails if messaging-api sqlite has no user named rcanoff (does not create a login).
# Root memory files are emptied only after copies succeed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEMORIES="${ROOT}/data/memories"
USER_MD="${MEMORIES}/USER.md"
MEMORY_MD="${MEMORIES}/MEMORY.md"
STAMP="${MEMORIES}/.per-user-rcanoff-migrated"
HONCHO_JSON="${ROOT}/data/honcho.json"
DB="${MESSAGING_API_DB:-${ROOT}/data/messaging-api.sqlite}"
HONCHO_URL="${HONCHO_URL:-http://127.0.0.1:${HONCHO_API_PORT:-8000}}"
WORKSPACE="${HONCHO_WORKSPACE:-hermes}"
SOURCE_PEER="${HONCHO_SOURCE_PEER:-roberto}"
TARGET_USER="${HONCHO_TARGET_USER:-rcanoff}"
AI_PEER="${HONCHO_AI_PEER:-hermes}"
SESSION_ID="${HONCHO_MIGRATION_SESSION:-peer-migration-rcanoff}"
MOVED_NOTE="Moved to users/${TARGET_USER}/."

if [[ -f "$STAMP" ]]; then
  printf 'already migrated (%s); skip\n' "$STAMP"
  cat "$STAMP"
  exit 0
fi

if [[ ! -f "$DB" ]]; then
  printf 'messaging-api sqlite not found: %s\n' "$DB" >&2
  exit 1
fi

export DB TARGET_USER
python3 - <<'PY'
import os
import sqlite3
import sys

db_path = os.environ["DB"]
username = os.environ["TARGET_USER"]
con = sqlite3.connect(db_path)
try:
    row = con.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
finally:
    con.close()
if not row:
    print(f"messaging-api user {username!r} does not exist in {db_path}", file=sys.stderr)
    sys.exit(1)
print(f"found sqlite user {username} id={row[0]}")
PY

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

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="${MEMORIES}/backup/per-user-${TARGET_USER}-${TIMESTAMP}"
USER_DIR="${MEMORIES}/users/${TARGET_USER}"
mkdir -p "$BACKUP" "$USER_DIR"

if [[ -f "$USER_MD" ]]; then
  cp "$USER_MD" "$BACKUP/USER.md"
  cp "$USER_MD" "$USER_DIR/USER.md"
else
  printf 'warning: missing %s\n' "$USER_MD" >&2
  : > "$USER_DIR/USER.md"
fi
if [[ -f "$MEMORY_MD" ]]; then
  cp "$MEMORY_MD" "$BACKUP/MEMORY.md"
  cp "$MEMORY_MD" "$USER_DIR/MEMORY.md"
else
  printf 'warning: missing %s\n' "$MEMORY_MD" >&2
  : > "$USER_DIR/MEMORY.md"
fi

printf 'copied memory files to %s and %s\n' "$BACKUP" "$USER_DIR"

export HONCHO_URL WORKSPACE SOURCE_PEER TARGET_USER AI_PEER SESSION_ID STAMP HONCHO_JSON MOVED_NOTE USER_MD MEMORY_MD BACKUP USER_DIR

python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base = os.environ["HONCHO_URL"].rstrip("/")
workspace = os.environ["WORKSPACE"]
source_peer = os.environ["SOURCE_PEER"]
target_peer = os.environ["TARGET_USER"]
ai_peer = os.environ["AI_PEER"]
session_id = os.environ["SESSION_ID"]
stamp_path = os.environ["STAMP"]
honcho_json_path = os.environ["HONCHO_JSON"]
moved_note = os.environ["MOVED_NOTE"]
user_md = os.environ["USER_MD"]
memory_md = os.environ["MEMORY_MD"]
backup = os.environ["BACKUP"]
user_dir = os.environ["USER_DIR"]


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


def list_all(method, path, body=None):
    items = []
    page = 1
    total = None
    while True:
        sep = "&" if "?" in path else "?"
        payload = request(
            method,
            f"{path}{sep}page={page}&size=100",
            body if body is not None else {},
            expected=(200,),
        )
        chunk = payload.get("items") or []
        items.extend(chunk)
        total = payload.get("total", len(items))
        pages = payload.get("pages") or 1
        if page >= pages or not chunk:
            break
        page += 1
    return items, total


request("POST", "/v3/workspaces", {"id": workspace, "metadata": {"source": "hermes-per-user-memory"}})
request("POST", f"/v3/workspaces/{workspace}/peers", {"id": target_peer, "metadata": {"role": "user"}})
request("POST", f"/v3/workspaces/{workspace}/peers", {"id": ai_peer, "metadata": {"role": "assistant"}})
request(
    "POST",
    f"/v3/workspaces/{workspace}/sessions",
    {
        "id": session_id,
        "metadata": {"source": "per-user-rcanoff-migration", "copied_from_peer": source_peer},
        "peers": {
            target_peer: {"observe_me": True, "observe_others": False},
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

source_sessions, _ = list_all("POST", f"/v3/workspaces/{workspace}/peers/{source_peer}/sessions", {})
source_session_ids = [s["id"] for s in source_sessions if s.get("id")]

messages_posted = existing
if existing:
    print(f"session {session_id} already has {existing} messages; skip post")
else:
    outbound = []
    for sid in source_session_ids:
        msgs, _ = list_all("POST", f"/v3/workspaces/{workspace}/sessions/{sid}/messages/list", {})
        for msg in msgs:
            peer_id = msg.get("peer_id")
            if peer_id == source_peer:
                peer_id = target_peer
            outbound.append(
                {
                    "content": msg.get("content") or "",
                    "peer_id": peer_id,
                    "metadata": {
                        **(msg.get("metadata") or {}),
                        "migrated_from_peer": source_peer,
                        "migrated_from_session": sid,
                    },
                    "created_at": msg.get("created_at"),
                }
            )

    created = []
    batch_size = 100
    for start in range(0, len(outbound), batch_size):
        chunk = outbound[start : start + batch_size]
        created.extend(
            request(
                "POST",
                f"/v3/workspaces/{workspace}/sessions/{session_id}/messages",
                {"messages": chunk},
                expected=(201,),
            )
        )
    messages_posted = len(created)
    print(
        f"posted {messages_posted} messages from {len(source_session_ids)} "
        f"{source_peer} session(s) onto {session_id} peer {target_peer}"
    )

card = request("GET", f"/v3/workspaces/{workspace}/peers/{source_peer}/card", expected=(200,))
peer_card = card.get("peer_card") if isinstance(card, dict) else None
if peer_card:
    request(
        "PUT",
        f"/v3/workspaces/{workspace}/peers/{target_peer}/card",
        {"peer_card": peer_card},
        expected=(200,),
    )
    print(f"copied peer card {source_peer} -> {target_peer} ({len(peer_card)} lines)")

# Empty root files only after Honcho + per-user copies succeeded.
for path in (user_md, memory_md):
    if os.path.isfile(path):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(moved_note + "\n")

if os.path.isfile(honcho_json_path):
    with open(honcho_json_path, encoding="utf-8") as fh:
        honcho = json.load(fh)
    hosts = honcho.setdefault("hosts", {})
    hermes = hosts.setdefault("hermes", {})
    hermes["peerName"] = target_peer
    hermes["pinUserPeer"] = False
    with open(honcho_json_path, "w", encoding="utf-8") as fh:
        json.dump(honcho, fh, indent=2)
        fh.write("\n")
    print(f"updated {honcho_json_path}: peerName={target_peer} pinUserPeer=false")
else:
    print(f"warning: missing {honcho_json_path}", file=sys.stderr)

stamp = {
    "workspace": workspace,
    "session_id": session_id,
    "source_peer": source_peer,
    "target_peer": target_peer,
    "ai_peer": ai_peer,
    "source_sessions": source_session_ids,
    "messages_posted": messages_posted,
    "peer_card_copied": bool(peer_card),
    "backup": backup,
    "user_dir": user_dir,
}
with open(stamp_path, "w", encoding="utf-8") as fh:
    json.dump(stamp, fh, indent=2)
    fh.write("\n")
print(f"wrote {stamp_path}")
PY
