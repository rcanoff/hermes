# Companion Auth — Invite-Based Account Management (Overview)

**Date:** 2026-06-14  
**Status:** Approved  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v1.6.0)

Split specs:

| Spec | Scope | Agent |
|------|-------|-------|
| [`2026-06-14-companion-auth-invites-backend-design.md`](2026-06-14-companion-auth-invites-backend-design.md) | `messaging-api`, MCP tools, Hermes skills, workspace config | This workspace |
| [`2026-06-14-companion-auth-invites-ios-design.md`](2026-06-14-companion-auth-invites-ios-design.md) | iOS companion app — deep links, onboarding, reset UI | Separate machine |

---

## Summary

Replace the bootstrap-operator auth model with **invite-based account provisioning** controlled through Hermes via the companion MCP.

- **Cold start:** zero users; login blocked until first invite
- **Activation:** operator asks Hermes → magic link (VPN-only) → invitee picks username + password
- **Reset:** operator asks Hermes → magic link → invitee sets new password only
- **No self-registration** and no bootstrap env vars

---

## Shared flows

### Create account

Operator → Hermes `create_companion_invite` → share link → iOS `GET /auth/invite/:token` → `POST /auth/activate` → JWT

### Password reset

Operator → Hermes `create_password_reset_invite` → share link → iOS `GET /auth/invite/:token` → `POST /auth/reset-password` → JWT

### Normal login

Unchanged: `POST /auth/login` → JWT

---

## Supersedes

- Bootstrap-user auth in `docs/history/implemented/specs/2026-06-12-hermes-messaging-api-design.md` (Auth Model)
- Authentication section in `docs/history/implemented/specs/2026-06-12-hermes-assistant-companion-design.md`