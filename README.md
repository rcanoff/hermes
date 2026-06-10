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

The dashboard is enabled inside the same container and bound on the host to `127.0.0.1:${HERMES_DASHBOARD_PORT}`. It is not exposed on the LAN.
Inside the container it binds to `0.0.0.0` so Docker can forward the port, and `HERMES_DASHBOARD_INSECURE=true` is required because this local-only setup does not configure Hermes dashboard OAuth providers.

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

Hermes' gateway already runs in this container. To enable Telegram, you just need to pass the Telegram env vars into it.

DM-first setup:

1. Open Telegram and message `@BotFather`.
2. Send `/newbot` and follow the prompts.
3. Copy the bot token.
4. Message `@userinfobot` to get your numeric Telegram user ID.
5. Add these to `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
TELEGRAM_ALLOWED_USERS=123456789
TELEGRAM_HOME_CHANNEL=123456789
```

6. Recreate Hermes:

```bash
make down
make up
```

7. Verify startup:

```bash
make logs
```

8. Open a DM with your bot and send `/start`.

Notes:

- `TELEGRAM_ALLOWED_USERS` is the main safety gate. Without it, Hermes denies everyone by default.
- For a simple personal DM bot, set `TELEGRAM_HOME_CHANNEL` to your own Telegram user ID.
- You can also set the home channel later from chat with `/set-home`.

Optional group/forum settings:

- `TELEGRAM_GROUP_ALLOWED_USERS` authorizes specific senders in groups/forums only.
- `TELEGRAM_GROUP_ALLOWED_CHATS` authorizes an entire group/forum chat by chat ID.
- `TELEGRAM_HOME_CHANNEL_NAME` is only a friendly label for the configured home channel.

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

## macOS validation steps

1. Copy `.env.example` to `.env` and set your UID/GID values.
2. Start Hermes with `make up`.
3. Check container status with `docker compose ps` or `make ps`.
4. Inspect logs with `docker compose logs --tail=100 hermes-gateway` or `make logs`.
5. Confirm the data directory was created under `./data`.
6. Restart with `docker compose restart` and confirm the container comes back cleanly.
7. Recreate with `docker compose up -d --force-recreate` and confirm data still exists in `./data`.
8. Open `http://127.0.0.1:${HERMES_DASHBOARD_PORT}` to confirm the dashboard is reachable on localhost.

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
