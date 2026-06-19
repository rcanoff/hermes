# Companion Chat Local-First Sync - Backend Proposal

**Date:** 2026-06-17  
**Status:** Approved — backend review complete  
**API version:** v2.1.0 (OpenAPI)  
**Implementation plan:** `docs/superpowers/plans/2026-06-17-companion-chat-local-sync-backend.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml`  
**Consumer:** `assistant-companion` (iOS 26, SwiftData local store)  
**Related specs:** `docs/superpowers/specs/2026-06-15-list-pagination-hal-design.md`, `docs/superpowers/specs/2026-06-17-companion-app-skills-design.md`

---

## Goal

Enable the iOS app to open chat data from a local SwiftData store immediately, then reconcile only newer or changed server state in the background.

This proposal keeps Hermes as the source of truth for all committed chat history while allowing the app to keep local drafts and cached history on device.

---

## Decisions made in this proposal

These are the product and architecture decisions already made on the iOS side, and they are the assumptions the backend review should evaluate against.

### 1. The app will become local-first for chat reads

Decision:

- the iOS app should open from local persisted chat data immediately
- network sync should happen after the local render, not before it

Why:

- the current app refetches conversations and messages from the API on load
- that makes every chat open dependent on network latency and re-downloads history the device already had
- a local-first read path is the cleanest way to make chat feel instant and durable across relaunches

Backend review implication:

- the API needs delta sync primitives, not only list/history fetches

### 2. SwiftData will store the entire local chat cache

Decision:

- the iOS app will persist conversations, committed messages, drafts, and sync metadata locally

Why:

- health sync already established a SwiftData persistence pattern in this app
- the app needs durable chat state, not an in-memory cache
- sync correctness is easier if the client stores explicit sync markers rather than trying to infer freshness from view model arrays

Backend review implication:

- backend responses should be stable and explicit enough to map into durable local records

### 3. Server truth for committed history, local truth for drafts

Decision:

- Hermes/API are authoritative for committed conversation and message history
- local device state is authoritative only for draft text and transient pre-commit UI state

Why:

- Hermes can stream, rewind, replace assistant messages, and update titles
- if the app treats its own cached committed history as authoritative, it will drift from the backend
- drafts are user-authored local intent and should not be overwritten by sync

Backend review implication:

- committed history mutations must be observable explicitly from the API
- no draft sync contract is required in this version

### 4. The design must cover the full chat surface, not just messages

Decision:

- local persistence and sync should include the conversation list, conversation metadata, committed message history, titles, deletions, and sync cursors

Why:

- persisting only message bodies would still leave conversation list reloads and title consistency problems unsolved
- the app needs one coherent chat cache, not a partial one

Backend review implication:

- the backend must expose conversation-level changes as well as per-conversation message mutations

### 5. Backend changes are acceptable if they simplify correctness

Decision:

- this proposal is not constrained to the existing API surface
- we prefer explicit backend sync support over clever client-side guesswork

Why:

- the current API is optimized for current-page history loading, not durable incremental reconciliation
- a small, explicit sync contract is better than repeated full reloads and heuristic merging on iOS

Backend review implication:

- backend should evaluate the proposal as a contract design problem, not just an iOS cache implementation detail

### 6. Keep the existing history and SSE routes

Decision:

- do not replace existing history pagination or live SSE streaming
- add a durable sync layer alongside them

Why:

- SSE is still the right UX for live active runs
- history pages are still needed for first hydration and older-message pagination
- sync and streaming solve different problems

Backend review implication:

- the new contract can be additive rather than a rewrite of message delivery

---

## Source-of-truth rules

### Server truth

The backend is authoritative for:

- committed conversations
- committed user and assistant messages
- conversation title updates
- message rewinds and deletions
- assistant message replacement after reruns

### Local truth

The iOS app is authoritative only for:

- unsent compose draft text
- transient sending UI state before the backend confirms a committed message

The backend should not store or return client drafts in this proposal.

---

## Why the current contract is not enough

The current API works for:

- listing conversations
- loading the latest message page
- paginating older history
- live SSE token streaming

It does not provide a clean delta contract for:

- "what conversations changed since my last sync?"
- "what changed in this conversation since my last sync?"
- rewinds or deletions outside the active SSE session
- title changes without full list reload

The iOS app can fake some of this by reloading full pages, but that pushes complexity into the client and makes local-first chat brittle.

---

## Proposal summary

Keep the existing history and SSE routes, and add two explicit sync feeds:

1. `GET /conversations/sync`
   Purpose: conversation list deltas across the whole account
