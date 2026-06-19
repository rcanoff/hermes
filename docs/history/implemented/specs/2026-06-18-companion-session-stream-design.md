# Companion Session Stream — Design Spec

**Date:** 2026-06-18  
**Status:** Approved (brainstorm)  
**API version:** v2.2.0 (OpenAPI)  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml`  
**Consumer:** `assistant-companion` (iOS)  
**Related specs:** `docs/superpowers/specs/2026-06-17-companion-chat-local-sync-backend-design.md`, `docs/history/implemented/specs/2026-06-13-assistant-process-stream-design.md`  
**Supersedes (for live UX):** per-conversation `GET /conversations/{id}/stream` — deprecated after iOS migrates

---

## Goal

Replace per-conversation, per-run SSE with **one persistent stream per auth session** so the companion app:

1. Never misses early tooling events (eliminates the late-subscriber race)
2. Has a simple connection lifecycle (connect at login, reconnect on drop, close at logout)
3. Routes live tooling, reply, and title updates to the device that sent the message
4. Leaves cross-device reconciliation to the existing sync feeds

---

## Decisions

| Topic | Choice |
|-------|--------|
| Stream scope | One SSE per **auth session** (one login on one device) |
| Multi-device | Two devices logged in = two JWTs = two independent streams |
| Event routing | Live events go **only** to the session that started the run |
| Cross-device live | **Not supported** — other devices reconcile via sync |
| Client lanes | Three UX lanes: **tooling**, **reply**, **title** (+ structural `rewind`, `error`) |
| Stream lifecycle | Persistent across runs; does **not** close on `reply.done` or run `error` |
| Durable truth | Sync feeds + HAL history unchanged; SSE is live paint only |
| Old route | `GET /conversations/{id}/stream` deprecated; removed after iOS ships |

---

## Problem with the current design

Today the client opens `GET /conversations/{id}/stream` per send, in parallel with `POST /messages`. `StreamHub` is keyed by `conversationId` and has **no replay** for `process` / `process_token`. If the stream attaches after early tool events, tooling only appears after `GET /messages` reload — the primary iOS bug documented in `docs/superpowers/plans/2026-06-17-companion-live-streaming-ios-debug.md`.

A session-persistent stream subscribed **before** any send removes this race by construction.

---

## Session model

### Identity

Each successful login (`POST /auth/login`, `POST /auth/activate`, `POST /auth/reset-password`) mints a JWT with a new claim:

```json
{
  "sub": "<userId>",
  "username": "<username>",
  "jti": "<sessionUuid>"
}
```

- `jti` is the **session ID** — one per login, stable for the life of that token
- Logout (`POST /auth/logout`) denies the token via the existing `sessions` denylist
- Password change invalidates older tokens (existing `iat` vs `password_changed_at` check)

The auth plugin exposes `request.sessionId` from `jti`.

### Stream binding

```
GET /events/stream
Authorization: Bearer <jwt>
```

The route subscribes the connection to `StreamHub` under `sessionId` (`jti`). One active SSE connection per session is expected; a second connection from the same session may replace or reject the first (implementation choice: **replace** — unsubscribe previous listener).

### Run attribution

`message_runs` gains `origin_session_id TEXT NOT NULL`. `createRun` stores the `sessionId` from the authenticated request that triggered the run (`POST /messages` or `PATCH /messages/:messageId`).

`run-executor` publishes all run events to `hub.publish(originSessionId, event)` instead of `conversationId`.

---

## Architecture

```mermaid
sequenceDiagram
    participant iOS as assistant-companion
    participant API as messaging-api
    participant H as Hermes

    iOS->>API: POST /auth/login → JWT (jti=session_A)
    iOS->>API: GET /events/stream (persistent)
    Note over iOS,API: Stream stays open for session_A

    iOS->>API: POST /conversations/:id/messages
    Note over API: createRun(origin_session_id=session_A)
    API->>H: stream chat completion
    H-->>API: tool progress, deltas
    API-->>iOS: tooling { conversationId, runId, ... }
    API-->>iOS: reply { conversationId, runId, text }
    API-->>iOS: title { conversationId, title }
    API-->>iOS: reply { conversationId, runId, phase: done, messageId }

    Note over iOS: Other device (session_B) receives nothing live;<br/>sync on foreground delivers committed state.
