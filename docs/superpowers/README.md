# Superpowers Docs

Active design notes and implementation plans for this workspace.

## Layout

| Path | Purpose |
|------|---------|
| `specs/` | Active design specs and the live OpenAPI contract |
| `plans/` | Active implementation plans |

Older specs and plans (dated before today’s active work) are archived in [`docs/history/`](../history/README.md).

## Current active work

- **Companion app skills & iOS bootstrap** (OpenAPI v1.9.0)
  - Design: `specs/2026-06-17-companion-app-skills-design.md`
  - Backend plan: `plans/2026-06-17-companion-app-skills-backend.md`
  - iOS plan (reference): `plans/2026-06-17-companion-app-skills-ios.md`
  - OpenAPI: `specs/messaging-api.openapi.yaml`

## Rules

- Every `messaging-api` contract change must update `specs/messaging-api.openapi.yaml` in the same change set.
- When work ships, move its spec and plan to `docs/history/` and add new active docs here if needed.