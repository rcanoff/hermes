# Companion User Data Vault — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve `messaging-api` into a unified companion backend with a user-scoped location vault (`/data/location/*`), MCP tools for Hermes, async address enrichment, and removal of conversation-scoped location injection.

**Architecture:** Append-only `location_events` per user; REST ingest via JWT; MCP read via bearer token (single-operator). Address enrichment uses Hermes LLM when the client omits `address`. Chat channel unchanged except location is fully removed from conversations and prompts.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, `@fastify/jwt`, `@modelcontextprotocol/sdk`, `zod`, Vitest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-06-13-companion-user-data-vault-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v1.5.0)

---

## File Structure

```
messaging-api/
  package.json                              — add @modelcontextprotocol/sdk, zod
  src/
    config.ts                               — COMPANION_MCP_BEARER_TOKEN, enrichment session id
    types.ts                                — extend AppOptions
    db/
      schema.ts                             — location_events; drop conversation_locations
      repos/
        location-events.ts                  — NEW: insert, latest, history, update address
    routes/
      data-location.ts                      — NEW: /data/location/*
      mcp.ts                                  — NEW: POST /mcp bearer MCP server
    services/
      freshness.ts                          — NEW: "12 min ago" helper
      address-enrichment.ts                 — NEW: Hermes LLM geocode + queue
      mcp-tools.ts                          — NEW: get_user_location, get_location_history
      prompt-builder.ts                     — REMOVE location injection
      run-executor.ts                       — REMOVE getConversationLocation call
    app.ts                                  — register data-location + mcp; drop old location routes
  test/
    data-location.test.ts                   — NEW
    mcp.test.ts                             — NEW
    address-enrichment.test.ts              — NEW
    startup.test.ts                         — UPDATE: no location injection
    run-executor.test.ts                    — UPDATE: no location in prompt
    db.test.ts                              — UPDATE: location_events table
    locations.test.ts                       — DELETE

data/skills/companion-user-location/SKILL.md   — NEW
data/skills/smart-home/roberto-location-source/ — DELETE

docker-compose.yml                          — COMPANION_MCP_BEARER_TOKEN env
.env.example                                — COMPANION_MCP_BEARER_TOKEN
README.md                                   — vault + MCP setup
docs/superpowers/specs/messaging-api.openapi.yaml — v1.5.0 (already drafted)
```

---

## Task 1: OpenAPI v1.5.0 baseline

**Files:**
- Verify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Confirm v1.5.0 documents `/data/location/*`**

Check the file includes:
- `POST /data/location/events` with `LocationEventRequest` (`trigger`, optional `address`)
- `GET /data/location/events` with `limit` and `before` query params
- `GET /data/location/latest`
- No `/conversations/{id}/location` paths
- Tag `data-location`

- [ ] **Step 2: Commit OpenAPI if not already committed**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs: messaging-api OpenAPI v1.5.0 location data vault"
```

---

## Task 2: Schema and location-events repository

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Create: `messaging-api/src/db/repos/location-events.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing db test for location_events**

Add to `messaging-api/test/db.test.ts`:

```typescript
it('creates location_events table', () => {
  const tables = app.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>
  expect(tables.map((t) => t.name)).toContain('location_events')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npx vitest run test/db.test.ts -t "location_events"`
Expected: FAIL — table missing

- [ ] **Step 3: Add location_events to schema; remove conversation_locations**

In `messaging-api/src/db/schema.ts`, replace `conversation_locations` DDL with:

```sql
CREATE TABLE IF NOT EXISTS location_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  accuracy_m REAL NOT NULL,
  timestamp TEXT NOT NULL,
  trigger TEXT NOT NULL,
  source TEXT NOT NULL,
  address TEXT,
  address_source TEXT,
  address_status TEXT NOT NULL DEFAULT 'resolved',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_location_events_user_timestamp
  ON location_events (user_id, timestamp DESC);
```

Remove `conversation_locations` from the schema init list in tests if enumerated.

- [ ] **Step 4: Create `location-events.ts` repository**

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface LocationEventInput {
  userId: string
  lat: number
  lon: number
  accuracyM: number
  timestamp: string
  trigger: string
  source: string
  address?: string
}

export interface LocationEventRow {
  id: string
  user_id: string
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
  trigger: string
  source: string
  address: string | null
  address_source: string | null
  address_status: string
  created_at: string
}

