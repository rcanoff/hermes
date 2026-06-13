# Conversation Title Generation — Design Spec
**Date:** 2026-06-13  
**Status:** Implemented  
**Companion spec:** `2026-06-12-hermes-messaging-api-design.md`  
**API contract:** `messaging-api.openapi.yaml` (same directory)

---

## Goal

Auto-generate a short conversation title from the first user message using Hermes, persist it on the conversation, notify connected clients via SSE, and allow manual renames.

---

## Client impact

**Will this break the existing iOS app? No.**

| Area | Impact |
|------|--------|
| Existing endpoints | Unchanged request/response shapes |
| `POST /conversations` | Still returns `title: null` immediately (same as today) |
| `GET /conversations` | `title` changes from `null` → string after first message; safe for clients that already treat null as “show date” |
| SSE stream | New `title` event is additive; planned app `handleSSEEvent` uses `default: break` and ignores unknown events |
| `PATCH /conversations/:id` | New endpoint; app does not call it yet |

**What the app will not do without an update:**

- Update the conversation list or nav title in real time (must handle `title` SSE event or refetch)
- Let the user rename a conversation (must call `PATCH /conversations/:id`)

Deploying backend-only is safe. Titles appear after the user leaves and refetches the conversation list, or on next app launch.

---

## Decisions

| Topic | Choice |
|-------|--------|
| Title input | First user message only |
| Timing | Parallel with assistant run (non-blocking) |
| Delivery | SSE `title` event on existing stream |
| Manual edit | `PATCH /conversations/:id`; auto-gen only when `title IS NULL` |
| Hermes session for title | Throwaway UUID (do not use conversation `hermes_session_id`) |

---

## Architecture

New unit: `src/services/title-generator.ts`

- `generateConversationTitle(hermesClient, userMessageText): Promise<string | null>`
- One-shot `streamChat` call with system + user prompt
- Sanitize result: trim, strip quotes/newlines, cap at 80 chars
- Return `null` on empty/garbage response or Hermes failure

Changes to existing units:

- `src/db/repos/conversations.ts` — `updateConversationTitleIfNull`, `updateConversationTitle`
- `src/routes/messages.ts` — trigger background title gen after first message insert
- `src/routes/conversations.ts` — `PATCH /conversations/:id`
- `src/streams/hub.ts` — add `title` to `StreamEvent`

---

## Trigger rules

After `POST /conversations/:id/messages` saves the user message, start `generateAndSaveTitle()` in the background when **both**:

1. `conversation.title` is `null`
2. Exactly one message exists in the conversation (the message just inserted)

Run in parallel with `executeAssistantRun()`. Do not block the `202` response.

---

## Title generation prompt

```
System: Generate a short conversation title (max 6 words) from the user's
        message. Reply with only the title — no quotes, no punctuation.
User:   <first message text, truncated to 500 chars>
```

Hermes call uses a random throwaway `hermes_session_id`, not the conversation session.

---

## Persistence

```sql
UPDATE conversations
SET title = ?
WHERE id = ? AND title IS NULL
```

Atomic guard: if the user PATCHes a title before auto-gen finishes, auto-gen does not overwrite.

Manual rename:

```sql
UPDATE conversations SET title = ? WHERE id = ?
```

Validation: non-empty after trim, max 120 characters.

---

## SSE delivery

Extend stream events (see OpenAPI `x-sse-events` on `/conversations/{id}/stream`):

```
event: title
data: {"title":"Grocery list ideas"}
```

Publish when the conditional `UPDATE` affects one row. On failure, log and leave `title` null — no event, assistant run unaffected.

`title` may arrive before, during, or after `token`/`done` events on the same connection.

---

## API changes

### New: `PATCH /conversations/:id`

Request: `{ "title": "My custom name" }`  
Response: `200` with full `Conversation` object  
Errors: `400 invalid_request`, `404 not_found`

### Unchanged

All other endpoints keep current behavior. See `messaging-api.openapi.yaml`.

---

## Error handling

| Scenario | Behavior |
|----------|----------|
| Hermes title call fails | Log warning, `title` stays `null` |
| User PATCH before auto-gen | `WHERE title IS NULL` prevents overwrite |
| Client misses SSE `title` | Title in DB; visible on next `GET /conversations` |
| Empty Hermes response | Skip update, no SSE event |

---

## Testing

- Unit: prompt building, response sanitization
- Integration: first message → title saved + SSE `title` event
- First message when title already set → no title Hermes call
- PATCH rename works; later messages do not re-trigger
- Race: PATCH before auto-gen → user title kept
- `FakeHermesClient` must support concurrent `streamChat` calls (assistant + title)

---

## Out of scope

- iOS rename UI and live title SSE handling
- Title regeneration endpoint
- Auto-update title on later messages
- Backfill titles for existing multi-message conversations

---

## Implementation handoff

1. Read this spec and `messaging-api.openapi.yaml`
2. Implement backend changes in `messaging-api/`
3. Update OpenAPI if behavior diverges during implementation
4. Companion app changes are a separate task (handle `title` SSE, add PATCH rename)