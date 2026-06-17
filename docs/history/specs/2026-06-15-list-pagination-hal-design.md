# List Pagination (HAL `_links`) — Design Spec

**Date:** 2026-06-15  
**Status:** Draft — pending review  
**API version:** v1.7.0 (OpenAPI; v1.6.0 was invite auth)  
**Plans:**
- `docs/history/plans/2026-06-15-list-pagination-hal-backend.md` — **implemented in this repo**
- `docs/history/plans/2026-06-15-list-pagination-hal-ios.md` — **reference only; implemented in `assistant-companion` repo**  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (must be updated with every contract change)  
**Workspace rules:** `AGENTS.md` — repository scope, list pagination, OpenAPI mandatory  
**Supersedes:** unpaginated list responses in OpenAPI v1.5.0; interim `next_cursor` / `prev_cursor` + `cursor` / `direction` shape (implemented locally, not shipped); `GET /data/location/events` `{ events }` + `before`-only pagination from v1.5.0

---

## Goal

Standardize **all messaging-api list endpoints** on **HAL-style `_links` pagination**. Clients follow relative `href` URLs (REST) or re-invoke MCP tools with query params extracted from `href` (MCP). No total counts. Default page size 20, max 100.

This is a **breaking change** for any client that expects bare arrays or the v1.5.0 location list shape.

---

## Repository scope

| Artifact | Where it lives | Implemented here? |
|----------|----------------|-------------------|
| `messaging-api` backend | `hermes/messaging-api/` | **Yes** |
| OpenAPI contract | `docs/superpowers/specs/messaging-api.openapi.yaml` | **Yes** (required on every contract change) |
| Companion MCP + skills | `messaging-api/`, `data/skills/` | **Yes** |
| iOS client (`assistant-companion`) | separate repo | **No** — spec + reference plan only |
| iOS implementation plan | `docs/superpowers/plans/…-ios.md` | Documented, not executed in `hermes` |

---

## Scope — REST list endpoints (all three)

| Method | Path | Collection key | Default window | Sort order |
|--------|------|----------------|----------------|------------|
| `GET` | `/conversations` | `conversations` | Newest `limit` | `updated_at DESC, id DESC` |
| `GET` | `/conversations/:id/messages` | `messages` | Tail — last `limit` | `created_at ASC` within page |
| `GET` | `/data/location/events` | `events` | Newest `limit` | `timestamp DESC` |

**Not list endpoints:** `GET /conversations/:id`, `GET /data/location/latest`, `GET /auth/me`, `GET /health`, SSE streams, write routes.

---

## Scope — MCP list tools

MCP tools that return collections **mirror the REST pagination contract** in their JSON result (same `_links` shape and `before` / `after` semantics). Tool arguments accept `limit`, `before`, and `after` where the REST route does.

| Tool | Collection key | REST equivalent |
|------|----------------|-----------------|
| `get_location_history` | `events` | `GET /data/location/events` |

**Out of scope for v1.6.0 pagination:** `list_companion_accounts` — bounded operator snapshot (`users` + `pending_invites`), expected to stay small. New list tools must follow the rules below.

---

## Standard pagination rules (all list endpoints)

These rules apply to **every new list endpoint** in `messaging-api` (see `AGENTS.md`).

### Response envelope

```json
{
  "<collection>": [ /* items */ ],
  "_links": {
    "self": { "href": "<path>?limit=20" },
    "next": { "href": "<path>?limit=20&before=<uuid>" },
    "prev": { "href": "<path>?limit=20&after=<uuid>" }
  }
}
```

### Link rules

| Rule | Detail |
|------|--------|
| `href` format | Path + query, **relative** (e.g. `/data/location/events?limit=20&before=…`). No host. |
| `self` | Always present; reflects the request that produced this page. |
| `next` / `prev` | **Omitted** when no further page exists in that direction (never `null`). |
| Counts | Never included (`total`, `count`, `has_more`, etc.). |

### Request parameters

| Param | Required | Default | Max | Notes |
|-------|----------|---------|-----|-------|
| `limit` | no | 20 | 100 | Integer 1–100 |
| `before` | no | — | — | UUID anchor — page strictly **before** anchor in list order |
| `after` | no | — | — | UUID anchor — page strictly **after** anchor in list order |

Validation (all list routes / tools):

