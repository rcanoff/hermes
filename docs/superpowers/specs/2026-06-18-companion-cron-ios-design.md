# Companion Cron — iOS Client Design Spec (Reference)

**Date:** 2026-06-18  
**Status:** Approved (reference)  
**API version:** v2.3.0  
**Repo:** `assistant-companion` (not this workspace)  
**Backend spec:** `docs/superpowers/specs/2026-06-18-companion-cron-design.md`  
**Backend plan:** `docs/superpowers/plans/2026-06-18-companion-cron-backend.md`

> **For the iOS agent:** Read this spec, then write the full implementation plan at  
> `docs/superpowers/plans/2026-06-18-companion-cron-ios.md` in the `assistant-companion` repo.  
> Do **not** invent UX flows here — this document only lists API/model changes the client must support.

---

## What changed (API v2.3.0)

### Conversation `kind`

| Field | Type | Values |
|-------|------|--------|
| `kind` | string | `regular` (default), `job` |

Present on:

- `GET /conversations/{id}`
- `GET /conversations` items
- `GET /conversations/sync` → `conversation_upsert.conversation`

### Job metadata (when `kind == "job"`)

| Field | Type | Notes |
|-------|------|-------|
| `hermes_job_id` | string \| null | Hermes cron job id |
| `schedule_display` | string \| null | e.g. `30 9 * * *`, `once at …` |
| `job_enabled` | boolean | Cached enabled state |
| `job_last_run_at` | string \| null | SQLite datetime |
| `job_last_status` | string \| null | `ok`, `error`, or null |

### New endpoint: `GET /jobs`

HAL-paginated list of **job conversations only** (same pagination as `GET /conversations`: `limit`, `before`, `after`).

Response envelope:

```json
{
  "jobs": [ { /* JobConversation — Conversation + job fields */ } ],
  "_links": { "self": { "href": "..." }, "next": {}, "prev": {} }
}
```

Use for a jobs index without client-side filtering of `GET /conversations`.

---

## Client responsibilities

### 1. Model layer

- Extend `Conversation` (or equivalent) with `kind` + optional job fields.
- Default `kind` to `regular` when absent (forward-compat).
- Add `JobConversation` type alias or computed `isJob` if helpful.

### 2. API client

- Decode new fields on conversation endpoints.
- Add `fetchJobs(limit:before:after:)` → `GET /jobs`.
- No new write endpoints for cron v1 — job creation stays in Hermes chat flow.

### 3. Local store / sync

- Persist `kind` and job fields on conversation records.
- `conversation_upsert` sync events may introduce or update `kind=job` rows.
- `message_upsert` in a job conversation delivers scheduled run output — same pipeline as regular assistant messages.
- No push v1 — rely on sync when app opens.

### 4. Job creation UX (agent-owned)

When the user creates a job from a **regular** conversation, the assistant reply includes:

- `conversation_id` — new job conversation
- `hermes_job_id` — Hermes cron job id

**Client must:** parse/store these IDs if the product shows a jobs feature. **How** to present them is an iOS product decision (out of scope for this spec).

### 5. Job conversation thread

- Open by `conversation_id` like any thread.
- Messages include: creation summary, user config edits, periodic run outputs.
- User can chat to edit/pause/remove (Hermes handles via `cronjob` tool).

### 6. Jobs list

- Source: `GET /jobs` (preferred) or filter local store by `kind == job`.
- Display metadata: `title`, `schedule_display`, `job_enabled`, `job_last_run_at`, `job_last_status`.
- Row tap → open job conversation by `id`.

### 7. Regular vs job conversations

- `GET /conversations` still returns **all** conversations unless backend later adds a filter.
- Product may choose to hide `kind=job` from the main chat list — **iOS plan decides**.

---

## Not in scope (iOS v1)

- Push notifications for cron fires
- Calling `POST /internal/cron/deliver` (server-only, Hermes webhook)
- MCP tools (Hermes-only)
- Creating jobs without Hermes chat
- Bootstrap changes for job convs (server sets bootstrap via MCP)

---

## Verification checklist (for iOS plan)

1. Decode `kind=job` on conversation fetch/sync.
2. `GET /jobs` pagination matches HAL `_links` pattern used elsewhere.
3. Job conversation receives new assistant messages after scheduled runs (via thread sync).
4. IDs from assistant create reply can be stored and correlated with `GET /jobs`.
5. Existing regular conversations unchanged (`kind` absent or `regular`).

---

## Deploy order

1. Ship backend (this repo) + OpenAPI v2.3.0.
2. Ship iOS client with model/sync/jobs support.
3. Hermes `companion-cron` skill + operator webhook config.