# Message Edit — Design Spec
**Date:** 2026-06-13  
**Status:** Implemented  
**Companion spec:** `2026-06-12-hermes-messaging-api-design.md`  
**API contract:** `messaging-api.openapi.yaml` (same directory)

---

## Goal

Allow users to edit their latest user message in a conversation. The API updates SQLite, discards the assistant's last reply, rotates the Hermes session, and re-runs the assistant against the corrected transcript.

---

## Decisions

| Topic | Choice |
|-------|--------|
| When editable | Completed user→assistant pair only; no active run |
| Hermes reset | Rotate `hermes_session_id` on edit |
| Client flow | `202` + existing SSE stream (same as `POST`) |
| Endpoint | `PATCH /conversations/:id/messages/:messageId` |
| Implementation | Dedicated `message-editor` service |

---

## Client impact

**Will this break the existing iOS app? No.**

| Area | Impact |
|------|--------|
| Existing endpoints | Unchanged |
| `POST /messages` | Unchanged |
| SSE stream | New optional `rewind` event — unknown events are ignored by current app |
| `PATCH /messages/:messageId` | New endpoint; app does not call it yet |

Deploying backend-only is safe. Edit UX requires an app update.

---

## Eligibility rules

`PATCH` succeeds only when **all** of these hold:

1. No active run (`409 run_conflict`)
2. `messageId` exists in the conversation, `role === 'user'`
3. Transcript ends `… user (messageId), assistant` — target user message is **second-to-last**
4. New text is non-empty after trim (same validation as `POST`)

Otherwise:

| Condition | Response |
|-----------|----------|
| Not latest editable pair | `400 edit_not_allowed` |
| Empty/whitespace text | `400 invalid_request` |
| Wrong conversation / message / ownership | `404 not_found` |
| Active run | `409 run_conflict` |

---

## Architecture

New unit: `src/services/message-editor.ts`

- `editUserMessageAndRerun(input)` — validate, mutate DB, rotate session, start run
- Called from `PATCH` handler in `src/routes/messages.ts`

Changes to existing units:

- `src/db/repos/messages.ts` — `updateMessageContent`, `deleteMessage`
- `src/db/repos/conversations.ts` — `rotateHermesSessionId`
- `src/db/repos/runs.ts` — `deleteRunForUserMessage` (or delete by run id)
- `src/streams/hub.ts` — add `rewind` to `StreamEvent`
- `src/services/run-executor.ts` — publish `rewind` before tokens when triggered by edit (or message-editor publishes before calling executor)

---

## Database transaction

Executed atomically before returning `202`:

```sql
-- 1. Remove completed run for this turn
DELETE FROM message_runs WHERE conversation_id = ? AND user_message_id = ?

-- 2. Remove superseded assistant reply
DELETE FROM messages WHERE id = ?  -- last message (assistant)

-- 3. Update user message in place (same id)
UPDATE messages SET content = ? WHERE id = ? AND role = 'user'

-- 4. Rotate Hermes session (discard Hermes-side context)
UPDATE conversations SET hermes_session_id = ? WHERE id = ?

-- 5. New run for the same user message
INSERT INTO message_runs (id, conversation_id, user_message_id, status)
VALUES (?, ?, ?, 'running')
```

The user message **keeps the same `id`** so the client reference stays stable.

Deletion order respects foreign keys: `message_runs` before `messages`.

---

## Hermes behavior

After commit, `executeAssistantRun` runs with:

- New `hermes_session_id` from the rotated conversation row
- Full corrected SQLite history (no deleted assistant message)

No separate Hermes "rewind" API — session rotation + corrected transcript is the discard mechanism.

---

## API

```
PATCH /conversations/:id/messages/:messageId
{ "text": "what time is it in Porto?" }

→ 202 { "message": <updated user Message> }
```

Client then opens `GET /conversations/:id/stream` — identical to post-send flow.

---

## SSE delivery

Before new `token` events, publish:

```
event: rewind
data: {"removedMessageIds":["<assistant-message-id>"]}
```

Allows the app to remove the stale assistant bubble immediately. Stream then continues with `token` → `tool` → `done` / `error` as today.

`rewind` is published once at the start of the replacement run.

---

## End-to-end flow

```
1. Client PATCH /conversations/:id/messages/:messageId { text }
2. API validates eligibility
3. API transaction: delete run + assistant, update user, rotate session, create run
4. API returns 202 { message }
5. API starts executeAssistantRun in background
6. Client GET /stream
7. API → SSE rewind (removed assistant id)
8. API → Hermes streamChat (new session, full history)
9. API → SSE token / tool / done
10. API persists new assistant message
```

---

## Error handling

| Scenario | Behavior |
|----------|----------|
| Active run when PATCH arrives | `409 run_conflict` |
| Message not in editable position | `400 edit_not_allowed` |
| Hermes re-run fails | `error` SSE, run marked failed, user message stays edited, no assistant message |
| Client misses `rewind` | Correct state available via `GET /messages` after `done` |

---

## Testing

- Unit: eligibility validation (pair position, role, active run)
- Integration: PATCH → rewind SSE → new assistant message persisted
- PATCH on non-latest user message → `edit_not_allowed`
- PATCH during active run → `run_conflict`
- `hermes_session_id` changes after edit
- Old assistant message and run row are gone; user message id unchanged

---

## Out of scope (MVP)

- Edit while assistant is streaming
- Edit user-only messages (no assistant reply yet)
- Edit older turns (not the latest pair)
- Title regeneration after edit
- iOS edit UI

---

## Implementation handoff

1. Read this spec and `messaging-api.openapi.yaml` (v1.3.0)
2. Implement backend changes in `messaging-api/`
3. Update OpenAPI if behavior diverges during implementation
4. Companion app changes are a separate task