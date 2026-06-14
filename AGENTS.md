# Hermes Workspace

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
  - local design notes and implementation plans for workspace changes

## Expected Changes

Changes in this repo should usually be operational, not product development.

Typical work includes:

- updating Docker Compose settings for the local Hermes deployment
- wiring new integrations into the running Hermes instance
- adding or removing MCP servers
- documenting setup flows for integrations and auth
- adjusting local startup, persistence, and verification workflows

## Working Rules

- Prefer minimal operational changes over broad restructuring.
- Keep secrets out of tracked files; use `.env` for credentials and machine-local values.
- Treat `data/` as runtime state, not hand-maintained source.
- Preserve the documented single-container Hermes model unless there is a clear reason to change it.
- When integration behavior changes, update `README.md` so the workspace remains operable by someone new to it.
- **Companion skills:** every new Hermes skill for the companion app, `messaging-api`, or companion MCP must use the `companion-` prefix (e.g. `companion-user-location`, `companion-account-management`). Place them under `data/skills/`.

## Start Here

When working in this repo, read these first:

1. `README.md`
2. `docker-compose.yml`
3. `Makefile`
4. any relevant files under `docs/superpowers/`

## Non-Goals

This repo is not meant to:

- vendor or modify Hermes application source code
- store long-lived secrets in tracked files
- act as a general-purpose application codebase
