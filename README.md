# Hermes Agent on macOS with Docker Compose

This directory contains a macOS-first Docker Compose setup for Hermes Agent using the official `nousresearch/hermes-agent` image, a bind mount at `/opt/data`, and a dashboard supervised inside the same container as the gateway.

## Files

- `docker-compose.yml`: single Hermes service with gateway and dashboard
- `.env.example`: local environment defaults
- `data/`: persisted Hermes state on the host

## Prerequisites

- Docker Desktop or OrbStack with Docker Compose support
- A local `.env` file copied from `.env.example`
- `HERMES_UID` and `HERMES_GID` set to your macOS user and group IDs

Get your numeric IDs:

```bash
id -u
id -g
```

Create your local environment file:

```bash
cp .env.example .env
```

Then update `HERMES_UID` and `HERMES_GID` in `.env` with the values from `id -u` and `id -g`.

## Start Hermes on macOS

Start Hermes:

```bash
make up
```

This is equivalent to:

```bash
docker compose up -d
```

Common operator shortcuts:

```bash
make hermes-config
make hermes-model
make hermes-mcp-list
make hermes-gateway-nosupervise
make hermes-shell
```

## Start Hermes on Windows PowerShell

This repo's `Makefile` is Unix-oriented. In PowerShell, use the native wrapper instead of `make`:

```powershell
.\scripts\hermes.ps1 up
```

Equivalent commands:

- `.\scripts\hermes.ps1 down`
- `.\scripts\hermes.ps1 ps`
- `.\scripts\hermes.ps1 logs`
- `.\scripts\hermes.ps1 config`
- `.\scripts\hermes.ps1 sync-apple-calendar-mcp-token`

The PowerShell wrapper mirrors the Makefile behavior, including syncing the Apple Calendar MCP bearer token into `data/config.yaml` before `up` and `config`.

## Start Hermes from WSL

If you run `make` from WSL, the operational targets `up`, `down`, `ps`, `logs`, `config`, and `restart` automatically delegate to the Windows PowerShell wrapper so they use the Windows Docker Desktop integration instead of the WSL `docker compose` path.

The dashboard is enabled inside the same container and published on the host at `${HERMES_DASHBOARD_PORT}` on all interfaces, so it is reachable from other machines on the same network at `http://<host-ip>:${HERMES_DASHBOARD_PORT}`.
Inside the container it binds to `0.0.0.0` so Docker can forward the port. Hermes v0.21+ requires dashboard auth on non-loopback binds (`HERMES_DASHBOARD_INSECURE` no longer disables that gate). Set `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` and `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` in `.env`.

Security note:

- anyone who can reach `http://<host-ip>:${HERMES_DASHBOARD_PORT}` still needs those dashboard credentials
- if you only want selected remote access, put Hermes behind a VPN, SSH tunnel, or a trusted reverse proxy instead of exposing the port broadly on your LAN

## Raspberry Pi deployment with Ansible

The repo includes an Ansible deployment project under `ansible/`. It deploys this local workspace to `rcanoff@raspberrypi5.local:/home/rcanoff/hermes` using `rsync` over SSH, then runs the remote Docker Compose update in place.

Run:

```bash
ansible-playbook -i ansible/inventory/hosts.yml ansible/deploy.yml
```

Deployment behavior:

- only changed files are pushed
- `data/` is excluded and remains remote runtime state on the Raspberry Pi
- `.env` is deployed from the local workspace
- the playbook runs `docker compose --env-file .env up -d` on the Pi

## Brave browser setup (Mac host + Docker Hermes)

Hermes runs in Docker, but Brave runs on the Mac host. The `browser-daemon` service launches Brave and exposes a CDP gateway Hermes can reach at `http://host.docker.internal:9221`.

1. Install the daemon and register it to start at login:

```bash
make browser-daemon-install
make browser-daemon-login-install
```

For a one-off manual start without Login Item registration, use `make browser-daemon-start` instead.

2. Point Hermes at the daemon (once per machine):

```bash
docker exec hermes hermes config set browser.cloud_provider local
docker exec hermes hermes config set browser.cdp_url http://host.docker.internal:9221
docker restart hermes
```

3. Log into Google in the Brave window when it first opens. The profile persists under `data/browser-profiles/hermes/`.

4. Ask Hermes to browse or search in the dashboard (`http://localhost:9119`) or Telegram. The first browser tool call asks the daemon to launch Brave if needed.

Useful endpoints on the Mac host:

- `GET http://127.0.0.1:9221/health`
- `POST http://127.0.0.1:9221/start`
- `GET http://127.0.0.1:9221/cdp-url`

Stop or remove the Login Item:

```bash
make browser-daemon-stop
make browser-daemon-login-uninstall
```

## Honcho (self-hosted memory)

Honcho runs on the **same Docker Compose** as Hermes. This workspace does **not** use Honcho Cloud.

| Service | Role | Host ports |
|---------|------|------------|
| `honcho-api` | FastAPI memory API | `127.0.0.1:${HONCHO_API_PORT:-8000}` only |
| `honcho-deriver` | extract / dream / summary | none |
| `honcho-db` | Postgres + pgvector | none (compose network) |
| `honcho-redis` | cache | none (compose network) |

There is **no** Honcho MCP container (port 3000 is `messaging-api`).