```

### Three transport roles

| Layer | Route | Purpose |
|-------|-------|---------|
| **Session SSE** | `GET /events/stream` | Live in-flight tooling, reply tokens, title on sending device |
| **Sync** | `GET /conversations/sync`, `GET /conversations/{id}/sync` | Durable deltas after relaunch, background, other devices |
| **HAL history** | `GET /conversations`, `GET /conversations/{id}/messages` | Initial hydration + older-message pagination |

---

## SSE contract

**Endpoint:** `GET /events/stream`  
**Auth:** Bearer JWT (same as other routes)  
**Content-Type:** `text/event-stream`  
**Lifecycle:** Connection stays open until client disconnects or token is denied. Individual run completion does **not** close the stream.

**Keepalive:** Server sends SSE comment line `: ping` at least every 30 seconds.

### Event types

Five SSE `event` names. The iOS app groups them into three UX lanes.

#### `tooling` — process block (lane 1)

| Payload shape | When | Client action |
|---------------|------|---------------|
| `{ conversationId, runId, kind: "reasoning"\|"tool", text }` | Completed reasoning line, tool start, or `Done:` completion | Append new committed line to process block |
| `{ conversationId, runId, kind: "reasoning", text, draft: true }` | Reasoning delta while Hermes thinks | Append to in-flight reasoning draft |
| `{ conversationId, runId, phase: "complete" }` | First reply token imminent | End process phase; show reply bubble |

`kind` values match persisted `ProcessLine` (`reasoning` | `tool`).

#### `reply` — assistant answer (lane 2)

| Payload shape | When | Client action |
|---------------|------|---------------|
| `{ conversationId, runId, text }` | Answer token from Hermes | Append to streaming reply |
| `{ conversationId, runId, phase: "done", messageId }` | Assistant message persisted | Commit reply; clear streaming buffers; trigger thread sync |

**Instant replies** (no tools, no reasoning): no `tooling` events; `reply` tokens stream immediately with no `tooling` `phase: "complete"`.

#### `title` — conversation title (lane 3)

| Payload shape | When | Client action |
|---------------|------|---------------|
| `{ conversationId, title }` | Auto-generated title saved (first message) | Update conversation title in local store |

May interleave with `tooling` / `reply` during the first message. Must not reset streaming state.

#### `rewind` — message edit rerun (structural)

| Payload shape | When | Client action |
|---------------|------|---------------|
| `{ conversationId, runId, removedMessageIds }` | Before replacement run starts | Remove messages from local state |

Emitted only to the session that initiated the edit.

#### `error` — run failure (structural)

| Payload shape | When | Client action |
|---------------|------|---------------|
| `{ conversationId, runId, code }` | Run failed | Show failure for that conversation; clear in-flight streaming state for that run |

**Does not close the SSE connection.** The client keeps the stream open for the next send.

### Ordering rules

1. **Tool-heavy turn:** `tooling` (start) → silence during execution → `tooling` (`Done:`) → `tooling` `{ phase: "complete" }` → `reply` tokens → `reply` `{ phase: "done" }`
2. **`tooling` with `draft: true`** may arrive many times before the matching committed `tooling` reasoning line
3. **`title`** may arrive anywhere during the first message of a conversation
4. **`rewind`** precedes the replacement run's `tooling` / `reply` sequence
5. Multiple tool rounds in one turn accumulate in **one** process block before `tooling` `{ phase: "complete" }`

### Example sequence (tool-heavy)

```
event: tooling
data: {"conversationId":"c1","runId":"r1","kind":"tool","text":"Searching the web: Lisbon weather"}

event: tooling
data: {"conversationId":"c1","runId":"r1","kind":"tool","text":"Done: Searching the web: Lisbon weather"}

event: tooling
data: {"conversationId":"c1","runId":"r1","phase":"complete"}

event: reply
data: {"conversationId":"c1","runId":"r1","text":"It is sunny"}

event: title
data: {"conversationId":"c1","title":"Lisbon weather"}