- `before` and `after` are **mutually exclusive**
- Anchor UUID must exist in the scoped collection
- Invalid `limit`, unknown anchor, or both anchors → `400 { "error": "invalid_request" }` (REST) or MCP tool error
- Scoped resource missing (e.g. conversation) → `404` where applicable

### Link direction (newest-first lists)

For lists sorted **newest first** (`conversations`, `location events`):

| Link | Points to |
|------|-----------|
| `next` | Older items — `?limit=N&before=<last-id-on-page>` |
| `prev` | Newer items — `?limit=N&after=<first-id-on-page>` |

### Link direction (messages — tail default, chronological within page)

| Link | Points to |
|------|-----------|
| `prev` | Older messages — `?limit=N&before=<first-id-on-page>` |
| `next` | Newer messages — `?limit=N&after=<last-id-on-page>` |

Default tail page omits `next` (already at newest).

### HAL note

We use `_links` + `href` from [HAL](https://datatracker.ietf.org/doc/html/draft-kelly-json-hal-11). Content-Type stays `application/json` (no `application/hal+json`, no `_embedded`).

### Implementation checklist (new list endpoints — backend in `hermes`)

1. Repo function: `list<Thing>Page(db, scope, limit, { before?, after? })` → items + `hasOlder` + `hasNewer`
2. Route handler: `parsePageLimit` + `parseListAnchors` + `buildHalLinks`
3. Tests: default page, `before`/`after` traversal, boundary links, validation errors
4. **OpenAPI (mandatory):** update `messaging-api.openapi.yaml` — shared `HalLinks` + `<Thing>ListResponse`; bump API version
5. MCP tool (if any): same envelope and anchor args; document in OpenAPI changelog if REST-equivalent
6. **Spec (mandatory):** document FE/client impact in design spec; add or update external client reference plan if `assistant-companion` is affected

---

## `GET /conversations`

### Default page

Newest `limit` conversations.

### Example — first page

```http
GET /conversations?limit=2
```

```json
{
  "conversations": [
    { "id": "aaa", "title": "Latest", "updated_at": "2026-06-15T10:00:00.000Z" },
    { "id": "bbb", "title": "Second", "updated_at": "2026-06-14T12:00:00.000Z" }
  ],
  "_links": {
    "self": { "href": "/conversations?limit=2" },
    "next": { "href": "/conversations?limit=2&before=bbb" }
  }
}
```

---

## `GET /conversations/:id/messages`

### Default page

Last `limit` messages, chronological within the page.

### Example — tail page

```http
GET /conversations/{id}/messages?limit=2
```

```json
{
  "messages": [
    { "id": "m4", "role": "user", "content": "follow-up" },
    { "id": "m5", "role": "assistant", "content": "reply" }
  ],
  "_links": {
    "self": { "href": "/conversations/{id}/messages?limit=2" },
    "prev": { "href": "/conversations/{id}/messages?limit=2&before=m4" }
  }
}
```

---

## `GET /data/location/events`

### Breaking change from v1.5.0

| v1.5.0 | v1.6.0 |
|--------|--------|
| `{ "events": [...] }` | `{ "events": [...], "_links": { ... } }` |
| `?limit`, `?before` only | `?limit`, `?before`, `?after` |
| Forward-only | Bidirectional via `_links` |

### Default page

Newest `limit` location events for the authenticated user.

### Example — first page

```http
GET /data/location/events?limit=2
```

```json
{
  "events": [
    { "id": "e3", "timestamp": "2026-06-15T11:00:00.000Z", "lat": 38.72, "lon": -9.14 },
    { "id": "e2", "timestamp": "2026-06-15T10:00:00.000Z", "lat": 38.71, "lon": -9.13 }
  ],
  "_links": {
    "self": { "href": "/data/location/events?limit=2" },
    "next": { "href": "/data/location/events?limit=2&before=e2" }
  }
}
```

### Example — older page

```http
GET /data/location/events?limit=2&before=e2
```

```json
{
  "events": [
    { "id": "e1", "timestamp": "2026-06-15T09:00:00.000Z", "lat": 38.70, "lon": -9.12 }
  ],
  "_links": {
    "self": { "href": "/data/location/events?limit=2&before=e2" },
    "prev": { "href": "/data/location/events?limit=2&after=e1" }
  }
}
```

---

## MCP `get_location_history`

### Tool arguments (v1.6.0)

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `username` | string | required | Companion account |
| `limit` | int | 20 | 1–100 |
| `before` | string | optional | Event UUID |
| `after` | string | optional | Event UUID; mutually exclusive with `before` |

### Tool result

Same envelope as REST:

```json
{
  "events": [ /* LocationHistoryEvent */ ],
  "_links": {
    "self": { "href": "/data/location/events?limit=20" },
    "next": { "href": "/data/location/events?limit=20&before=<uuid>" }
  }
}
```

`href` values mirror the REST route so the `companion-user-location` skill can document: *re-call `get_location_history` with `limit`, `before`, and/or `after` parsed from `_links`.*

---

## Internal / Unchanged

Full-history loads for assistant runs (not HTTP list handlers):

- `listMessages` in `run-executor`, `message-editor`, `title-generator`
- `buildHermesMessages` / prompt assembly

---

## Backend Components

| Component | Responsibility |
|-----------|----------------|
| `src/lib/pagination.ts` | `parsePageLimit`, `parseListAnchors`, `buildHalLinks` |
| `src/db/repos/conversations.ts` | `listConversationsPage` |
| `src/db/repos/messages.ts` | `listMessagesPage` |
| `src/db/repos/location-events.ts` | `listLocationEventsPage` (replaces forward-only `listLocationEvents` for HTTP/MCP) |
| `src/routes/conversations.ts` | HAL list response |
| `src/routes/messages.ts` | HAL list response |
| `src/routes/data-location.ts` | HAL list response |
| `src/services/mcp-tools.ts` | `get_location_history` HAL result + `after` arg |
| `src/routes/mcp.ts` | Zod schema: add `after` on `get_location_history` |

---

## iOS Client (`assistant-companion`) — spec only

> **Not implemented in this repo.** This section defines the client contract so `assistant-companion` can be updated in its own repo before backend v1.6.0 deploy. See `docs/history/plans/2026-06-15-list-pagination-hal-ios.md`.

### Breaking decode changes

| Before | After |
|--------|-------|
| `GET /conversations` → `[Conversation]` | `ConversationListResponse` |
| `GET /…/messages` → `[Message]` | `MessageListResponse` |
| `GET /data/location/events` → `LocationEventList { events }` | `LocationEventListResponse` with `_links` |

### Shared model

Reuse one `HalLinks` type across all list responses. `APIClient.get(href:)` follows relative links.

### Location history UI

`getLocationHistory()` decodes `LocationEventListResponse`; load more via `_links.next.href` in location history views (if present).

---

## OpenAPI v1.6.0 (required)

**Gate:** backend work is not complete until `docs/superpowers/specs/messaging-api.openapi.yaml` reflects every changed route, query param, and response schema.

Add shared schemas: `HalLink`, `HalLinks`.

Add list response schemas:

- `ConversationListResponse`
- `MessageListResponse`
- `LocationEventListResponse` (replaces bare `LocationEventList`)

Update all three `GET` list paths with `limit`, `before`, `after` query params.

---

## Deployment / Compatibility

| Layer | Where | Strategy |
|-------|-------|----------|
| Backend | `hermes` | Ship v1.6.0; no feature flag; OpenAPI updated |
| iOS | `assistant-companion` (external) | Must ship before or with backend deploy; not built in `hermes` |
| Hermes skill | `hermes/data/skills/` | Update `companion-user-location` for `_links` on `get_location_history` |
| Smoke test | `hermes` | Assert `_links` on conversation list + MCP history |
| README | `hermes` | v1.6.0 pagination note |

---

## Testing

### Backend (Vitest)

- All three REST list endpoints: default page, `before`/`after`, `_links` boundaries, validation
- `data-location.test.ts`: migrate from `{ events }` to HAL assertions
- `mcp.test.ts`: `get_location_history` returns `_links`; `after` traversal
- Empty collections: `{ <collection>: [], _links: { self } }`

### iOS (XCTest) — `assistant-companion` repo only

Not run in `hermes`. Reference checklist for the external client plan:

- Decode all three list response types
- `APIClient` href following
- ViewModel pagination for conversations, messages, location history

---

## Risks

| Risk | Mitigation |
|------|------------|
| Location vault iOS already shipped v1.5.0 shape | Include in same coordinated v1.6.0 release |
| MCP agents ignore `_links` | Update companion skill with explicit re-call instructions |
| `list_companion_accounts` inconsistency | Document as intentional exception until size warrants pagination |