`make up` starts Honcho with Hermes. `hermes-gateway` waits until `honcho-api` is healthy. Hermes reads `data/honcho.json` (`baseUrl: http://honcho-api:8000`, workspace `hermes`). Long-term memory is **per Companion username** (Honcho human peer + `data/memories/users/<username>/`). Skills stay shared. TUI/CLI with no Companion header uses peer `rcanoff`.

```bash
make honcho-health          # curl 127.0.0.1:8000/health
make honcho-logs            # honcho-api + honcho-deriver
make migrate-honcho-memory  # one-shot USER.md/MEMORY.md → session file-memory-migration
make migrate-honcho-memory-to-rcanoff  # copy global roberto + root files onto user rcanoff
```

`migrate-honcho-memory` copies originals to `data/memories/backup/` first, then posts `§` records (legacy user peer `roberto`, AI peer `hermes`). Idempotent via `data/memories/.honcho-migrated`.

`migrate-honcho-memory-to-rcanoff` requires messaging-api user `rcanoff` in sqlite (does not create a login). It copies root `USER.md`/`MEMORY.md` to `data/memories/backup/per-user-rcanoff-<timestamp>/` **and** `data/memories/users/rcanoff/`, copies Honcho peer `roberto` messages onto peer `rcanoff` (session `peer-migration-rcanoff`), then empties the root files and sets `honcho.json` `peerName: rcanoff`, `pinUserPeer: false`. Idempotent via `data/memories/.per-user-rcanoff-migrated`. Restart the gateway after it so Hermes reloads `honcho.json`.

### LLM env (deriver / dialectic / embeddings)

Honcho will not start without an LLM. Set `LLM_OPENAI_API_KEY` in `.env` (never commit it). Defaults expect OpenAI-compatible chat **and** embeddings (`text-embedding-3-small`, 1536-d).

This Mac: OpenAI `OPENAI_API_KEY` is out of credits, so Honcho uses **OpenRouter** (`OPENROUTER_API_KEY` from `data/.env`) at `https://openrouter.ai/api/v1` with `openai/gpt-5.4-mini` and `openai/text-embedding-3-small`. Per-feature `*_MODEL_CONFIG__OVERRIDES__BASE_URL` and `*_MODEL` live in `.env` / `.env.example`. Recreate Honcho after changing them:

```bash
docker compose --env-file .env up -d --force-recreate honcho-api honcho-deriver
```

Do not point Honcho at xAI OAuth refresh tokens.

## OpenAI setup

Hermes can use the direct OpenAI API when `OPENAI_API_KEY` is set.

1. Add your key to `.env`:

```bash
OPENAI_API_KEY=sk-your-key-here
```

2. Recreate Hermes so the container gets the new env var:

```bash
make down
make up
```

3. Open the Hermes model picker:

```bash
docker exec -it hermes hermes model
```

Then choose:

- provider: `OpenAI API`
- model: an OpenAI model such as `openai/gpt-5.5`

Optional:

- `OPENAI_BASE_URL=https://api.openai.com/v1` for the standard OpenAI endpoint
- set `OPENAI_BASE_URL` only if you need a custom OpenAI-compatible endpoint

Notes:

- ChatGPT subscriptions and OpenAI API billing are separate.
- Hermes also supports `openai-codex` OAuth, but this Docker setup now explicitly supports direct API-key forwarding through `OPENAI_API_KEY`.

## Telegram bot setup

This workspace no longer injects Telegram credentials through Docker Compose env vars.
Configure Telegram directly inside Hermes instead, so bot tokens and chat settings live in Hermes' own config/state under `data/`.

Practical effect:

- removing or changing Telegram setup no longer requires editing `.env`
- restarting Compose will not overwrite Telegram settings from workspace env vars

## Reminders MCP setup

Hermes connects to **Apple Reminders** through the native macOS `apple-reminders-mcp` app on the same machine. The app exposes a bearer-protected MCP HTTP endpoint on localhost; Hermes reaches it from Docker via `host.docker.internal`.

Full app build, permission, and token setup: [`../apple-reminders-mcp/README.md`](../apple-reminders-mcp/README.md).

Add this value to `.env`:

```bash
APPLE_MCP_BEARER_TOKEN=replace-with-same-token-as-apple-mcp-app
```

`REMINDERS_MCP_BEARER_TOKEN` is still accepted as a **fallback for one release** if you have not renamed the env var yet.

Operator flow:

1. Build and run `apple-reminders-mcp` (or `apple-mcp`) on the Mac (menu-bar agent; default port **3020**).
2. Grant Reminders access in the app settings.
3. Copy the bearer token from the app settings → paste into `hermes/.env` as `APPLE_MCP_BEARER_TOKEN`.
4. Sync config and restart if needed:

```bash
make config
make down && make up
```

Notes:

- Hermes reaches the MCP at `http://host.docker.internal:3020/mcp` — not `127.0.0.1` from inside the container.
- `make up` and `make config` automatically sync the `apple` bearer token in `data/config.yaml` from the selected env file (`.env` if present, otherwise `.env.example`) without printing it.
- If you need to sync the token without starting or rendering Compose, run `make sync-apple-mcp-token` (`make sync-reminders-mcp-token` is a deprecated alias).
- Regenerating the token in the macOS app invalidates the old value — update `.env` and run `make config` again.
- Task/list intents route through the `companion-reminders` skill (see `data/skills/companion-reminders/SKILL.md`).