event: reply
data: {"conversationId":"c1","runId":"r1","phase":"done","messageId":"m1"}
```

### Mapping from v1.8.0 per-conversation events

| Old event | New event | Notes |
|-----------|-----------|-------|
| `process_token` | `tooling` | Add `draft: true`, `conversationId`, `runId` |
| `process` | `tooling` | Add `conversationId`, `runId` |
| `process_complete` | `tooling` | `{ phase: "complete" }` |
| `token` | `reply` | Add `conversationId`, `runId` |
| `done` | `reply` | `{ phase: "done", messageId }` |
| `title` | `title` | Add `conversationId` |
| `rewind` | `rewind` | Add `conversationId`, `runId` |
| `error` | `error` | Add `conversationId`, `runId`; stream stays open |

---

## iOS consumer model

### App-level `StreamService`

```
Login  → store JWT → StreamService.connect()   // GET /events/stream
Logout → StreamService.disconnect() → POST /auth/logout
```

- Reconnect with exponential backoff on network drop (same JWT)
- Parse events and dispatch by `conversationId` to interested view models

### Per-conversation `ChatViewModel`

Subscribes to events where `conversationId` matches:

```swift
@Published var processLines: [ProcessLine] = []
@Published var reasoningDraft: String = ""
@Published var streamingReply: String = ""
@Published var isProcessPhaseActive: Bool = false
@Published var isReplyPhaseActive: Bool = false
```

| SSE event | Handler |
|-----------|---------|
| `tooling` + `draft: true` | Append to `reasoningDraft`; set `isProcessPhaseActive` |
| `tooling` line | Append to `processLines`; clear `reasoningDraft` if `kind == "reasoning"` |
| `tooling` + `phase: "complete"` | Flush draft; `isProcessPhaseActive = false`; `isReplyPhaseActive = true` |
| `reply` token | Append to `streamingReply` |
| `reply` + `phase: "done"` | Commit message; reset streaming state; call thread sync |
| `title` | Update local conversation row |
| `rewind` | Remove `removedMessageIds` from local state |
| `error` | Show error; clear in-flight state for that run |

### Send flow (simplified)

```
POST /conversations/:id/messages     // stream already open — no parallel stream open
handle tooling / reply / title from StreamService router
on reply.done → GET /conversations/:id/sync
```

### Conversation list

Listens for `title` events on any `conversationId` and updates SwiftData. Other cross-conversation changes (latest message preview, sort order) arrive via `GET /conversations/sync` — not SSE on non-sending devices.

### Cross-device behavior

| Scenario | Sending device | Other device |
|----------|----------------|--------------|
| New message in flight | Live `tooling` + `reply` via SSE | No live stream; sees committed result after sync |
| Title generated | Live `title` via SSE | Title via `GET /conversations/sync` |
| Message edit rerun | Live `rewind` + new run via SSE | Rewound state via `GET /conversations/{id}/sync` |

---

## Backend changes

### New / changed units

| Unit | Change |
|------|--------|
| `src/plugins/auth.ts` | Extract `request.sessionId` from JWT `jti` |
| `src/routes/auth.ts` | Include `jti: randomUUID()` in all `jwtSign` calls |
| `src/db/schema.ts` | `message_runs.origin_session_id TEXT NOT NULL` |
| `src/db/repos/runs.ts` | `createRun(db, conversationId, userMessageId, originSessionId)` |
| `src/streams/hub.ts` | Key listeners by `sessionId`; event payloads include `conversationId` + `runId` |
| `src/routes/events.ts` (new) | `GET /events/stream` — persistent SSE |
| `src/services/run-executor.ts` | Publish to `originSessionId`; emit new event names |
| `src/services/title-generator.ts` | Publish `title` to originating session |
| `src/routes/messages.ts` | Pass `sessionId` into `createRun` / `executeAssistantRun`; remove or deprecate `GET /conversations/:id/stream` |

### `StreamHub` shape

```typescript
type SessionStreamEvent =
  | { event: 'tooling'; data: ToolingEvent }
  | { event: 'reply'; data: ReplyEvent }
  | { event: 'title'; data: { conversationId: string; title: string } }
  | { event: 'rewind'; data: { conversationId: string; runId: string; removedMessageIds: string[] } }
  | { event: 'error'; data: { conversationId: string; runId: string; code: string } }

