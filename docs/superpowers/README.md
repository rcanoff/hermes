# Superpowers Docs

Active contract and operator reference for this workspace.

## Layout

| Path | Purpose |
|------|---------|
| `specs/messaging-api.openapi.yaml` | Live OpenAPI contract (source of truth for REST) |
| `specs/` | Active design specs for in-flight work |

Shipped design specs and implementation plans live in [`docs/history/implemented/`](../history/implemented/README.md).

Parked (deferred) work lives in [`docs/history/parked/`](../history/parked/README.md).

## Current active work

- **Sync inbox (per user + device)** — OpenAPI v2.6.0 (planned)
  - Backend spec: `specs/2026-06-20-companion-sync-inbox-design.md`
  - Backend plan: `plans/2026-06-20-companion-sync-inbox-backend.md`
  - iOS reference: `specs/2026-06-20-companion-sync-inbox-ios-design.md` (iOS agent writes plan in `assistant-companion`)

## Rules

- Every `messaging-api` contract change must update `specs/messaging-api.openapi.yaml` in the same change set.
- When work ships, move its spec and plan to `docs/history/implemented/`.
- Deferred ideas go to `docs/history/parked/`.