`data/config.yaml` is the runtime config Hermes reads, but its `apple` bearer header is operator-synced from `APPLE_MCP_BEARER_TOKEN` (or `REMINDERS_MCP_BEARER_TOKEN` fallback) — update the env file, not that header by hand.

### Companion user headers (`X-Companion-User-Id`, `X-Companion-Username`)

Maps tools in **apple-mcp** resolve iPhone location by companion **user UUID** (`users.id`). Honcho long-term memory uses the **username**. Hermes injects both on companion conversation turns:

| Layer | Role |
|-------|------|
| `messaging-api` | `X-Hermes-Session-Key: companion-app:<userId>`, `X-Companion-User-Id`, `X-Companion-Username` on stream, complete, and `ensureSession` |
| `scripts/patches/api_server.py` | UUID → `HERMES_SESSION_USER_ID` (Maps). Username → Honcho human peer (`rcanoff` if the username header is absent) |
| `scripts/patches/api_server_openai_routes.py` | Parses companion headers on `/v1/chat/completions` and `/v1/responses` |
| `scripts/patches/mcp_tool.py` | Adds `X-Companion-User-Id` to each HTTP request to the `apple` MCP server when session context has a user id |
| `scripts/patches/mcp_tool_transport.py` / `mcp_tool_loop.py` / `mcp_tool_handlers.py` | HTTP hook, session-context wrap, and in-flight apple user id (split from `mcp_tool.py` in v0.21.3) |
| `scripts/patches/memory_tool.py` | File backup dir `memories/users/<username>/` (TUI fallback `rcanoff`) |
| `scripts/patches/profiles.py` | Nested Companion bot ids (`<userId>/<slug>`) |

Title generation and cron prompt synthesis keep their existing session keys and **omit** `X-Companion-Username`.

Patches are mounted in `docker-compose.yml` over the matching Hermes image paths under `/opt/hermes/gateway/platforms/`, `/opt/hermes/tools/`, and `/opt/hermes/hermes_cli/`. Restart the stack after editing them (`make down && make up`).

Manual check (companion chat that calls an `apple` MCP tool):

```bash
# apple-mcp logs or proxy should show X-Companion-User-Id on POST /mcp
docker logs --tail=50 <apple-mcp-container-or-host-app-logs>
```

### End-to-end verification

Prerequisites (all must pass before Hermes MCP tests):

| Check | Command / action | Expected |
|-------|------------------|----------|
| macOS app running | Menu-bar icon **green** in `apple-reminders-mcp` | Settings shows **Listening on 127.0.0.1:3020** |
| Reminders access | App **Settings → Reminders Access** | Status **Granted** (not Denied / Not Determined) |
| Bearer token in `.env` | `APPLE_MCP_BEARER_TOKEN` set (same value as app settings) | `make sync-apple-mcp-token` exits 0 |
| Config synced | `make config` | `data/config.yaml` `apple.headers.Authorization` is not `REPLACE_ME` |
| Hermes stack up | `make ps` | `hermes` container **Up** |

**1. Host health (Mac)**

Export the token from `.env` (do not commit it):

```bash
set -a; source .env; set +a
curl -sS http://127.0.0.1:3020/health -H "Authorization: Bearer ${APPLE_MCP_BEARER_TOKEN:-$REMINDERS_MCP_BEARER_TOKEN}"
```

Expected when Reminders and Maps modules are healthy:

```json
{"ok":true,"modules":[{"id":"reminders","enabled":true,"healthy":true,"permission":"granted"},{"id":"maps","enabled":true,"healthy":true,"permission":"not_applicable"}]}
```

If `ok` is `false`, open app settings and grant Reminders access, then retry.

**2. Sync token and reload Hermes**

```bash
make config
make down && make up
```

Or reload MCPs in an active Hermes session: `/reload-mcp`

**3. Hermes MCP transport**

```bash
docker exec -it hermes hermes mcp list
docker exec -it hermes hermes mcp test apple
```

Expected: `✓` connection success and **23 tools** — 12 `reminders_*` + 11 `maps_*` (not `Connection failed` / `All connection attempts failed`).

**4. Direct `maps_*` tool calls (host curl)**

Resolve a companion `user_id` (UUID from `GET /auth/me` or `list_companion_accounts`). Export tokens from `.env`:

```bash
set -a; source .env; set +a
USER_ID="<companion-user-uuid>"   # e.g. from GET /auth/me
APPLE_TOKEN="${APPLE_MCP_BEARER_TOKEN:-$REMINDERS_MCP_BEARER_TOKEN}"
```

Geocode (no user header required):

```bash
curl -sS http://127.0.0.1:3020/mcp \
  -H "Authorization: Bearer $APPLE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"maps_geocode","arguments":{"address":"Golden Gate Bridge, San Francisco"}}}'
```

Route with explicit coordinates (`transport_type` is `driving`, `walking`, or `transit` — not `automobile`):

```bash
curl -sS http://127.0.0.1:3020/mcp \
  -H "Authorization: Bearer $APPLE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Companion-User-Id: $USER_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"maps_calculate_route","arguments":{"origin_latitude":37.7749,"origin_longitude":-122.4194,"destination_latitude":37.8197245,"destination_longitude":-122.4785568,"transport_type":"driving"}}}'
```

Expected: `isError` false; `distanceMeters` and `expectedTravelTimeSeconds` in the result text.