class StreamHub {
  subscribe(sessionId: string, listener: StreamListener): () => void
  publish(sessionId: string, event: SessionStreamEvent): void
  unsubscribeSession(sessionId: string): void  // optional: logout cleanup
}
```

Remove conversation-keyed `setPendingRewind` — with a persistent session stream, the listener is already connected before `POST` / `PATCH`. If a race remains, buffer `rewind` keyed by `(sessionId, conversationId)` for the first event after subscribe only.

### Error codes (`error.code`)

| Code | Meaning |
|------|---------|
| `hermes_stream_failed` | Hermes stream broke mid-run |
| `run_persist_failed` | Could not save assistant message |

(`no_active_run` is removed — no wait window on session stream.)

### Persistence

Unchanged:

- `message_process` table and `process.lines` on `GET /messages`
- Process lines accumulated in `run-executor` the same way; only the SSE fan-out changes

---

## Migration

| Phase | Backend | iOS |
|-------|---------|-----|
| 1 | Ship `GET /events/stream` + `jti` claim; keep old per-conversation stream working | — |
| 2 | — | Connect at login; route events; stop opening per-conversation stream |
| 3 | Mark `GET /conversations/{id}/stream` deprecated in OpenAPI | Verify on device |
| 4 | Remove old route and conversation-keyed hub | — |

Backend-only deploy in phase 1 is safe (additive). Old iOS continues using per-conversation stream.

---

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Instant reply | `reply` tokens only; no `tooling` phase |
| Client disconnect mid-run | Backend continues; persist on `reply.done`; client reconciles via sync + history |
| Send from device A, view same chat on device B | B sees committed result after sync; no live tokens on B |
| Logout during active run | Run completes server-side; SSE closes; denied token cannot reconnect; sync on next login |
| Second `GET /events/stream` same session | Replace first connection (recommended) |
| `run_conflict` | Unchanged — 409 on `POST` / `PATCH` while conversation has active run |
| Title arrives after `reply.done` | Possible for slow title job; saved to DB regardless; SSE may miss if run events already finished — client refetches via conversation sync |

---

## OpenAPI (v2.2.0)

Add to `messaging-api.openapi.yaml`:

- Schemas: `SseToolingEvent`, `SseReplyEvent`, `SseSessionTitleEvent`, `SseSessionRewindEvent`, `SseSessionErrorEvent`
- Path: `GET /events/stream` with `x-sse-events` for the five event types
- Deprecation notice on `GET /conversations/{id}/stream`
- Document `jti` session claim in auth description
- Version bump `2.1.0` → `2.2.0` with changelog entry pointing to this spec

---

## Testing

**Unit**

- `StreamHub` session subscribe / publish / replace-on-reconnect
- `run-executor` publishes to `originSessionId` with correct event mapping
- Auth plugin rejects tokens without `jti` after migration cutoff (or treat missing `jti` as legacy-only path)

**Integration**

- Login → `GET /events/stream` → `POST /messages` → receive full `tooling` → `reply` sequence with `conversationId` + `runId`
- Two sessions same user: events from session A's POST do not appear on session B's stream
- `error` on failed run does not close stream; subsequent POST still streams
- Logout closes stream; denied token returns 401 on reconnect
- `rewind` on edit rerun reaches the editing session only

**Manual**

- Tool-heavy prompt on device; confirm tooling appears before reply tokens
- Same prompt on second device: no live stream; committed message after sync
- Background app on sending device; foreground sync reconciles if SSE dropped

---

## Non-goals

- Fan-out live SSE to all sessions for a user (cross-device live mirroring)
- Replacing sync feeds or HAL pagination
- Persisting partial reply tokens in durable history
- Mid-run SSE replay buffer (sync + history remain the recovery path)
- iOS SwiftUI implementation in this workspace (reference only)

---

## Client impact

**Will this break the existing iOS app?** Not until it migrates.

| Area | Impact |
|------|--------|
| Auth | New `jti` in JWT — additive; old tokens without `jti` keep working until expiry |
| Send flow | Must open `GET /events/stream` at login instead of per-send `GET /conversations/:id/stream` |
| SSE handler | New event names and payloads with `conversationId` / `runId` |
| Other devices | No change to sync-based reconciliation |

Backend phase 1 is additive. Rich session-stream UX requires a companion app update.