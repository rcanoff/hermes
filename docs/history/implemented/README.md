# Implemented Specs & Plans

Archived design docs and implementation plans for shipped workspace features.

## Messaging channel

| Spec | Plan |
|------|------|
| `specs/2026-06-12-hermes-messaging-api-design.md` | `plans/2026-06-12-messaging-api-plan.md` |
| `specs/2026-06-12-hermes-assistant-companion-design.md` | `plans/2026-06-12-assistant-companion-plan.md` |
| `specs/2026-06-13-conversation-title-generation-design.md` | `plans/2026-06-13-conversation-title-generation.md` |
| `specs/2026-06-13-message-edit-design.md` | `plans/2026-06-13-message-edit.md` |
| `specs/2026-06-13-assistant-process-stream-design.md` | `plans/2026-06-13-assistant-process-stream.md` |
| — | `plans/2026-06-13-assistant-companion-backend-parity.md` |
| `specs/messaging-api.openapi.yaml` (v1.4.0) | — |

The iOS companion app is implemented on a separate machine. Backend parity features (process stream, message edit, title generation) are live in `messaging-api`.

## Companion channel (v1.9 – v2.4)

| Feature | Spec | Plan |
|---------|------|------|
| App skills & iOS bootstrap (v1.9) | `specs/2026-06-17-companion-app-skills-design.md` | `plans/2026-06-17-companion-app-skills-backend.md`, `plans/2026-06-17-companion-app-skills-ios.md` |
| Local-first chat sync (v2.1) | `specs/2026-06-17-companion-chat-local-sync-backend-design.md` | `plans/2026-06-17-companion-chat-local-sync-backend.md` |
| Health vault (v2.0) | `specs/2026-06-17-companion-health-vault-design.md`, `specs/2026-06-17-companion-health-vault-backend-design.md`, `specs/2026-06-17-companion-health-vault-ios-design.md` | `plans/2026-06-17-companion-health-vault-backend.md`, `plans/2026-06-17-companion-health-vault-ios.md` |
| Health vault v2 metrics (v2.4) | `specs/2026-06-18-companion-health-vault-v2-metrics-design.md` | `plans/2026-06-18-companion-health-vault-v2-metrics-backend.md`, `plans/2026-06-18-companion-health-vault-v2-metrics-ios.md` |
| Session stream (v2.2) | `specs/2026-06-18-companion-session-stream-design.md` | `plans/2026-06-18-companion-session-stream-backend.md`, `plans/2026-06-18-companion-session-stream-ios.md` |
| Cron / job conversations (v2.3) | `specs/2026-06-18-companion-cron-design.md`, `specs/2026-06-18-companion-cron-ios-design.md` | `plans/2026-06-18-companion-cron-backend.md`, `plans/2026-06-18-companion-cron-ios.md` |
| Live streaming debug (iOS) | — | `plans/2026-06-17-companion-live-streaming-ios-debug.md` |

Live OpenAPI: [`docs/superpowers/specs/messaging-api.openapi.yaml`](../../superpowers/specs/messaging-api.openapi.yaml) (v2.5.0).

## Integrations & ops

| Spec | Plan |
|------|------|
| `specs/2026-06-10-apple-calendar-caldav-mcp-design.md` | `plans/2026-06-10-apple-calendar-caldav-mcp.md` |
| `specs/2026-06-10-todoist-mcp-integration-design.md` | `plans/2026-06-10-todoist-mcp-integration.md` |
| `specs/2026-06-10-raspi-ansible-deploy-design.md` | `plans/2026-06-10-raspi-ansible-deploy.md` |
| `specs/2026-06-12-obsidian-trip-records-vault-design.md` | `plans/2026-06-12-trip-records-vault.md` |

## Ideas (not implemented)

- `specs/2026-06-11-cross-platform-messaging-session-routing-idea.md`
- `specs/2026-06-12-obsidian-trip-records-vault-idea.md` (superseded by design spec)