iPhone vault location (`maps_phone_location` — **requires** `X-Companion-User-Id`):

```bash
curl -sS http://127.0.0.1:3020/mcp \
  -H "Authorization: Bearer $APPLE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Companion-User-Id: $USER_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"maps_phone_location","arguments":{}}}'
```

Route with omitted origin (uses iPhone vault as origin — same header required):

```bash
curl -sS http://127.0.0.1:3020/mcp \
  -H "Authorization: Bearer $APPLE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Companion-User-Id: $USER_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"maps_calculate_route","arguments":{"destination_latitude":52.516275,"destination_longitude":13.377704,"transport_type":"driving"}}}'
```

**5. Companion vault MCP (apple-mcp upstream)**

Confirm `messaging-api` vault read works (apple-mcp `PhoneLocationProvider` calls this):

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $COMPANION_MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"get_user_location_for_user_id\",\"arguments\":{\"user_id\":\"$USER_ID\"}}}"
```

Expected: SSE `event: message` with `"available": true` and Berlin/SF coordinates when the user has synced location.

```bash
docker exec hermes hermes mcp test companion   # expect 12 tools incl. get_user_location_for_user_id
```

**6. Companion chat smoke test**

In the iOS companion app (or any client on the Companion App channel):

1. Send: `list my reminder lists` — should return list **names** (via `companion-reminders` skill).
2. Send: `add test item to Hermes list` — confirm the item appears in Reminders.app on Mac/iPhone within normal iCloud sync latency.
3. Send: `where am I?` (user with location sharing) — should return vault coordinates; mention staleness if `synced_at` is old.
4. Send: `how long to drive from downtown San Francisco to the Golden Gate Bridge?` — should return ETA/distance and an Apple Maps link.

Use a dedicated test list (e.g. **Hermes**) if you do not want clutter on personal lists.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `curl` connection refused on `:3020` | App not running or MCP not started | Launch from Xcode (⌘R) or `open` the built `.app`; confirm menu-bar status is green |
| `APPLE_MCP_BEARER_TOKEN is empty` on `make config` | Token missing from `.env` | Copy token from app settings → `hermes/.env` as `APPLE_MCP_BEARER_TOKEN` → `make config` |
| Hermes shows `Bear***E_ME` / auth fails | Config not synced | `make sync-apple-mcp-token` then `/reload-mcp` or `make down && make up` |
| `docker … mcp test apple` connection failed | App down, wrong port, or `host.docker.internal` unreachable | Fix host health first; confirm port **3020** in app settings |
| `{"ok":false,"error":"Reminders access not granted"}` | macOS TCC | App settings → **Request Access**; enable app in **System Settings → Privacy & Security → Reminders** |
| Chat uses wrong backend | Stale session | New conversation or `/reload-mcp`; confirm `companion-app` routes map intents to `companion-maps` and tasks to `companion-reminders` |
| `maps_phone_location` / omitted-origin route returns `The data couldn't be read because it isn't in the correct format` | apple-mcp `CompanionMcpClient` does not parse messaging-api SSE (`event: message\ndata: …`) responses | Fix in `apple-mcp` — parse Streamable HTTP body before `JSONSerialization`; vault direct curl (step 5) should pass first |
| `transport_type must be driving, walking, or transit` | Wrong enum in tool args | Use `driving` not `automobile` |
| `Directions Not Available` | Unreasonable route (e.g. Berlin → Golden Gate driving) | Test with local origin/destination or explicit coordinates in the same metro area |

Safe read-first order: host `curl` health → `hermes mcp test apple` (23 tools) → `maps_geocode` curl → companion vault curl → `maps_phone_location` curl → chat smoke tests.

## Apple Calendar MCP setup

Hermes connects to Apple Calendar through the local `apple-caldav-mcp` service in this Compose stack. The custom service speaks CalDAV to iCloud and exposes an internal-only MCP HTTP endpoint to Hermes on the Docker network.

Add these values to `.env`:

```bash
APPLE_CALDAV_URL=https://caldav.icloud.com
APPLE_CALDAV_USERNAME=your-apple-id
APPLE_CALDAV_APP_PASSWORD=your-app-specific-password
CALDAV_MCP_BEARER_TOKEN=generate-a-long-random-token
```

Notes:

- `APPLE_CALDAV_APP_PASSWORD` must be an Apple app-specific password, not your normal Apple account password.
- The first `make up` after adding this service will build the local `apple-caldav-mcp` image from `docker/apple-caldav-mcp/Dockerfile`.
- The image installs production dependencies only and copies the repo's prebuilt `apple-caldav-mcp/dist` output, so refresh that build locally before rebuilding the image if the MCP source changes.
- Hermes reaches the MCP over the internal Compose network at `http://apple-caldav-mcp:3000/mcp`; nothing is published on the host for this service.
- `make up` and `make config` automatically sync the `apple_calendar` bearer token in `data/config.yaml` from the selected env file (`.env` if present, otherwise `.env.example`) without printing it.
- If you need to sync the token without starting or rendering Compose, run `make sync-apple-calendar-mcp-token`.
- After the synced `data/config.yaml` changes, reload MCPs in an active Hermes session with `/reload-mcp`. If you are not in an active session, restarting the stack also reloads the MCP config.

`data/config.yaml` is the runtime config Hermes reads, but its `apple_calendar` bearer header is now operator-synced from `CALDAV_MCP_BEARER_TOKEN` so you should update the env file, not edit that header by hand.

