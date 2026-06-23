# Hermes Workspace

## Grok agent (this project)

This workspace is implemented by **Grok** (headless), invoked by the orchestrator through the **`grok-hermes` MCP server** (`grok-hermes__grok` / `grok-hermes__grok-reply`).

When Grok runs here it must:

- Treat this file as the source of truth for backend conventions, OpenAPI rules, and operator workflows.
- Keep the working directory at the Hermes repo root (`hermes/`).
- Update `docs/superpowers/specs/messaging-api.openapi.yaml` in the same change set as any contract change.
- Run verification per the rules below before reporting completion.
- Return a concise summary: what changed, tests run, pass/fail, new OpenAPI version (if bumped), and any follow-ups for the orchestrator.

The orchestrator plans in `docs/` at the workspace root and delegates implementation here. Do not implement iOS/SwiftUI — hand off to Codex via the orchestrator when client work is needed.

## Purpose

This directory is an operations workspace for a local Hermes Agent deployment.

It is not the Hermes source repo. It exists to:

- stand up Hermes with Docker Compose
- manage local Hermes configuration and persistent state
- add and maintain integrations such as model providers, messaging platforms, and hosted services
- connect external MCP servers
- install or configure Hermes skills, tools, and related operator workflows
- document setup, maintenance, and troubleshooting steps

## What Lives Here

- `docker-compose.yml`
  - the local Hermes container definition
- `Makefile`
  - convenience commands for starting, stopping, and inspecting the local deployment
- `.env.example`
  - tracked template for local environment variables
- `.env`
  - local secrets and machine-specific settings; do not commit
- `README.md`
  - operator-facing setup and maintenance instructions
- `data/`
  - persisted Hermes runtime state mounted into the container at `/opt/data`
- `docs/superpowers/`
  - active design specs, implementation plans, and the live OpenAPI contract
- `docs/history/`
  - archived specs and plans (older than current active work)

## Expected Changes

Changes in this repo should usually be operational, not product development.

Typical work includes:

- updating Docker Compose settings for the local Hermes deployment
- wiring new integrations into the running Hermes instance
- adding or removing MCP servers
- documenting setup flows for integrations and auth
- adjusting local startup, persistence, and verification workflows

## Working Rules

### Agent replies

- Keep answers **very short and precise** — no long specs, walls of text, or scroll-heavy dumps for simple questions.
- Include only what's needed to answer or act; expand only when the user asks.

### Repository scope (hard rules)

- **Backend only in this repo.** Implement `messaging-api`, companion MCP, `data/skills/`, Docker/Makefile, and operator docs here. Do **not** implement iOS/SwiftUI or other frontend client code in this workspace.
- **Specs cover both sides.** Design specs and plans in `docs/superpowers/` must document backend **and** frontend/client impact when the API contract changes, even though FE is built elsewhere (`assistant-companion`).
- **OpenAPI is mandatory.** Every `messaging-api` contract change (routes, query params, request/response shapes, MCP tool payloads that mirror REST) must update `docs/superpowers/specs/messaging-api.openapi.yaml` in the same change set. OpenAPI is the source of truth for REST; specs reference it by version.
- **OpenAPI version bumps are for contract changes only.** Bump `info.version` when clients must react — new or removed routes, query params, request/response fields, status codes, or enums. Internal server behavior (e.g. syncing `data/cron/jobs.json`, logging, persistence side effects) with unchanged HTTP contract does **not** warrant a version bump; document it in the relevant operation description if useful.

- Prefer minimal operational changes over broad restructuring.
- Keep secrets out of tracked files; use `.env` for credentials and machine-local values.
- Treat `data/` as runtime state, not hand-maintained source.
- Preserve the documented single-container Hermes model unless there is a clear reason to change it.
- When integration behavior changes, update `README.md` so the workspace remains operable by someone new to it.
- **Companion skills:** every new Hermes skill for the companion app, `messaging-api`, or companion MCP must use the `companion-` prefix (e.g. `companion-user-location`, `companion-account-management`). Place them under `data/skills/`.
- **Companion cron prompts:** cron runs are stateless — only `jobs.json` prompt text fires at schedule time. Reminders must be useful and self-contained: resolve deictic references, carry forward links/prices/map blocks from the source conversation so the user can act without re-researching. `messaging-api` synthesizes prompts from recent chat (gpt-5.4). Use `deliver: local`; never delivery wording (`send`, `notify`).
- **List endpoint pagination:** every `messaging-api` endpoint (REST or MCP tool) that returns a collection must use HAL-style pagination by default. Spec: `docs/history/specs/2026-06-15-list-pagination-hal-design.md`. Rules in brief:
  - Response envelope: `{ "<collection>": [...], "_links": { "self": { "href": "..." }, "next"?: ..., "prev"?: ... } }`
  - Query / tool args: `limit` (default 20, max 100), `before` and `after` (mutually exclusive UUID anchors)
  - No total counts; omit `next` / `prev` when no further page exists (do not return `null`)
  - `href` values are relative path + query (e.g. `/conversations?limit=20&before=<uuid>`)
  - MCP list tools mirror the same envelope and anchor semantics as their REST equivalent
  - Single-item routes (`GET …/latest`, `GET …/:id`) and small bounded operator snapshots (e.g. `list_companion_accounts`) are exempt until pagination is needed

## Start Here

When working in this repo, read these first:

1. `README.md`
2. `docker-compose.yml`
3. `Makefile`
4. any relevant files under `docs/superpowers/` (archived context in `docs/history/`)

## Non-Goals

This repo is not meant to:

- vendor or modify Hermes application source code
- implement the iOS companion app (`assistant-companion`) — FE plans here are reference docs only
- store long-lived secrets in tracked files
- act as a general-purpose application codebase