export function insertLocationEvent(db: Database.Database, input: LocationEventInput): LocationEventRow {
  const id = randomUUID()
  const hasAddress = typeof input.address === 'string' && input.address.trim().length > 0

  db.prepare(`
    INSERT INTO location_events (
      id, user_id, lat, lon, accuracy_m, timestamp, trigger, source,
      address, address_source, address_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.lat,
    input.lon,
    input.accuracyM,
    input.timestamp,
    input.trigger,
    input.source,
    hasAddress ? input.address!.trim() : null,
    hasAddress ? 'ios' : null,
    hasAddress ? 'resolved' : 'pending',
  )

  return getLocationEventById(db, id)!
}

export function getLocationEventById(db: Database.Database, id: string): LocationEventRow | undefined {
  return db.prepare(`SELECT * FROM location_events WHERE id = ?`).get(id) as LocationEventRow | undefined
}

export function getLatestLocationEvent(db: Database.Database, userId: string): LocationEventRow | undefined {
  return db
    .prepare(`
      SELECT * FROM location_events
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `)
    .get(userId) as LocationEventRow | undefined
}

export function listLocationEvents(
  db: Database.Database,
  userId: string,
  limit: number,
  beforeId?: string,
): LocationEventRow[] {
  if (beforeId) {
    const cursor = getLocationEventById(db, beforeId)
    if (!cursor) return []
    return db
      .prepare(`
        SELECT * FROM location_events
        WHERE user_id = ? AND timestamp < ?
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .all(userId, cursor.timestamp, limit) as LocationEventRow[]
  }

  return db
    .prepare(`
      SELECT * FROM location_events
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    .all(userId, limit) as LocationEventRow[]
}

export function updateLocationEventAddress(
  db: Database.Database,
  id: string,
  address: string,
  addressSource: 'server',
  addressStatus: 'resolved' | 'failed',
): void {
  db.prepare(`
    UPDATE location_events
    SET address = ?, address_source = ?, address_status = ?
    WHERE id = ?
  `).run(address, addressSource, addressStatus, id)
}
```

- [ ] **Step 5: Run db test**

Run: `cd messaging-api && npx vitest run test/db.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/src/db/repos/location-events.ts messaging-api/test/db.test.ts
git commit -m "feat: add location_events schema and repository"
```

---

## Task 3: REST routes `/data/location/*`

**Files:**
- Create: `messaging-api/src/routes/data-location.ts`
- Modify: `messaging-api/src/app.ts`
- Create: `messaging-api/test/data-location.test.ts`
- Delete: `messaging-api/src/routes/locations.ts`
- Delete: `messaging-api/test/locations.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `messaging-api/test/data-location.test.ts` covering:
- `POST /data/location/events` — 204 with valid payload (with and without address)
- `POST` — 400 on invalid `trigger` or timestamp
- `GET /data/location/latest` — 200 after insert, 404 when empty
- `GET /data/location/events?limit=2` — returns newest first
- JWT required — 401 without token
- User isolation — user B cannot read user A's latest

Use patterns from `test/locations.test.ts` for auth setup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd messaging-api && npx vitest run test/data-location.test.ts`
Expected: FAIL — route not found

- [ ] **Step 3: Implement `data-location.ts`**

Validation mirrors old `locations.ts` lat/lon/accuracy/timestamp checks. Add `trigger` enum validation and optional `address` string.

```typescript
// POST returns 204, calls insertLocationEvent, then if address_status pending:
//   addressEnrichmentQueue.enqueue(eventId)
```

Register in `app.ts`:
```typescript
import dataLocationRoutes from './routes/data-location.js'
// remove locationRoutes
app.register(dataLocationRoutes)
```

- [ ] **Step 4: Remove old conversation location routes**

Delete `src/routes/locations.ts`, `test/locations.test.ts`.
Remove `getConversationLocation` usage from `conversations.ts` delete cascade.

- [ ] **Step 5: Run all messaging-api tests**

Run: `cd messaging-api && npx vitest run`
Expected: PASS (update `startup.test.ts` and `run-executor.test.ts` in Task 4 if still failing)

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/routes/data-location.ts messaging-api/src/app.ts messaging-api/test/data-location.test.ts
git add messaging-api/src/db/repos/conversations.ts
git rm messaging-api/src/routes/locations.ts messaging-api/test/locations.test.ts
git commit -m "feat: add user-scoped /data/location routes; remove conversation location"
```

---

## Task 4: Remove location from chat channel

**Files:**
- Modify: `messaging-api/src/services/prompt-builder.ts`
- Modify: `messaging-api/src/services/run-executor.ts`
- Modify: `messaging-api/test/startup.test.ts`
- Modify: `messaging-api/test/run-executor.test.ts`
- Delete: `messaging-api/src/db/repos/locations.ts`

- [ ] **Step 1: Update failing startup test**

Remove location injection expectation from `test/startup.test.ts`. Assert `buildHermesMessages(history)` returns transcript only.

- [ ] **Step 2: Simplify prompt-builder**

```typescript
export function buildHermesMessages(history: TranscriptMessage[]): HermesPromptMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}
```

Remove `LocationContext` interface.

- [ ] **Step 3: Simplify run-executor**

Remove `getConversationLocation` import and call; pass history only to `buildHermesMessages`.

- [ ] **Step 4: Delete `src/db/repos/locations.ts`**

- [ ] **Step 5: Run tests**

Run: `cd messaging-api && npx vitest run test/startup.test.ts test/run-executor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/services/prompt-builder.ts messaging-api/src/services/run-executor.ts messaging-api/test/
git rm messaging-api/src/db/repos/locations.ts
git commit -m "refactor: remove conversation location injection from chat channel"
```

---

## Task 5: Freshness helper

**Files:**
- Create: `messaging-api/src/services/freshness.ts`
- Create: `messaging-api/test/freshness.test.ts`

- [ ] **Step 1: Write failing freshness tests**

```typescript
import { describe, expect, it } from 'vitest'
import { formatFreshness } from '../src/services/freshness.js'

describe('formatFreshness', () => {
  it('returns "just now" for under 60 seconds', () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    expect(formatFreshness('2026-06-13T09:59:30.000Z', now)).toBe('just now')
  })

  it('returns minutes ago', () => {
    const now = new Date('2026-06-13T10:00:00.000Z')
    expect(formatFreshness('2026-06-13T09:48:00.000Z', now)).toBe('12 min ago')
  })
})
```

- [ ] **Step 2: Implement `formatFreshness`**

- [ ] **Step 3: Run tests and commit**

```bash
git add messaging-api/src/services/freshness.ts messaging-api/test/freshness.test.ts
git commit -m "feat: add location freshness formatter"
```

---

## Task 6: Address enrichment worker

**Files:**
- Create: `messaging-api/src/services/address-enrichment.ts`
- Create: `messaging-api/test/address-enrichment.test.ts`

- [ ] **Step 1: Write failing enrichment test**

Test with fake `HermesClient` that returns `"Rua Example 1, Lisbon"` for the geocode prompt. Assert pending event becomes `address_status: resolved`.

- [ ] **Step 2: Implement enrichment queue**

```typescript
export class AddressEnrichmentQueue {
  constructor(
    private readonly db: Database.Database,
    private readonly hermesClient: HermesClient,
    private readonly sessionId: string,
  ) {}