Operator verification:

```bash
make down
make up
docker compose ps
docker compose logs --tail=100 apple-caldav-mcp
docker exec -it hermes hermes mcp list
docker exec -it hermes hermes mcp test apple_calendar
```

Safe read-first verification:

- Run `docker exec -it hermes hermes mcp test apple_calendar` to confirm transport and auth.
- In a fresh Hermes session or after `/reload-mcp`, ask read-only questions first, such as listing calendars or showing events for a date range, before attempting creates or updates.

## Trip records vault

Hermes keeps a centralized memory of personal records — currently trips — in
per-user Obsidian-compatible markdown vaults. The host bind is the iCloud
Obsidian **Documents parent** (`OBSIDIAN_VAULTS_HOST_PATH`). Inside the
container the live root is `/opt/data/vaults/<username.lower()>` (rcanoff →
`/opt/data/vaults/rcanoff`, AlineTusi → `/opt/data/vaults/alinetusi`). Skills
resolve that folder; do **not** use `/opt/data/vault` as the live root.

On macOS, set `OBSIDIAN_VAULTS_HOST_PATH` to the iCloud Obsidian `Documents`
directory (the parent of per-user vault folders). Keep `data/vault` as a
**real empty directory** so old nested-bind leftovers cannot become a
symlink; live notes are not there. If the host path is a symlink into iCloud,
Docker follows it and `write_file`/`patch` may be denied
(`HERMES_WRITE_SAFE_ROOT=/opt/data`). Do not copy live notes into `data/vault`.
After replacing a symlink with a directory, recreate `hermes-gateway` so the
nested bind applies.

One note per trip lives in `Trips/` (named `YYYY-MM Origin-Destination.md`) and holds
canonical booking facts: trip span, flight numbers, confirmation codes, lodging and
car rental references. Enriched detail (terminal, address, when to leave) lives on
the linked calendar event, and each event's UID is written back onto the note's fact
line to prevent duplicates.

The workflow is defined by the `productivity/trip-records` skill in `data/skills/`,
which composes the existing `note-taking/obsidian` and
`productivity/travel-bookings-to-calendar` skills. Design spec:
`docs/history/implemented/specs/2026-06-12-obsidian-trip-records-vault-design.md`.

The vault is plain markdown. Open the per-user folder in Obsidian on Mac/iPhone
(`Documents/rcanoff` or `Documents/alinetusi`). Drive `Obsidian/Hermes` is the
rcanoff vault only; Aline is iCloud-only. Live notes stay in iCloud, not in
`data/`.

## macOS validation steps

1. Copy `.env.example` to `.env` and set your UID/GID values.
2. Start Hermes with `make up`.
3. Check container status with `docker compose ps` or `make ps`.
4. Inspect logs with `docker compose logs --tail=100 hermes-gateway` or `make logs`.
5. Confirm the data directory was created under `./data`.
6. Restart with `docker compose restart` and confirm the container comes back cleanly.
7. Recreate with `docker compose up -d --force-recreate` and confirm data still exists in `./data`.
8. Open `http://127.0.0.1:${HERMES_DASHBOARD_PORT}` to confirm the dashboard is reachable on localhost.

## Messaging API setup

The iOS companion talks to a private `messaging-api` service running alongside Hermes on the Raspberry Pi.

Add these variables to `.env`:

```dotenv
HERMES_API_SERVER_KEY=replace-this
MESSAGING_API_PORT=3000
MESSAGING_API_JWT_SECRET=replace-this
MESSAGING_API_HOST=100.x.x.x:3000
INVITE_EXPIRY_HOURS=48
MIN_PASSWORD_LENGTH=12
COMPANION_MCP_BEARER_TOKEN=replace-with-long-random-token
```

`HERMES_API_SERVER_KEY` enables Hermes's OpenAI-compatible listener on port `8642` inside the Docker network and authenticates `messaging-api` when it calls Hermes. In this deployment that path is the **Companion App** channel: `messaging-api` sends `X-Hermes-Session-Key: companion-app` on every Hermes call. Skill routing is **not** hardcoded in the API — the iOS app sends a `bootstrap` prompt on the first message of each conversation; the API stores and forwards it. See `companion-app` skill and OpenAPI v1.9.0.

Extra companion bots are official Hermes profiles named `{username}-{slug}` (for example `alice-travel`). `messaging-api` creates and deletes them through the Hermes dashboard (`HERMES_DASHBOARD_URL`); they live at `$HERMES_HOME/profiles/{username}-{slug}`. The operator `default` bot stays on the root Hermes home.

Companion cron creation must use the originating conversation transcript only — `session_search` is **disabled** for the `api_server` platform in `data/config.yaml` (`platform_toolsets.api_server` omits it).

`MESSAGING_API_HOST` must be the Tailscale-reachable IP and port of the messaging API. Set it to your Pi's Tailscale address, e.g. `100.x.x.x:3000`.

### Account setup (invite-based)

On a **cold start**, the messaging API has **no users**. Create the first companion account through Hermes using the `companion-account-management` skill (MCP tools `create_companion_invite`, etc.). Hermes generates a QR code containing the invite token; the user scans it in the iOS app to complete activation.

To reset a password, use `create_password_reset_invite` via the same skill and deliver the QR code the same way.

