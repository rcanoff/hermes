# Companion Session Stream — iOS Handoff Plan

> **Repo boundary:** Implement in `assistant-companion` (Swift). This document is a reference for the iOS agent. Backend contract is in `docs/superpowers/specs/messaging-api.openapi.yaml` v2.2.0 and `docs/superpowers/specs/2026-06-18-companion-session-stream-design.md`.

**Goal:** Replace per-send `GET /conversations/{id}/stream` with one persistent `GET /events/stream` per login, routing live events by `conversationId`.

---

## Prerequisites

1. Backend v2.2.0 deployed (JWT `jti`, `GET /events/stream`, session-scoped events).
2. Re-login required for tokens without `jti` (`401 session_required` otherwise).
3. Read OpenAPI `SseToolingEvent`, `SseReplyEvent`, `SseSessionTitleEvent`, `SseSessionRewindEvent`, `SseSessionErrorEvent`.

---

## Architecture

### `StreamService` (app-level, at login)

```
Login  → store JWT → StreamService.connect()   // GET /events/stream
Logout → StreamService.disconnect() → POST /auth/logout
```

- Open stream immediately after successful login (before any send).
- Reconnect with exponential backoff on drop; reuse same JWT until logout.
- Parse SSE `event` + `data` JSON; dispatch by `conversationId` to subscribers.
- Connection stays open after `reply` `phase: "done"` and after `error`.

### Event router

```swift
// Pseudocode
func handleSessionEvent(_ event: SessionStreamEvent) {
    guard let conversationId = event.conversationId else { return }
    chatViewModels[conversationId]?.handle(event)
    conversationListViewModel?.handleTitleIfNeeded(event)
}
```

### Remove per-send stream

Delete parallel `GET /conversations/{id}/stream` open on `POST /messages`. Send flow becomes:

```
POST /conversations/:id/messages     // stream already open
handle tooling / reply / title from StreamService router
on reply.phase == "done" → GET /conversations/:id/sync
```

---

## `ChatViewModel` handler mapping

| SSE `event` | Payload | Action |
|-------------|---------|--------|
| `tooling` | `draft: true` | Append `text` to `reasoningDraft`; `isProcessPhaseActive = true` |
| `tooling` | `kind` + `text` | Append committed line to `processLines`; clear `reasoningDraft` if `kind == "reasoning"` |
| `tooling` | `phase: "complete"` | Flush draft; `isProcessPhaseActive = false`; `isReplyPhaseActive = true` |
| `reply` | `text` | Append to `streamingReply` |
| `reply` | `phase: "done"` | Commit message locally; reset streaming buffers; trigger thread sync |
| `title` | `title` | Update local conversation row (do not reset streaming state) |
| `rewind` | `removedMessageIds` | Remove messages from local store |
| `error` | `code` | Show failure for that run; clear in-flight state; **keep stream open** |

Published state (suggested):

```swift
@Published var processLines: [ProcessLine] = []
@Published var reasoningDraft: String = ""
@Published var streamingReply: String = ""
@Published var isProcessPhaseActive: Bool = false
@Published var isReplyPhaseActive: Bool = false
```

### Instant replies

When Hermes returns no tooling, `reply` tokens may arrive with no preceding `tooling` `phase: "complete"`. Start appending to `streamingReply` on first `reply` token.

---

## Conversation list

- Listen for `title` events on any `conversationId` and update SwiftData.
- Latest message preview and sort order on **non-sending devices** come from `GET /conversations/sync`, not SSE.

---

## Cross-device behavior

| Scenario | Sending device | Other device |
|----------|----------------|--------------|
| Message in flight | Live `tooling` + `reply` via session SSE | No live stream; sync on foreground |
| Title generated | Live `title` via SSE | Title via account sync |
| Edit rerun | Live `rewind` + new run via SSE | Rewound state via thread sync |

---

## Manual test scenarios (from design spec)

1. **No race:** Open `GET /events/stream`, then `POST /messages` with a tool-heavy prompt — tooling lines appear before reply tokens.
2. **Stream persistence:** After `reply` `phase: "done"`, connection remains open; second send works without reconnect.
3. **Title interleave:** First message auto-title — `title` may arrive between `tooling` and `reply`; streaming state must not reset.
4. **Edit rerun:** `PATCH /messages/:id` — `rewind` then replacement `tooling`/`reply` on same session stream.
5. **Run error:** Failed Hermes run emits `error`; stream stays open for next send.
6. **Session isolation:** Two logins (two JWTs) — session B does not receive session A's run events.
7. **Legacy token:** JWT without `jti` → `401 session_required` on `/events/stream`; force re-login.
8. **Cross-device:** Device A sends; Device B sees committed state only after sync, not live SSE.

---

## Migration checklist

- [ ] Add `StreamService` with persistent SSE client
- [ ] Mint/store `jti` awareness (login already returns JWT with `jti`)
- [ ] Route events by `conversationId` + `runId`
- [ ] Map `tooling` / `reply` / `title` lanes (replace `process_token` / `process` / `token` / `done`)
- [ ] On `reply.done`, call thread sync instead of relying on stream close
- [ ] Remove `GET /conversations/{id}/stream` from send path
- [ ] Reconnect/backoff on network drop
- [ ] Verify on device with backend smoke test (see README)

---

## Deferred (backend Task 11)

After iOS ships and verifies: backend removes deprecated `GET /conversations/{id}/stream`. Do not remove until iOS migration is confirmed.