  enqueue(eventId: string): void {
    setImmediate(() => void this.process(eventId))
  }

  private async process(eventId: string): Promise<void> {
    const event = getLocationEventById(this.db, eventId)
    if (!event || event.address_status !== 'pending') return

    try {
      const address = await this.reverseGeocode(event.lat, event.lon)
      updateLocationEventAddress(this.db, eventId, address, 'server', 'resolved')
    } catch {
      updateLocationEventAddress(this.db, eventId, '', 'server', 'failed')
    }
  }

  private async reverseGeocode(lat: number, lon: number): Promise<string> {
    // Non-streaming Hermes chat completion; dedicated session id from config
    // Prompt: "Return only a single-line postal address for lat {lat} lon {lon}. No other text."
  }
}
```

Wire queue in `buildApp` and pass to data-location route via `app.decorate('addressEnrichmentQueue', ...)`.

- [ ] **Step 3: Add config**

In `config.ts`:
```typescript
companionMcpBearerToken: env.COMPANION_MCP_BEARER_TOKEN ?? '',
addressEnrichmentSessionId: env.ADDRESS_ENRICHMENT_SESSION_ID ?? 'companion-address-enrichment',
```

- [ ] **Step 4: Run tests and commit**

```bash
git add messaging-api/src/services/address-enrichment.ts messaging-api/src/config.ts messaging-api/src/types.ts messaging-api/test/address-enrichment.test.ts
git commit -m "feat: add async Hermes LLM address enrichment"
```

---

## Task 7: MCP server and tools

**Files:**
- Create: `messaging-api/src/services/mcp-tools.ts`
- Create: `messaging-api/src/routes/mcp.ts`
- Modify: `messaging-api/package.json` — add `@modelcontextprotocol/sdk`, `zod`
- Create: `messaging-api/test/mcp.test.ts`

- [ ] **Step 1: Write failing MCP tests**

Test `POST /mcp` with:
- Missing bearer → 401
- Valid bearer + `tools/call` `get_user_location` when empty → `{ available: false }`
- After inserting event for bootstrap user → returns `available: true` with `freshness`

Use MCP JSON-RPC format or Streamable HTTP per `@modelcontextprotocol/sdk` (mirror `apple-caldav-mcp/src/server.ts`).

- [ ] **Step 2: Implement MCP route**

Single-operator: resolve operator user as bootstrap user (`findUserByUsername`). MCP tools read that user's events.

`get_user_location` response shape per design spec.
`get_location_history` accepts `limit` (default 20, max 100) and optional `before` event id.

- [ ] **Step 3: Register route in app.ts**

```typescript
import mcpRoutes from './routes/mcp.js'
app.register(mcpRoutes)
```

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm install && npx vitest run test/mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/package.json messaging-api/package-lock.json messaging-api/src/routes/mcp.ts messaging-api/src/services/mcp-tools.ts messaging-api/test/mcp.test.ts messaging-api/src/app.ts
git commit -m "feat: add companion MCP tools for user location vault"
```