**Upgrading** from the bootstrap model: existing `operator` (or other) users in the SQLite database are preserved. You can keep using them or reset passwords via invite.

Start or update the stack:

```bash
make up
```

Verify the service:

```bash
curl http://<tailscale-ip>:3000/health
make messaging-api-logs
```

### User-wide session stream (v2.10.0)

The messaging API exposes a **persistent per-auth-session** SSE at `GET /events/stream`. Open it once at login (after storing the JWT); it stays open across runs until logout or disconnect. Requires a JWT with a `jti` session claim (re-login if you have an older token without `jti`).

As of **v2.10.0**, live events fan out to **all connected auth sessions** for the user — iPhone, Mac, and additional simulators all receive the same `tooling`, `reply`, and committed-mutation events while streams are connected. Sync feeds remain the durability layer for reconnect and missed events. Design: [`docs/superpowers/specs/2026-06-23-companion-user-live-sync-design.md`](docs/superpowers/specs/2026-06-23-companion-user-live-sync-design.md).

**Session SSE event lanes** (all include `conversationId`; run-scoped events include `runId`):

| event | purpose |
|-------|---------|
| `tooling` | Reasoning drafts (`draft: true`), structured tooling lines (`phase`, `tool`, `args`), `phase: "complete"` |
| `reply` | Answer token deltas and `phase: "done"` with `messageId` |
| `title` | Auto-generated conversation title saved on first message |
| `rewind` | Messages removed before an edit rerun |
| `error` | Run failed (`code`); stream **stays open** |
| `message_upsert` | User or assistant message committed (full `Message` shape) |
| `messages_rewound` | Tail messages deleted; includes `removed_message_ids` and rotated `hermes_session_id` |
| `conversation_deleted` | Conversation removed server-side |

After `reply` with `phase: "done"`, commit locally and reconcile via `GET /conversations/{id}/sync`. Background clients also apply `message_upsert`, `messages_rewound`, and `conversation_deleted` from SSE for immediate cross-device state.

**Deprecated:** `GET /conversations/:id/stream` (legacy per-conversation stream). Retained until the iOS companion migrates.

**Operator smoke test:**

```bash
# Terminal 1 — persistent session stream
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:3000/events/stream

# Terminal 2 — send a message (no per-send stream open)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Use skills_list with category productivity; one skill name only."}' \
  http://localhost:3000/conversations/$CONV_ID/messages
```

Expect `tooling` lines before `reply` tokens; stream stays open after `"phase":"done"`.

**Tooling lines (v2.7.0):** committed `tooling` events and persisted `process.lines` use `phase` (`reasoning` | `activity` | `status`), `text`, optional Hermes `tool`, and optional `args`. Interim narration before tool calls uses `phase: status`. Deploy messaging-api and the iOS companion together — v2.6 clients expecting `kind` will break. Design: [`docs/superpowers/specs/2026-06-21-companion-tooling-lines-design.md`](docs/superpowers/specs/2026-06-21-companion-tooling-lines-design.md).

**Photo and file attachments (v2.8.0, documents v2.25.0):** staged upload then send. `POST /attachments` (multipart, one file, max 20 MB) accepts JPEG/PNG/HEIC/HEIF plus `text/plain`, `application/pdf`, and `application/octet-stream`. Images store original plus `thumb.jpg` + `vision.jpg`; documents store original bytes only. `GET /attachments/:id?variant=original` serves the file; `thumb`/`vision` are image-only (`400` for documents). `POST /conversations/:id/messages` accepts `{ text?, attachment_ids }` (1–10, optional shared caption). Messages sync via existing `message_upsert` metadata. Hermes receives multimodal history for images (vision JPEG base64); documents are not inlined as vision. Deploy messaging-api and the companion together. Design: [`docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md`](docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md).

After the run completes, `GET /conversations/:id/messages` includes an optional `process` field on assistant messages:

```json
{
  "role": "assistant",
  "content": "It is sunny in Lisbon.",
  "process": {
    "lines": [
      { "phase": "reasoning", "text": "Looking up weather…" },
      {
        "phase": "activity",
        "text": "Running lookup weather",
        "tool": "lookup_weather",
        "args": { "query": "Lisbon" }
      }
    ]
  }
}
```

Process lines require Hermes to emit reasoning and tool deltas on `/v1/chat/completions`. Operator settings in `data/config.yaml` under `display:`:

```yaml
display:
  show_reasoning: true   # required for reasoning process_token / process lines
  tool_progress: all     # Hermes emits hermes.tool.progress SSE frames (default)
  streaming: true
```

Restart Hermes after changing `show_reasoning`. Tool start/completion lines work without reasoning enabled.

**Note:** Hermes may emit no SSE frames while a long-running tool executes (only `running` and `completed` tool-progress events). The companion app should render those immediately; the final reply still streams via `token` events once Hermes resumes.

### Chat local-first sync (v2.1.0)

The companion app can open chat from a local store and reconcile server mutations incrementally.

**Sync feeds (additive — HAL list/history and SSE unchanged):**

- `GET /conversations/sync` — account-scoped conversation deltas (`conversation_upsert`, `conversation_deleted`)
- `GET /conversations/{id}/sync` — per-conversation committed-history deltas (`message_upsert`, `messages_rewound`, `conversation_deleted`) plus an authoritative `conversation` metadata snapshot
- `DELETE /conversations/{id}/messages/{messageId}` — tail rewind from anchor; rotates `hermes_session_id`; emits `messages_rewound` (v2.9.0)