2. `GET /conversations/:id/sync`
   Purpose: conversation-scoped deltas for committed message history and metadata

These feeds should return ordered mutation events plus an opaque `next_sync_marker`.

The iOS app will:

- read conversations and messages from SwiftData
- keep a stored sync marker for the conversation list
- keep a stored sync marker per conversation
- call sync feeds on launch, foreground, chat open, send completion, edit/rerun completion, and pull-to-refresh

Existing HAL history routes remain the source for initial hydration and older-history pagination.

---

## iOS consumer model

This section explains how the proposed backend contract will be consumed on iOS, so the backend review can judge whether the API shape is well matched to the client architecture.

### Local records the app expects

The app plans to persist:

- conversation rows
- committed message rows
- local draft rows
- sync markers for the conversation list and each conversation

The backend does not need to mirror this schema exactly, but its contract should support this model cleanly.

### Open conversation flow

When a user opens a conversation:

1. iOS reads the local conversation row and local committed messages from SwiftData.
2. iOS separately reads the local draft text.
3. iOS renders immediately from local state.
4. iOS calls the conversation sync route with the stored sync marker.
5. iOS applies backend mutations into SwiftData.
6. SwiftUI re-renders from the updated local store.

This flow is why the sync contract must be explicit about deletes, rewinds, and replacement behavior.

### Conversation list flow

When the app launches, resumes, or refreshes:

1. iOS reads the local conversation list immediately.
2. iOS calls the global conversation sync route with the stored marker.
3. iOS applies list-visible mutations locally.
4. iOS updates the stored marker.

This flow is why title changes and latest-message movement need to show up as conversation-level deltas.

### Send and rerun flow

For a new send or edit/rerun:

1. iOS keeps draft text locally until the message is submitted.
2. SSE drives the live in-flight UX.
3. When the run settles, iOS performs sync reconciliation.
4. Any temporary local placeholders are replaced by committed server truth.

This flow is why SSE alone is not enough: it covers the active run UX, but not durable reconciliation after relaunch, failure, or backgrounding.

---

## Non-goals

This proposal does not ask the backend to:

- persist drafts
- replace SSE token streaming with sync polling
- expose partial assistant token state in durable history
- redesign the existing conversation/message resource shapes unless required for sync metadata

---

## Recommended contract

### `GET /conversations/sync`

Returns conversation-level mutations for the authenticated user after a given sync marker.

### Query

| Param | Required | Notes |
|-------|----------|-------|
| `since` | no | Opaque sync marker. Omit for first sync. |
| `limit` | no | Default 100, max 500. |

### Response

```json
{
  "events": [
    {
      "event_id": "ce_101",
      "type": "conversation_upsert",
      "occurred_at": "2026-06-17T11:00:00.000Z",
      "conversation": {
        "id": "c1",
        "title": "Trip to Porto",
        "hermes_session_id": "hs1",
        "created_at": "2026-06-17T10:00:00.000Z",
        "updated_at": "2026-06-17T11:00:00.000Z",
        "latest_message_id": "m8",
        "latest_message_created_at": "2026-06-17T11:00:00.000Z"
      }
    },
    {
      "event_id": "ce_102",
      "type": "conversation_deleted",
      "occurred_at": "2026-06-17T11:05:00.000Z",
      "conversation_id": "c2"
    }
  ],
  "next_sync_marker": "ce_102",
  "has_more": false
}
```

### Event types

| Type | Meaning |
|------|---------|
| `conversation_upsert` | Conversation created or changed in any list-visible way, including title change or latest-message movement |
| `conversation_deleted` | Conversation should be removed locally |

### Rules

- Events are ordered oldest to newest within the response.
- `next_sync_marker` is **always** returned on `200`. When the page includes events, it is the `event_id` of the last event in the page. When the page is empty, it is still the current feed tip (latest retained account `event_id`, or the origin sentinel `00000000-0000-4000-8000-000000000000` when no account events exist yet).
- Repeating the same `since` must be safe and idempotent.
- `conversation_upsert` should be sufficient to update the list row without a follow-up `GET /conversations/:id`.

### Empty page example (account)

```json
{
  "events": [],
  "next_sync_marker": "00000000-0000-4000-8000-000000000000",
  "has_more": false
}
```

---

### `GET /conversations/:id/sync`

Returns committed-history mutations for one conversation after a given sync marker.

### Query

| Param | Required | Notes |
|-------|----------|-------|
| `since` | no | Opaque conversation-scoped sync marker. Omit for first sync. |
| `limit` | no | Default 200, max 1000. |

