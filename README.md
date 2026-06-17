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
Inside the container it binds to `0.0.0.0` so Docker can forward the port, and `HERMES_DASHBOARD_INSECURE=true` is required because this setup does not configure Hermes dashboard OAuth providers.

Security note:

- anyone who can reach `http://<host-ip>:${HERMES_DASHBOARD_PORT}` can access the dashboard
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

## Firecrawl setup

Hermes uses Firecrawl by default for web search and web extraction when `FIRECRAWL_API_KEY` is set.

1. Get an API key from `https://firecrawl.dev`.
2. Add it to `.env`:

```bash
FIRECRAWL_API_KEY=fc-your-key-here
```

3. Recreate Hermes so the container gets the new env var:

```bash
make down
make up
```

4. Verify with:

```bash
make logs
```

Optional:

- `FIRECRAWL_API_URL=https://api.firecrawl.dev` is the default hosted Firecrawl API
- `FIRECRAWL_API_URL=http://localhost:3002` for a self-hosted Firecrawl instance
- `FIRECRAWL_BROWSER_TTL=600` to keep Firecrawl browser sessions alive longer

Notes:

- For web search/extract, Firecrawl is Hermes' default backend when configured.
- For browser automation, use Hermes' tool setup to select Firecrawl as the browser provider if you want cloud browser sessions through Firecrawl.

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

## Todoist MCP setup

Hermes can connect directly to Todoist's official hosted MCP server over HTTP with OAuth.

Add the server from inside the running container:

```bash
docker exec -it hermes hermes mcp add todoist --url https://ai.todoist.net/mcp --auth oauth
```

Then complete authentication:

```bash
docker exec -it hermes hermes mcp login todoist
```

Notes:

- Hermes stores Todoist OAuth tokens in its MCP token store under the persistent Hermes home directory, so the connection survives restarts.
- If the browser callback cannot reach Hermes directly, complete the OAuth flow using Hermes' paste-back redirect flow.
- Todoist's tools load through Hermes as an MCP toolset for the configured server.

Verification:

```bash
docker exec -it hermes hermes mcp list
docker exec -it hermes hermes mcp test todoist
```

If you need to re-authenticate later:

```bash
docker exec -it hermes hermes mcp login todoist
```

If you need to remove the integration:

```bash
docker exec -it hermes hermes mcp remove todoist
```

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

Hermes keeps a centralized memory of personal records — currently trips — in an
Obsidian-compatible markdown vault at `data/vault/` (mounted in the container at
`/opt/data/vault`, resolved by skills via `OBSIDIAN_VAULT_PATH`).

One note per trip lives in `Trips/` (named `YYYY-MM Origin-Destination.md`) and holds
canonical booking facts: trip span, flight numbers, confirmation codes, lodging and
car rental references. Enriched detail (terminal, address, when to leave) lives on
the linked calendar event, and each event's UID is written back onto the note's fact
line to prevent duplicates.

The workflow is defined by the `productivity/trip-records` skill in `data/skills/`,
which composes the existing `note-taking/obsidian` and
`productivity/travel-bookings-to-calendar` skills. Design spec:
`docs/history/implemented/specs/2026-06-12-obsidian-trip-records-vault-design.md`.

The vault is plain markdown — open the folder in Obsidian later for browsing on
Mac/iPhone (sync is deferred; the vault is local-only on the Pi for now). It is part
of `data/`, so the existing backup procedure covers it.

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

### Assistant process stream

The messaging API streams Hermes reasoning and tool activity over SSE while a reply is in progress, then persists it on the assistant message for scroll-back.

Live stream events (in order):

- `process_token` — reasoning text deltas while Hermes is thinking (`{"kind":"reasoning","text":"..."}`)
- `process` — completed reasoning line, tool start label, or `Done:` tool completion
- `process_complete` — signals the process section is finished (`{}`)
- `token` — answer text chunks
- `done` — final assistant message id

After the run completes, `GET /conversations/:id/messages` includes an optional `process` field on assistant messages:

```json
{
  "role": "assistant",
  "content": "It is sunny in Lisbon.",
  "process": {
    "lines": [
      { "kind": "reasoning", "text": "Looking up weather…" },
      { "kind": "tool", "text": "Running lookup weather" }
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

The `companion-user-location` skill in `data/skills/` calls `get_user_location` and `get_location_history` on this MCP server.

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
- `HERMES_DASHBOARD_INSECURE=true` is acceptable here because Docker publishes the dashboard only on `127.0.0.1`. Do not reuse that setting unchanged for a non-localhost deployment.
- Raspberry Pi deployment is intentionally deferred until macOS validation is complete.