Both return ordered `events`, `has_more`, and **always** return `next_sync_marker` on `200` (including empty pages). Markers are opaque UUID `event_id` values from an append-only `chat_sync_events` log. Origin sentinel when no events exist yet: `00000000-0000-4000-8000-000000000000`. Unknown `since` → `400 { error: sync_marker_invalid }`.

**Client recovery:**

- Missing account marker → call account sync with `since` omitted (self-heals from retained events).
- Missing thread marker → HAL-rehydrate `GET /conversations/{id}/messages`, then thread sync with `since` omitted.
- Invalid marker → clear stored marker and repeat the missing-marker path for that scope.

No MCP tools for sync in v2.1.0. Design: [`docs/history/implemented/specs/2026-06-17-companion-chat-local-sync-backend-design.md`](docs/history/implemented/specs/2026-06-17-companion-chat-local-sync-backend-design.md). Full contract: [`docs/superpowers/specs/messaging-api.openapi.yaml`](docs/superpowers/specs/messaging-api.openapi.yaml).

### Sync inbox (v2.6.0)

Per-device reconciliation for multi-device companion use:

- `PUT /devices/me` — register stable `device_id` per user
- `GET /sync/inbox?device_id=…` — coalesced `changes[]` since server cursor

Config: `SYNC_INBOX_MAX_GAP` (default `500`) — gap overflow returns `reset_required: true`.

Spec: [`docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md`](docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md)

### User location vault

The companion app writes location events to a user-scoped vault. Hermes reads location only through the companion MCP skill — not Home Assistant and not conversation routes.

**API (v1.7.0):** All list endpoints return HAL paginated responses (`_links.self|next|prev`): `GET /conversations`, `GET /conversations/:id/messages`, `GET /data/location/events`. Default `limit=20`, max 100. Location ingest/latest unchanged. Full contract: [`docs/superpowers/specs/messaging-api.openapi.yaml`](docs/superpowers/specs/messaging-api.openapi.yaml).

Conversation-scoped `/conversations/{id}/location/*` routes were removed. Location is available to Hermes via the `companion-user-location` skill and companion MCP tools only.

Add to `.env`:

```dotenv
COMPANION_MCP_BEARER_TOKEN=replace-with-long-random-token
ADDRESS_ENRICHMENT_SESSION_ID=companion-address-enrichment
```

`COMPANION_MCP_BEARER_TOKEN` secures `POST /mcp` for Hermes. Generate a long random token (same pattern as `CALDAV_MCP_BEARER_TOKEN`).

Register the companion MCP server in `data/config.yaml`:

```yaml
mcp_servers:
  companion:
    url: http://messaging-api:3000/mcp
    headers:
      Authorization: "Bearer <COMPANION_MCP_BEARER_TOKEN>"
```

Replace `<COMPANION_MCP_BEARER_TOKEN>` with the same value from `.env`. Reload MCPs with `/reload-mcp` in an active Hermes session, or restart the stack.

Companion MCP location tools (same bearer token):

- **`get_user_location_for_user_id`** — preferred for apple-mcp Maps and other service callers; pass `user_id` (UUID from `users.id`). Returns the latest vault fix keyed by user, not username.
- **`get_user_location`** — deprecated username variant; still used by `companion-user-location` during migration.
- **`get_location_history`** — paginated history by `username`.

`get_user_location_for_user_id` reads the latest `location_events` row for the user. When location sharing has synced at least one event:

```json
{
  "available": true,
  "user_id": "4e655874-72c9-4781-9944-221e487c4daa",
  "latitude": 52.51,
  "longitude": 13.46,
  "accuracy_meters": 14.2,
  "synced_at": "2026-06-23T17:02:59.074Z",
  "address": "Simon-Dach-Straße 10, Friedrichshain, 10245 Berlin, Germany"
}
```

When the user has no vault events: `{ "available": false, "user_id": "…" }`. Unknown `user_id` returns a tool error.

Operator verification:

```bash
docker compose build messaging-api && docker compose up -d messaging-api
docker exec hermes hermes mcp test companion
```

`hermes mcp test companion` should list **12** tools including `get_user_location_for_user_id`. To call the tool manually, resolve `user_id` from `list_companion_accounts`, then invoke `get_user_location_for_user_id` with `{ "user_id": "<uuid>" }` on `POST /mcp` (same bearer as above).

The `companion-user-location` skill in `data/skills/` still calls `get_user_location` and `get_location_history`. apple-mcp Maps calls `get_user_location_for_user_id` with the active conversation's `user_id` (from `X-Companion-User-Id`).

### Companion cron (job conversations)

Hermes cron jobs for the companion app use **job conversations** (`kind: job`). OpenAPI v2.3.0 adds `GET /jobs` and job fields on conversations.

Add to `.env`:

```dotenv
CRON_WEBHOOK_BEARER=replace-with-long-random-token
CRON_OUTPUT_DIR=/opt/data/cron/output
CRON_OUTPUT_POLL_MS=5
```

**Delivery (v1):** Hermes agent creates jobs with `deliver: local`. `messaging-api` polls `CRON_OUTPUT_DIR` for new run markdown files and commits assistant messages into the linked job conversation when `hermes_job_id` is set. Tooling for each run is reconstructed from Hermes session history in `HERMES_STATE_DB_PATH` (default `/opt/data/state.db`) and persisted on the assistant message as `process.lines` — same shape as live chat turns.