### Response

```json
{
  "conversation": {
    "id": "c1",
    "title": "Trip to Porto",
    "hermes_session_id": "hs1",
    "created_at": "2026-06-17T10:00:00.000Z",
    "updated_at": "2026-06-17T11:00:00.000Z"
  },
  "events": [
    {
      "event_id": "cm_201",
      "type": "message_upsert",
      "occurred_at": "2026-06-17T10:58:00.000Z",
      "message": {
        "id": "m7",
        "conversation_id": "c1",
        "role": "user",
        "content": "Show me Porto restaurants",
        "created_at": "2026-06-17T10:58:00.000Z",
        "process": null
      }
    },
    {
      "event_id": "cm_202",
      "type": "messages_rewound",
      "occurred_at": "2026-06-17T10:59:30.000Z",
      "removed_message_ids": ["m8"]
    },
    {
      "event_id": "cm_203",
      "type": "message_upsert",
      "occurred_at": "2026-06-17T11:00:00.000Z",
      "message": {
        "id": "m9",
        "conversation_id": "c1",
        "role": "assistant",
        "content": "Here are some options...",
        "created_at": "2026-06-17T11:00:00.000Z",
        "process": {
          "lines": [
            { "kind": "tool", "text": "Searched restaurants" }
          ]
        }
      }
    }
  ],
  "next_sync_marker": "cm_203",
  "has_more": false
}
```

### Event types

| Type | Meaning |
|------|---------|
| `message_upsert` | A committed message should be inserted or replaced locally by `message.id` |
| `message_deleted` | A committed message should be removed locally |
| `messages_rewound` | Remove one or more committed messages because Hermes rewound the run |
| `conversation_deleted` | The conversation no longer exists for the user |

### Rules

- Events are ordered oldest to newest within the response.
- `conversation` is the current authoritative snapshot after applying events.
- `next_sync_marker` is **always** returned on `200` (same tip semantics as the account feed; origin sentinel when no conversation-scoped events exist yet).
- `message_upsert` is authoritative for both user and assistant committed messages.
- Hermes replacement behavior should be represented as `messages_rewound` followed by one or more `message_upsert` events.
- If a conversation has been deleted after the last successful sync, return `200` with a terminal `conversation_deleted` event rather than `410 Gone`.

### Empty page example (thread, after HAL hydration)

```json
{
  "conversation": {
    "id": "c1",
    "title": "Trip to Porto",
    "hermes_session_id": "hs1",
    "created_at": "2026-06-17T10:00:00.000Z",
    "updated_at": "2026-06-17T11:00:00.000Z"
  },
  "events": [],
  "next_sync_marker": "00000000-0000-4000-8000-000000000000",
  "has_more": false
}
```

---

## Existing routes that remain important

These routes stay in place and are still used:

- `GET /conversations`
  Initial conversation hydration and older/newer list pagination
- `GET /conversations/:id/messages`
  Initial thread hydration and older-history pagination
- `GET /conversations/:id/stream`
  Live SSE updates for the active run
- `POST /conversations/:id/messages`
  Create committed user messages and trigger Hermes
- `PATCH /conversations/:id/messages/:messageId`
  Edit/rerun existing user messages

The sync feeds are not a replacement for history pages or SSE. They are the durable reconciliation layer.

---

## Sync marker requirements

The backend should expose an opaque monotonic marker, not raw timestamps alone.

Preferred options, in order:

1. event ID from a durable mutation log
2. monotonic revision number
3. opaque server-generated token that can be resumed safely

Do not require the client to build sync correctness purely from `updated_at`.

### Required properties

- strictly monotonic within each feed
- replay-safe
- stable across process restarts
- cheap to store as a string in SwiftData
- **always returned** on successful sync (`200`), including empty `events` pages

### Tip marker semantics

- `next_sync_marker` is the **feed tip** — the client's cursor after applying the response.
- Non-empty page: tip = last `event_id` in the page.
- Empty page, events exist in scope: tip = latest retained `event_id` (client is caught up).
- Empty page, no events in scope yet: tip = origin sentinel `00000000-0000-4000-8000-000000000000` (valid `since`; not `sync_marker_invalid`).

### Retention (v2.1.0)

- `chat_sync_events` is **append-only** for client-visible markers in v2.1.0
- the server **does not compact or prune** account- or conversation-scoped events in this version
- deletion events are retained even after the conversation row is removed
- if `since` does not match any retained event for that feed scope **and is not the origin sentinel**, the API returns **`400` with `error: sync_marker_invalid`** — this is the explicit reset signal