---

## Task 8: Workspace integration

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add env vars**

`.env.example`:
```dotenv
COMPANION_MCP_BEARER_TOKEN=replace-with-long-random-token
ADDRESS_ENRICHMENT_SESSION_ID=companion-address-enrichment
```

`docker-compose.yml` messaging-api environment:
```yaml
COMPANION_MCP_BEARER_TOKEN: ${COMPANION_MCP_BEARER_TOKEN:-}
ADDRESS_ENRICHMENT_SESSION_ID: ${ADDRESS_ENRICHMENT_SESSION_ID:-companion-address-enrichment}
```

- [ ] **Step 2: Update README**

Add section under Messaging API:
- `/data/location/*` endpoints (link OpenAPI v1.5.0)
- `COMPANION_MCP_BEARER_TOKEN` setup
- Hermes MCP registration snippet
- Note: conversation location routes removed

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml .env.example README.md
git commit -m "docs: wire companion MCP token and location vault setup"
```

---

## Task 9: Hermes skill and cleanup

**Files:**
- Create: `data/skills/companion-user-location/SKILL.md`
- Delete: `data/skills/smart-home/roberto-location-source/` (entire directory)
- Delete: `data/skills/**/generic-location-refresh/` if present
- Modify: `data/config.yaml` — add companion MCP server (operator manual step documented in README)

- [ ] **Step 1: Create `companion-user-location` skill**

Content per design spec:
- Call `get_user_location` via companion MCP
- Four-line format when available
- Unavailable message when `available: false`
- Never use Home Assistant for location
- `get_location_history` for historical questions

- [ ] **Step 2: Delete HA location skills**

```bash
rm -rf data/skills/smart-home/roberto-location-source
# rm generic-location-refresh if found
```

- [ ] **Step 3: Document Hermes MCP config in README**

Operator adds to `data/config.yaml` and runs `/reload-mcp` or restarts Hermes.

- [ ] **Step 4: Commit**

```bash
git add data/skills/companion-user-location/SKILL.md README.md
git rm -r data/skills/smart-home/roberto-location-source
git commit -m "feat: add companion-user-location skill; remove HA location skills"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd messaging-api && npx vitest run`
Expected: all PASS

- [ ] **Step 2: Build container**

Run: `docker compose build messaging-api`
Expected: build succeeds

- [ ] **Step 3: Smoke test against running stack**

```bash
# login
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"..."}' | jq -r .token)

# ingest
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/data/location/events \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"lat":38.72,"lon":-9.14,"accuracy_m":10,"timestamp":"2026-06-13T12:00:00.000Z","trigger":"manual","source":"ios","address":"Lisbon"}'
# expect 204

# latest
curl -s http://localhost:3000/data/location/latest -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 4: Verify OpenAPI matches implementation**

Compare live routes to `docs/superpowers/specs/messaging-api.openapi.yaml` v1.5.0.

- [ ] **Step 5: Commit any final fixes**

```bash
git commit -m "chore: verify companion user data vault backend"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|-----------------|------|
| `/data/location/events` POST/GET | Task 3 |
| `/data/location/latest` GET | Task 3 |
| `location_events` schema | Task 2 |
| Remove conversation location | Tasks 3, 4 |
| MCP `get_user_location` | Task 7 |
| MCP `get_location_history` | Task 7 |
| Bearer MCP auth | Task 7 |
| Address enrichment (Hermes LLM) | Task 6 |
| `companion-user-location` skill | Task 9 |
| Delete HA location skills | Task 9 |
| OpenAPI v1.5.0 | Task 1 |
| docker/env/README | Task 8 |