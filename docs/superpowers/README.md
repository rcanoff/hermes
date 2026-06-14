# Superpowers Docs

Design notes and implementation plans for this workspace.

## Layout

| Path | Purpose |
|------|---------|
| `specs/` | Active design specs (in progress or planned) |
| `plans/` | Active implementation plans |
| `implemented/specs/` | Shipped design specs |
| `implemented/plans/` | Completed implementation plans |

When work ships, move its spec and plan from `specs/` / `plans/` into `implemented/` and set **Status: Implemented** on the design doc.

## Current active work

- Companion auth — invite-based account management
  - Overview: `specs/2026-06-14-companion-auth-invites-design.md`
  - Backend: `specs/2026-06-14-companion-auth-invites-backend-design.md`
  - iOS: `specs/2026-06-14-companion-auth-invites-ios-design.md`
  - OpenAPI v1.6.0: `specs/messaging-api.openapi.yaml`
- Companion user-data vault + MCP (location redesign)
  - Design: `specs/2026-06-13-companion-user-data-vault-design.md`
  - OpenAPI v1.5.0: `specs/messaging-api.openapi.yaml`
  - Backend plan: `plans/2026-06-13-companion-user-data-vault-backend.md`
  - iOS plan: `plans/2026-06-13-companion-user-data-vault-ios.md`

## Implemented (2026-06-13)

- `messaging-api` — Hermes mobile channel (auth, conversations, messages, SSE, process stream, title generation, message edit)
- `assistant-companion` iOS app — implemented on a separate machine; see `implemented/plans/2026-06-12-assistant-companion-plan.md`
- Apple Calendar CalDAV MCP, Todoist MCP, Raspberry Pi Ansible deploy, Obsidian trip records vault

See `implemented/README.md` for the full index.