Future compaction, if ever added, requires a new API version and a documented retention window. Until then, `sync_marker_invalid` means client state mismatch (restore without marker, corruption, or pre-sync app version), not server-side pruning. The origin sentinel `00000000-0000-4000-8000-000000000000` is always valid.

### Missing-marker recovery (required client flows)

| Feed | Local cache exists, marker missing | Required fallback |
|------|-----------------------------------|-------------------|
| Account list | yes | Call `GET /conversations/sync` with **`since` omitted**. Apply returned `conversation_upsert` / `conversation_deleted` events idempotently, paginate while `has_more`, then store `next_sync_marker`. HAL list hydration is optional because account sync can self-heal from retained events. |
| Thread | yes | **HAL rehydrate first:** `GET /conversations/{id}/messages` (at least the tail page). Then call `GET /conversations/{id}/sync` with **`since` omitted** to establish the tip marker. Thread sync never replays full history when `since` is omitted. |

The iOS app must not call thread sync with a stored marker assumption when no marker exists. A missing per-conversation marker always implies the HAL-then-sync-bootstrap sequence above.

### Invalid-marker recovery

When either feed returns `sync_marker_invalid`:

1. Clear the stored marker for that feed scope (account or that conversation).
2. **Account:** call again with `since` omitted (same as missing-marker path).
3. **Thread:** HAL-rehydrate the thread, then call again with `since` omitted.
4. Store the new `next_sync_marker` only after all pages are applied.

---

## Message ordering and identity

For local reconciliation to stay simple:

- every committed message needs a stable server `id`
- message order must remain authoritative from server timestamps or server insertion order
- `message_upsert` should never require the client to infer relative ordering from arrival order alone

If the backend can guarantee chronological ordering by `created_at`, that is sufficient for the iOS store.

---

## Title and metadata semantics

Conversation title changes should surface through `conversation_upsert` on the global feed and the `conversation` snapshot on the per-conversation feed.

The client should not need a separate title-specific endpoint or event type.

This keeps all list-visible conversation changes under one mutation shape.

---

## Rewind semantics

Hermes rewind is the main reason a real sync feed is needed.

Required behavior:

- if committed assistant history is removed, the backend must emit explicit removal mutations
- the removal must name exact server message IDs
- replacement assistant output arrives as later `message_upsert` events

The client will treat the backend as authoritative and remove the affected rows locally even if the user already viewed them.

---

## Draft boundary

The iOS app will keep drafts locally and separate from committed history.

Backend expectations:

- no server draft resource required in v1
- `POST /conversations/:id/messages` remains the point where a user message becomes committed history
- if the client inserted a temporary local sending placeholder, it will reconcile that placeholder against the committed server message after sync

This means the backend only needs to care about committed state.

---

## Client reconciliation model

The expected iOS behavior after this contract exists:

### Conversation list

1. Read all local conversations from SwiftData immediately.
2. If no account marker is stored, call `GET /conversations/sync` with `since` omitted; otherwise call with the stored marker.
3. Apply events transactionally.
4. Persist `next_sync_marker`.
5. On `sync_marker_invalid`, clear the account marker and repeat step 2 with `since` omitted.

### Chat thread

1. Read local committed messages immediately.
2. Read local draft text separately.
3. If no per-conversation marker is stored, HAL-rehydrate the thread, then call `GET /conversations/:id/sync` with `since` omitted to establish the tip marker; otherwise call with the stored marker.
4. Apply events transactionally (and apply the `conversation` snapshot even when `events` is empty).
5. Persist `next_sync_marker`.
6. On `sync_marker_invalid`, clear the marker and repeat step 3 via the HAL-then-bootstrap path.

### After send or edit/rerun

1. Use SSE for live response UX.
2. When the run settles, call conversation sync again.
3. Trust sync output over any temporary local placeholders.

---

## Backward compatibility and rollout

Recommended rollout:

1. Add sync feeds and OpenAPI docs.
2. Keep existing list/history routes unchanged.
3. Ship iOS local-first reads behind the new sync contract.
4. Later, optimize or consolidate feeds if needed.

This proposal is additive. Old clients continue using the current routes.

---

## Backend implementation freedom

The backend agent does not need to use a specific storage design as long as the contract above is satisfied.

Acceptable internal approaches:

- durable `chat_sync_events` table
- per-user and per-conversation revision counters
- append-only event log derived from message and conversation mutations

The important constraint is external behavior:

- ordered deltas
- stable markers
- explicit rewind and deletion events

---

## Acceptance criteria