**Webhook (optional):** `POST /internal/cron/deliver` with `Authorization: Bearer <CRON_WEBHOOK_BEARER>` — for future Hermes outbound webhook deliver:

```
webhook:http://messaging-api:3000/internal/cron/deliver?job_id=<HERMES_JOB_ID>
```

Skills: `companion-cron` (create/link/manage, `deliver: local` only), routed from `companion-app`. MCP tools: `create_job_conversation`, `link_job_conversation`.

Design: [`docs/history/implemented/specs/2026-06-18-companion-cron-design.md`](docs/history/implemented/specs/2026-06-18-companion-cron-design.md). Backend plan: [`docs/history/implemented/plans/2026-06-18-companion-cron-backend.md`](docs/history/implemented/plans/2026-06-18-companion-cron-backend.md).

### Push notifications (parked)

OpenAPI v2.5.0 includes `PUT /push/device` and `DELETE /push/device`; backend code ships with `APNS_ENABLED=false` (no-op). **Parked** until Apple Developer (paid) credentials are available. See [`docs/history/parked/README.md`](docs/history/parked/README.md).

### User health vault

The companion app syncs daily HealthKit summaries to a user-scoped vault. Hermes reads health data only through the companion MCP skill — the API does not query HealthKit or finalize days.

**API (v2.4.0):** Health routes under `/data/health/daily-summaries`:

- `POST /data/health/daily-summaries` — upsert by local calendar day (`partial` / `finalized_at`)
- `GET /data/health/daily-summaries/latest` — newest day for the authenticated user
- `GET /data/health/daily-summaries` — HAL paginated history (`limit`, `before`, `after`)

Full contract: [`docs/superpowers/specs/messaging-api.openapi.yaml`](docs/superpowers/specs/messaging-api.openapi.yaml).

Companion MCP tools (same bearer token as location):

- `get_user_health_today` — latest summary by `date`
- `get_user_health_daily` — summary for a specific `YYYY-MM-DD`
- `get_user_health_history` — paginated summaries with HAL `_links`

**v2 metrics** (optional keys on the same daily row): activity (`flights_climbed`), sleep (`sleep_duration`, `sleep_in_bed`, `sleep_deep`, `sleep_rem`, `sleep_core`), heart (`resting_heart_rate`, `heart_rate_avg`, `hrv_sdnn`), workouts (`workout_count`, `workout_minutes`, `workout_types`), body (`weight`, `bmi`, `body_fat_percentage`), nutrition (`dietary_energy`, `protein`, `water`), mindfulness (`mindfulness_minutes`). Design: [`docs/history/implemented/specs/2026-06-18-companion-health-vault-v2-metrics-design.md`](docs/history/implemented/specs/2026-06-18-companion-health-vault-v2-metrics-design.md).

The `companion-user-health` skill in `data/skills/` normalizes vault data for `companion-replies` and `companion-markdown-blocks`. Route health intents via `companion-app`.

iOS owns HealthKit sync, step goals, and day finalization. Client implementation: [`docs/history/implemented/plans/2026-06-17-companion-health-vault-ios.md`](docs/history/implemented/plans/2026-06-17-companion-health-vault-ios.md). v2 metric sync: [`docs/history/implemented/plans/2026-06-18-companion-health-vault-v2-metrics-ios.md`](docs/history/implemented/plans/2026-06-18-companion-health-vault-v2-metrics-ios.md).

## Persistence check

Hermes state is stored on the host at `./data` and mounted into the container at `/opt/data`.

To confirm persistence across restart and recreate:

```bash
docker compose restart
docker compose up -d --force-recreate
ls -la ./data
```

## Backup

Stop the containers first:

```bash
docker compose down
```

Create a backup archive:

```bash
tar -czf hermes-backup-$(date +%Y%m%d-%H%M%S).tgz docker-compose.yml .env data
```

## Restore

Extract the archive in the project directory, then start Hermes again:

```bash
tar -xzf hermes-backup-YYYYMMDD-HHMMSS.tgz
docker compose up -d
```

## Update procedure

1. Update `HERMES_IMAGE` in `.env` to the new pinned tag.
2. Pull the new image.
3. Recreate the services.
4. Check logs.

Commands:

```bash
docker compose pull
docker compose up -d
docker compose logs --tail=100
```

## Troubleshooting

Validate the compose file:

```bash
docker compose config
```

Equivalent:

```bash
make config
```

Check running services:

```bash
docker compose ps
```

Inspect logs:

```bash
docker compose logs --tail=200 hermes-gateway
```

Stop everything:

```bash
docker compose down
```

Remove containers and re-create them while keeping persisted data:

```bash
docker compose down
docker compose up -d
```

## Notes

- The upstream Hermes example still shows split gateway and dashboard containers, but the current `v2026.6.5` image auto-restores gateway services from shared `/opt/data`. Running one container avoids the log-lock collision that appears when two containers share the same Hermes home.
- Dashboard basic auth is required because the container binds `0.0.0.0:9119` for Docker port publish. Credentials live in `.env` as `HERMES_DASHBOARD_BASIC_AUTH_*`.
- Raspberry Pi deployment is intentionally deferred until macOS validation is complete.
