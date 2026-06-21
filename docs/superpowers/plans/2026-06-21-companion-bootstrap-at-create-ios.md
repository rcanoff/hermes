# Companion Bootstrap at Create — iOS Plan

**Date:** 2026-06-21  
**Status:** Planned  
**Repo:** `assistant-companion` (not in this workspace)  
**Backend:** messaging-api (live) — session pre-warm + create-time `bootstrap`  
**Related:** `docs/history/implemented/specs/2026-06-17-companion-app-skills-design.md`, OpenAPI v1.9.0+

---

## Goal

Send `bootstrap` on `POST /conversations` when the user opens a new chat, instead of on the first `POST /messages`. Same text, same once-per-conversation rule.

Backend already supports this: create-time bootstrap wins; first-message `bootstrap` is ignored when `bootstrap_prompt` is already stored. Hermes session pre-warm runs in the background after create.

---

## 1. Find current send path

Locate:

- `CompanionBootstrap.prompt(username:)` (or equivalent constant)
- Message send path where `isFirstMessageInConversation` adds `bootstrap` to the message body (`ChatViewModel` or API client)
- `POST /conversations` call (conversation create / “New chat”)

---

## 2. Move bootstrap to create

**On `POST /conversations`** (when user taps New chat):

```json
{
  "bootstrap": "<CompanionBootstrap.prompt(username: session.username)>"
}
```

**On `POST /conversations/{id}/messages`:** remove `bootstrap` from the request body entirely (all messages, including the first).

---

## 3. Keep existing rules

- Do **not** show bootstrap in the chat UI
- Do **not** send bootstrap on edit/resend
- Do **not** send bootstrap on second+ messages
- Bump the constant’s version comment when block capabilities change (same as today)

---

## 4. Timing / UX

Create conversation **before** the user can send (same as today: empty thread → first send). Ideal flow:

1. User taps “New chat” → `POST /conversations` with `bootstrap`
2. Store returned `conversation.id` locally
3. User types and sends → `POST /messages` with `{ "text": "..." }` only

If create is currently lazy (create on first send), split into two calls: create with bootstrap, then message — still better than bundling bootstrap into the message POST.

---

## 5. Tests / verification

| Case | Expect |
|------|--------|
| New chat, first send | Create request includes `bootstrap`; first message request does **not** |
| Second message | No `bootstrap` on create or message |
| Hermes tooling | First reply still shows `skill_view` → `companion-app` |
| Old threads | Unchanged; no backfill |

Manual: new conversation → first reply should feel snappier (Hermes session pre-warmed server-side after create).

---

## 6. No API contract changes

OpenAPI v1.9.0+ already documents optional `bootstrap` on `POST /conversations`. No new fields or client decoding changes — bootstrap is never returned in GET responses.

---

## 7. Suggested PR scope

**Typical files:**

- Bootstrap constant (text unchanged)
- Conversation create API client / `ConversationListViewModel`
- Message send path — delete `bootstrap` branch
- Unit test: create encodes `bootstrap`; first message does not

**Out of scope:** block rendering, sync, session SSE, title handling.

---

## Canonical bootstrap text (unchanged)

```text
You are replying on the Companion App (assistant-companion iOS), not a generic API client.
Before composing your reply, you MUST call skill_view(name='companion-app') and follow it.
The authenticated companion user for this conversation is "{username}".
```

`{username}` — filled client-side from JWT / session (same value API derives from auth).

---

## Deploy order

1. Backend already deployed (this repo)
2. Ship iOS change — safe; old app behavior (bootstrap on first message) still works as fallback