The proposal is good enough for iOS local-first chat if all of these are true:

1. The client can detect conversation creates, title updates, latest-message movement, and deletions without refetching the whole list.
2. The client can detect committed user and assistant messages added after the last thread sync.
3. Hermes rewinds are represented explicitly by server message ID.
4. A title update is observable both in the list feed and in the open-thread sync snapshot.
5. Sync markers can be stored and reused safely across app relaunches.
6. Existing history pagination remains available for older message loading.
7. Missing or invalid markers have explicit recovery flows: account sync self-heals with `since` omitted; thread sync requires HAL rehydration before `since` omitted; invalid markers return `sync_marker_invalid`.
8. `next_sync_marker` is always returned on `200`, including empty pages, so marker bootstrap never depends on receiving at least one event.

---

## Backend review answers (2026-06-17)

1. **Two feeds, not one unified `/chat/sync`.** The iOS client already separates list reconciliation from thread reconciliation, with different call sites, limits, and stored markers. `messaging-api` routes are already split along conversation vs message concerns. A unified feed would force the client to filter mixed scopes and over-fetch thread events on every launch.

2. **Opaque UUID event IDs from a durable append-only log.** Markers are `event_id` values (UUID strings) from a new `chat_sync_events` table. They are monotonic by `(occurred_at, id)`, replay-safe, and cheap to store in SwiftData. Numeric revisions would still require separate counters per feed scope; event IDs reuse the same persistence model and carry typed payloads for rewinds.

3. **`200` + terminal `conversation_deleted` event on thread sync.** Preferred over `410 Gone`. The client applies deletions in the same transactional reconcile pass as rewinds and upserts. `410` would be a special case that breaks idempotent replay. `404` is reserved for unknown conversations with no retained sync tail (never existed, wrong user, or no deletion event to replay).

4. **Mutation points exist; schema work is for the event log, not rewinds.** `message-editor.ts` already deletes assistant messages by stable ID and `run-executor.ts` already publishes SSE `rewind` with `removedMessageIds`. What is missing is **persisting** those mutations into a durable sync log. Plan: add `chat_sync_events`, wire emitters at existing mutation sites, and one-time account-scoped backfill of `conversation_upsert` rows for existing conversations (no message-history backfill — HAL hydration remains the initial thread seed).

### Additional backend decisions

- **Initial hydration stays on HAL routes.** Thread sync does not replay full message history when `since` is omitted; it only returns events recorded after deploy (or after the client's HAL seed). Account sync may return backfilled `conversation_upsert` events when `since` is omitted and can self-heal a cached list without HAL.
- **Marker recovery is explicit.** Missing thread marker ⇒ HAL rehydrate then thread sync with `since` omitted. Missing/invalid account marker ⇒ account sync with `since` omitted. Invalid `since` ⇒ `400 sync_marker_invalid` reset signal.
- **No event compaction in v2.1.0.** Append-only log; `sync_marker_invalid` is not used for pruning.
- **Title-only changes:** global feed emits `conversation_upsert`; thread sync may return empty `events` with an updated `conversation` snapshot (documented in OpenAPI).
- **Fix list ordering gap:** `updateConversationTitle` / auto-title currently do not bump `conversations.updated_at`; implementation will call `touchConversationUpdatedAt` so list ordering and sync stay aligned.

## Questions for backend review

1. Should the backend implement the proposed event feeds directly, or would it prefer a single unified `/chat/sync` feed?
2. Can the backend provide durable opaque sync markers, or does it want to expose numeric revisions instead?
3. Is `conversation_deleted` as a terminal event on `GET /conversations/:id/sync` acceptable, or would the backend strongly prefer `410 Gone`?
4. Does the current data model already have enough mutation points to emit explicit rewind events by message ID, or is schema work needed?

### What the backend agent should review specifically

- whether the proposed split between global conversation sync and per-conversation sync matches the current backend architecture well
- whether a durable mutation log, revision counter, or opaque token is the best sync-marker mechanism
- whether current Hermes run and rewind behavior can emit explicit committed-history mutations without fragile inference
- whether the existing conversation and message tables already expose enough information for list-visible deltas such as title changes and latest-message movement
- whether any simpler contract would still satisfy the iOS local-first requirements without reintroducing full reloads or client-side guesswork

---

## Recommendation

Implement the two-feed design as proposed:

- `GET /conversations/sync`
- `GET /conversations/:id/sync`

This gives the iOS app a clean local-first architecture without forcing a larger event-sourcing rewrite, and it keeps Hermes committed history fully server-authoritative.
