# Companion Health Vault — Backend Design

**Date:** 2026-06-17  
**Status:** Draft — pending review  
**Parent:** `docs/superpowers/specs/2026-06-17-companion-health-vault-design.md`  
**iOS spec:** `docs/superpowers/specs/2026-06-17-companion-health-vault-ios-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v2.0.0)

---

## Goal

Add user-scoped **health daily summary** storage to `messaging-api`, expose REST ingest/read routes, companion MCP tools for granular health Q&A, and a `companion-user-health` data skill.

The API is a **passive vault** — it does not finalize days, query HealthKit, or run cron jobs.

---

## Database

### Table: `health_daily_summaries`

```sql
CREATE TABLE health_daily_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,              -- YYYY-MM-DD local calendar day
  timezone TEXT NOT NULL,          -- IANA e.g. Europe/Lisbon
  partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
  finalized_at TEXT,               -- set when partial=0 accepted
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'healthkit',
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX health_daily_summaries_user_date_idx
  ON health_daily_summaries (user_id, date);

CREATE INDEX health_daily_summaries_user_date_desc_idx
  ON health_daily_summaries (user_id, date DESC, id DESC);
```

Migration via `ensureLegacy*` pattern in `schema.ts`.

---

## Metric schema (request + storage)

Each metric in `metrics` object:

```typescript
interface HealthMetric {
  value: number
  unit: 'count' | 'm' | 'kcal' | 'min' | 'h'
  goal: number | null
  remaining: number | null
}
```

Allowed keys in v1: `steps`, `distance_walking_running`, `active_energy`, `exercise_minutes`, `stand_hours`.

Validation:

- `value` ≥ 0
- When `goal` is number: `remaining` must equal `max(0, goal - value)` (reject mismatch with 400)
- When `goal` is null: `remaining` must be null

---

## REST API

All routes JWT-authenticated (`userId` from token). User-scoped; no `conversation_id`.

### `POST /data/health/daily-summaries`

Upsert on `(user_id, date)`.

**Request:**

```json
{
  "date": "2026-06-17",
  "timezone": "Europe/Lisbon",
  "partial": true,
  "source": "healthkit",
  "metrics": { ... }
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `date` | yes | `YYYY-MM-DD` |
| `timezone` | yes | Non-empty IANA string |
| `partial` | yes | boolean |
| `metrics` | yes | At least one metric key |
| `source` | yes | `healthkit` in v1 |

**Upsert rules:**

| Existing row | Incoming | Result |
|--------------|----------|--------|
| none | any | insert |
| `partial: true` | any | update (today in progress) |
| `partial: false` | `partial: false` | idempotent update (same final re-sync) OR 409 — pick **idempotent update** for catch-up retries |
| `partial: false` | `partial: true` | **409 `day_finalized`** — cannot reopen a completed day |

On accept with `partial: false`, set `finalized_at = datetime('now')` if not already set.

**Response:** `204 No Content`

### `GET /data/health/daily-summaries/latest`

Returns the row for the **most recent `date`** for the authenticated user (typically today when syncing).

**404** when no rows exist.

### `GET /data/health/daily-summaries`

HAL paginated list. Default sort: `date DESC, id DESC` (newest days first).

Query: `limit` (default 20, max 100), `before`, `after` (mutually exclusive UUID anchors on row `id`).

**Response envelope:**

```json
{
  "summaries": [ /* HealthDailySummary */ ],
  "_links": { "self": { "href": "..." }, "next": { "href": "..." } }
}
```

Per `docs/history/specs/2026-06-15-list-pagination-hal-design.md` and `AGENTS.md` list pagination rules.

---

## OpenAPI v2.0.0

Add to `info.version` and changelog. New schemas:

- `HealthMetric`
- `HealthMetrics`
- `HealthDailySummary`
- `UpsertHealthDailySummaryRequest`
- `HealthDailySummaryListResponse`

New tag: `health` (or under existing `data` tag — match location grouping).

**Not list endpoints:** `GET .../latest`, `POST` upsert.

---

## MCP tools

Bearer auth on `POST /mcp` (unchanged). All health tools require `username`.

### `get_user_health_today`

**Input:** `{ username: string }`

**Output (available):**

```json
{
  "available": true,
  "username": "roberto",
  "date": "2026-06-17",
  "timezone": "Europe/Lisbon",
  "partial": true,
  "synced_at": "2026-06-17T14:30:00.000Z",
  "metrics": { ... }
}
```

Resolves user's **latest summary row by `date`**. When today exists, returns today; otherwise most recent day (skill may note staleness).

**Output (unavailable):** `{ "available": false, "username": "roberto" }`

### `get_user_health_daily`

**Input:** `{ username: string, date: string }` — `date` is `YYYY-MM-DD`

**Output:** same shape as today tool, or `{ "available": false, "username", "date" }` when no row.

### `get_user_health_history`

**Input:** `{ username: string, limit?: number, before?: string, after?: string }`

**Output:** HAL envelope mirroring REST:

```json
{
  "summaries": [ ... ],
  "_links": { "self": { "href": "/data/health/daily-summaries?limit=20" }, ... }
}
```

`href` paths mirror REST for skill documentation.

---

## Hermes skill: `companion-user-health`

**Path:** `data/skills/companion-user-health/SKILL.md`  
**Type:** Data skill (no presentation fences)

### Tools

- `get_user_health_today`
- `get_user_health_daily`
- `get_user_health_history`

### Internal record: `HealthDayRecord`

Normalize MCP responses before handing to presentation skills:

```yaml
available: true
username: <string>
date: <YYYY-MM-DD>
timezone: <IANA>
partial: <boolean>
synced_at: <ISO-8601>
metrics:
  steps: { value, goal, remaining, unit }
  ...
```

When `available: false` → plain-text unavailable message via `companion-replies`.

### Presentation

- **Consumers:** `companion-replies`, `companion-markdown-blocks` for ring progress tables
- **Routing:** add health intents to `companion-app` index (location + health data skills)

### Username resolution

Same rules as `companion-user-location`.

---

## Files (implementation preview)

```
messaging-api/
  src/db/schema.ts
  src/db/repos/health-daily-summaries.ts
  src/routes/data-health.ts
  src/services/mcp-tools.ts
  src/routes/mcp.ts
  test/data-health.test.ts
  test/mcp.test.ts

data/skills/companion-user-health/SKILL.md
data/skills/companion-app/SKILL.md          — add health routing rows
docs/superpowers/specs/messaging-api.openapi.yaml
```

---

## Testing

| Case | Expectation |
|------|-------------|
| POST upsert today `partial: true` | insert; GET latest returns it |
| POST upsert same day again | update `synced_at`, metrics |
| POST finalize day `partial: false` | `finalized_at` set |
| POST `partial: true` on finalized day | 409 `day_finalized` |
| GET history empty | HAL envelope, empty `summaries` |
| GET history pagination | `before` / `after` anchors |
| MCP `get_user_health_today` | mirrors latest row |
| MCP `get_user_health_daily` missing date | `available: false` |
| MCP history | `_links` on summaries collection |
| Invalid `remaining` vs goal | 400 |

---

## Non-goals (backend)

- iOS HealthKit integration
- Batch upsert endpoint
- Server-side gap finalization
- Storing raw HealthKit samples