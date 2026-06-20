# Companion Sync Inbox — iOS Client Design Spec (Reference)

**Date:** 2026-06-20  
**Status:** Approved (reference)  
**API version:** v2.6.0  
**Repo:** `assistant-companion` (not this workspace)  
**Backend spec:** `docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md`  
**Backend plan:** `docs/superpowers/plans/2026-06-20-companion-sync-inbox-backend.md` (in `hermes`)

---

## Instructions for the iOS agent

**Write your own implementation plan** — do not implement in `hermes`.

| Item | Location |
|------|----------|
| iOS plan (you create) | `docs/superpowers/plans/2026-06-20-companion-sync-inbox-ios.md` in `assistant-companion` |
| OpenAPI (source of truth) | `hermes/docs/superpowers/specs/messaging-api.openapi.yaml` v2.6.0 |
| Backend behavior | `hermes/docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md` |
| Client integration summary | `hermes/docs/superpowers/plans/2026-06-20-companion-sync-inbox-backend.md` → "Client integration summary" |

### API rules (must match OpenAPI exactly)

1. **`device_id`** — install-scoped UUID in Keychain; survives logout; never use JWT `jti`.
2. **`PUT /devices/me`** — call after every successful login, before any inbox poll. Body: `{ "device_id": "<uuid>" }`. Response: `{ "ok": true }`. Re-register does not reset server cursor.
3. **`GET /sync/inbox?device_id=<uuid>`** — omit `since` in normal polling (server uses stored cursor per user+device).
4. **Response handling:**
   - `changes[].kind: "deleted"` → purge local conversation, messages, thread markers; tombstone id.
   - `changes[].kind: "updated"` → `GET /conversations/{id}/sync`; apply `conversation` snapshot even when `events` is empty.
   - `reset_required: true` → full bootstrap (below); do not treat as error.
   - `next_cursor` — opaque; server persists; client does not need to store locally unless debugging.
   - `has_more` — always `false` in v2.6.0.
5. **`400 invalid_request` on inbox** — device not registered; call `PUT /devices/me` first.
6. **Bootstrap (`reset_required`)** — clear account + all thread markers for current user → `GET /conversations/sync` with `since` omitted (paginate while `has_more`) → HAL-rehydrate open/recent threads → resume inbox polling.
7. **Account switch** — same `device_id`, different server cursor per logged-in user; SwiftData already user-scoped.
8. **Unchanged v2.1 routes** — `GET /conversations/sync`, `GET /conversations/{id}/sync`, HAL lists, session SSE. Inbox replaces account sync as the *dirty detector* on foreground; thread sync still applies deltas.
9. **Guards (carry forward)** — never HAL-hydrate tombstoned ids; handle `messages_rewound`; originating device may use optimistic local state + SSE; other devices rely on inbox + thread sync.

### iOS plan must include

- [ ] Keychain `device_id` lifecycle (generate, persist, survive logout)
- [ ] `DeviceSyncService` or equivalent: register + poll + apply + bootstrap
- [ ] Foreground/login poll triggers; optional post-`reply.done` poll
- [ ] Transactional SwiftData apply per inbox poll
- [ ] Interaction with existing sync markers (account + per-thread)
- [ ] Manual test scenarios from verification checklist below
- [ ] Explicit "do not call `since` on inbox in production" note

### Out of scope (iOS v1)

- Implementing backend routes
- Push-wake inbox
- Offline mutation queue
- Cross-user inbox

---

## Multi-user + multi-device

| Key | Scope |
|-----|-------|
| `device_id` | One per **app install** (Keychain); survives logout |
| Inbox cursor | Per **(logged-in user, device_id)** — server stores cursor |
| SwiftData | Per user (existing); inbox reconciles active account only |

Same phone, user A → logout → user B: same `device_id`, **different** server cursor for B.

---

## API (v2.6.0)

### `PUT /devices/me`

```json
{ "device_id": "<uuid>" }
```

Call after every successful login (before inbox poll).

### `GET /sync/inbox?device_id=<uuid>`

Optional `since` — omit in normal polling (server uses stored cursor).

**Response fields:**

| Field | Action |
|-------|--------|
| `changes[]` | Coalesced work list |
| `changes[].kind: deleted` | Purge local conversation + messages; tombstone id |
| `changes[].kind: updated` | `GET /conversations/{id}/sync` with thread marker |
| `next_cursor` | Opaque; server persists per user+device |
| `reset_required: true` | Run full bootstrap (below) |
| `has_more` | Paginate inbox if true (rare at coalesced layer) |

---

## Client responsibilities

### 1. Stable `device_id`

- Generate UUID on first launch; store in Keychain
- Reuse across logins on this install
- **Do not** use JWT `jti` as consumer id

### 2. Inbox poll triggers

| Event | Poll inbox |
|-------|------------|
| Login success | Yes (after `PUT /devices/me`) |
| App foreground | Yes |
| After SSE `reply` `phase: done` | Optional (thread sync may suffice on sending device) |
| BGAppRefresh | Optional v1 |

### 3. Apply `changes`

Transactional SwiftData per poll:

```
for change in changes:
  if deleted → delete local conv + messages + markers + tombstone
  if updated → threadSync(conversationId)
```

Always apply thread sync `conversation` snapshot even when `events` is empty.

### 4. Bootstrap (`reset_required`)

1. Clear account + all thread markers for **current user**
2. `GET /conversations/sync` with `since` omitted; paginate all pages
3. HAL-rehydrate threads still referenced locally
4. Resume inbox polling (server cursor reset to tip)

### 5. Logout

- Call existing logout flow
- Do **not** wipe `device_id`
- Clear in-memory sync state for user; server cursor remains for next login

### 6. Guards (carry forward from v2.1)

- Never HAL-hydrate tombstoned conversation ids
- Handle `messages_rewound` in thread sync
- Originating device: optimistic local updates OK; other devices rely on inbox

---

## Not in scope (iOS v1)

- Cross-user inbox
- Push-triggered inbox
- Offline delete queue without API

---

## Verification checklist

1. Two devices, same user: delete on A → inbox on B returns `deleted`.
2. Same device, user A then user B: B does not see A’s conversations after sync.
3. Ten sends to conv A → one inbox `updated` for A.
4. Corrupt cursor → `reset_required` → local store matches server after bootstrap.
5. `updated` conv with title-only server change applies via thread snapshot.