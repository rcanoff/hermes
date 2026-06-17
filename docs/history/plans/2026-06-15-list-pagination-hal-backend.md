# List Pagination (HAL `_links`) — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, skills, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. Client impact is documented in the spec and `2026-06-15-list-pagination-hal-ios.md` for the `assistant-companion` repo.

> **HARD RULE — OpenAPI gate:** Every contract change in this plan must update `docs/superpowers/specs/messaging-api.openapi.yaml`. A task is not done until OpenAPI matches the shipped behavior.

**Goal:** Standardize **all three REST list endpoints** and MCP `get_location_history` on HAL `_links` pagination with `before`/`after` anchors and relative `href` links.

**Architecture:** Shared `buildHalLinks` helper. Repo page functions return `hasOlder`/`hasNewer`. Channel lists (conversations, messages tail) plus location history (newest-first) and matching MCP tool output. OpenAPI v1.6.0. `AGENTS.md` documents the rule for future list endpoints.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/history/specs/2026-06-15-list-pagination-hal-design.md`  
**Client plan (reference only):** `docs/history/plans/2026-06-15-list-pagination-hal-ios.md`

---

## File Structure

```
messaging-api/
  src/
    lib/
      pagination.ts                 — MODIFY: before/after validation, buildHalLinks()
    db/repos/
      conversations.ts              — MODIFY: listConversationsPage uses before/after
      messages.ts                   — MODIFY: listMessagesPage uses before/after
      location-events.ts            — MODIFY: listLocationEventsPage (+ after anchor)
    routes/
      conversations.ts              — MODIFY: HAL response envelope
      messages.ts                   — MODIFY: HAL response envelope
      data-location.ts              — MODIFY: HAL response envelope
      mcp.ts                        — MODIFY: get_location_history adds after arg
    services/
      mcp-tools.ts                  — MODIFY: HAL result for get_location_history
  test/
    conversations.test.ts           — MODIFY: HAL assertions
    messages.test.ts                — MODIFY: HAL assertions
    data-location.test.ts           — MODIFY: HAL assertions (replace bare events)
    mcp.test.ts                     — MODIFY: _links on get_location_history
  scripts/
    smoke-test.mjs                  — MODIFY: _links checks

AGENTS.md                                         — MODIFY: list pagination rule (done in spec pass)
docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v1.6.0 schemas (all list endpoints)
data/skills/companion-user-location/SKILL.md      — MODIFY: _links on get_location_history
README.md                                         — MODIFY: v1.6.0 note (all list endpoints)
```

---

## Task 1: Link builder and query parsing

**Files:**
- Modify: `messaging-api/src/lib/pagination.ts`
- Create: `messaging-api/test/pagination.test.ts`

- [ ] **Step 1: Write failing tests for buildHalLinks**

Create `messaging-api/test/pagination.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../src/lib/pagination.js'

describe('pagination helpers', () => {
  it('parses default limit', () => {
    expect(parsePageLimit(undefined)).toBe(20)
  })

  it('rejects both before and after', () => {
    expect(parseListAnchors({ before: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', after: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toBeNull()
  })

  it('builds self next and prev links', () => {
    const links = buildHalLinks({
      basePath: '/conversations',
      limit: 20,
      before: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      hasOlder: true,
      hasNewer: true,
      firstId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      lastId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })

    expect(links.self.href).toBe('/conversations?limit=20&before=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(links.next?.href).toBe('/conversations?limit=20&before=dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    expect(links.prev?.href).toBe('/conversations?limit=20&after=cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  })

  it('omits next when no older items', () => {
    const links = buildHalLinks({
      basePath: '/conversations',
      limit: 20,
      hasOlder: false,
      hasNewer: false,
      firstId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      lastId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })

    expect(links.next).toBeUndefined()
    expect(links.prev).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/pagination.test.ts`  
Expected: FAIL — `buildHalLinks` / `parseListAnchors` not exported

- [ ] **Step 3: Implement pagination helpers**

Replace `messaging-api/src/lib/pagination.ts` with:

```typescript
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface HalLink {
  href: string
}

export interface HalLinks {
  self: HalLink
  next?: HalLink
  prev?: HalLink
}

export function parsePageLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
    return null
  }

  return parsed
}

export function isValidAnchor(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function parseListAnchors(query: {
  before?: string
  after?: string
}): { before?: string; after?: string } | null {
  const hasBefore = query.before !== undefined
  const hasAfter = query.after !== undefined

  if (hasBefore && hasAfter) {
    return null
  }

  if (hasBefore && !isValidAnchor(query.before)) {
    return null
  }

  if (hasAfter && !isValidAnchor(query.after)) {
    return null
  }

  return {
    before: query.before,
    after: query.after,
  }
}

interface BuildHalLinksInput {
  basePath: string
  limit: number
  before?: string
  after?: string
  hasOlder: boolean
  hasNewer: boolean
  firstId?: string
  lastId?: string
}

export function buildHalLinks(input: BuildHalLinksInput): HalLinks {
  const params = new URLSearchParams()
  params.set('limit', String(input.limit))
  if (input.before) {
    params.set('before', input.before)
  }
  if (input.after) {
    params.set('after', input.after)
  }

  const links: HalLinks = {
    self: { href: `${input.basePath}?${params.toString()}` },
  }

  if (input.hasOlder && input.lastId) {
    const nextParams = new URLSearchParams()
    nextParams.set('limit', String(input.limit))
    nextParams.set('before', input.lastId)
    links.next = { href: `${input.basePath}?${nextParams.toString()}` }
  }

  if (input.hasNewer && input.firstId) {
    const prevParams = new URLSearchParams()
    prevParams.set('limit', String(input.limit))
    prevParams.set('after', input.firstId)
    links.prev = { href: `${input.basePath}?${prevParams.toString()}` }
  }

  return links
}
```

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/pagination.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/lib/pagination.ts messaging-api/test/pagination.test.ts
git commit -m "feat(api): add HAL link builder and before/after anchor parsing"
```

---

## Task 2: Repository pagination — before/after

**Files:**
- Modify: `messaging-api/src/db/repos/conversations.ts`
- Modify: `messaging-api/src/db/repos/messages.ts`

- [ ] **Step 1: Update ConversationPage type and listConversationsPage signature**

Change `listConversationsPage` to accept `{ before?: string; after?: string }` instead of `cursorId` + `PageDirection`:

```typescript
export interface ConversationPage {
  conversations: ConversationRow[]
  hasOlder: boolean
  hasNewer: boolean
}

export function listConversationsPage(
  db: Database.Database,
  userId: string,
  limit: number,
  anchors: { before?: string; after?: string } = {},
): ConversationPage | null {
  if (anchors.before) {
    const cursor = getConversationForUser(db, userId, anchors.before)
    if (!cursor) return null
    const conversations = db.prepare(`... WHERE updated_at < ? OR ... LIMIT ?`).all(...) as ConversationRow[]
    return buildConversationPage(db, userId, conversations)
  }

  if (anchors.after) {
    const cursor = getConversationForUser(db, userId, anchors.after)
    if (!cursor) return null
    const conversations = db.prepare(`... WHERE updated_at > ? OR ... ORDER BY updated_at ASC LIMIT ?`).all(...) as ConversationRow[]
    conversations.reverse()
    return buildConversationPage(db, userId, conversations)
  }

  const conversations = db.prepare(`... ORDER BY updated_at DESC LIMIT ?`).all(userId, limit) as ConversationRow[]
  return buildConversationPage(db, userId, conversations)
}
```

Update `buildConversationPage` to return `hasOlder` / `hasNewer` booleans instead of cursor ids (reuse existing EXISTS queries).

- [ ] **Step 2: Same for listMessagesPage**

Mirror pattern with `before` / `after` and tail default when no anchors.

- [ ] **Step 3: Run repo-related tests**

Run: `cd messaging-api && npm test -- test/conversations.test.ts test/messages.test.ts`  
Expected: FAIL on old cursor/direction expectations (expected at this step)

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/db/repos/conversations.ts messaging-api/src/db/repos/messages.ts
git commit -m "refactor(api): repo pagination uses before/after anchors"
```

---

## Task 3: Location events repo — bidirectional page

**Files:**
- Modify: `messaging-api/src/db/repos/location-events.ts`

- [ ] **Step 1: Add LocationEventPage type and listLocationEventsPage**

Replace forward-only `listLocationEvents` usage in routes/MCP with:

```typescript
export interface LocationEventPage {
  events: LocationEventRow[]
  hasOlder: boolean
  hasNewer: boolean
}

export function listLocationEventsPage(
  db: Database.Database,
  userId: string,
  limit: number,
  anchors: { before?: string; after?: string } = {},
): LocationEventPage | null {
  if (anchors.before) {
    const cursor = getLocationEventById(db, anchors.before)
    if (!cursor || cursor.user_id !== userId) return null
    const events = db.prepare(`
      SELECT * FROM location_events
      WHERE user_id = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(userId, cursor.timestamp, limit) as LocationEventRow[]
    return buildLocationEventPage(db, userId, events)
  }

  if (anchors.after) {
    const cursor = getLocationEventById(db, anchors.after)
    if (!cursor || cursor.user_id !== userId) return null
    const events = db.prepare(`
      SELECT * FROM location_events
      WHERE user_id = ? AND timestamp > ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(userId, cursor.timestamp, limit) as LocationEventRow[]
    events.reverse()
    return buildLocationEventPage(db, userId, events)
  }

  const events = db.prepare(`
    SELECT * FROM location_events
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(userId, limit) as LocationEventRow[]

  return buildLocationEventPage(db, userId, events)
}
```

Keep `listLocationEvents` as a thin wrapper or remove after migrating callers.

- [ ] **Step 2: Commit**

```bash
git add messaging-api/src/db/repos/location-events.ts
git commit -m "refactor(api): location events page query with before/after"
```

---

## Task 4: Routes return HAL envelope

**Files:**
- Modify: `messaging-api/src/routes/conversations.ts`
- Modify: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/src/routes/data-location.ts`

- [ ] **Step 1: Update conversations route**

```typescript
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'

app.get('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
  const query = request.query as { limit?: string; before?: string; after?: string }
  const limit = parsePageLimit(query.limit)
  if (limit === null) {
    return reply.code(400).send({ error: 'invalid_request' })
  }

  const anchors = parseListAnchors(query)
  if (anchors === null) {
    return reply.code(400).send({ error: 'invalid_request' })
  }

  const page = listConversationsPage(app.db, request.userId, limit, anchors)
  if (!page) {
    return reply.code(400).send({ error: 'invalid_request' })
  }

  const firstId = page.conversations[0]?.id
  const lastId = page.conversations[page.conversations.length - 1]?.id

  return {
    conversations: page.conversations,
    _links: buildHalLinks({
      basePath: '/conversations',
      limit,
      before: anchors.before,
      after: anchors.after,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      firstId,
      lastId,
    }),
  }
})
```

- [ ] **Step 2: Update messages route**

Same pattern; `basePath` = `/conversations/${conversation.id}/messages`.

- [ ] **Step 3: Update data-location route**

```typescript
app.get('/data/location/events', { preHandler: app.authenticate }, async (request, reply) => {
  const query = request.query as { limit?: string; before?: string; after?: string }
  const limit = parsePageLimit(query.limit)
  if (limit === null) return reply.code(400).send({ error: 'invalid_request' })

  const anchors = parseListAnchors(query)
  if (anchors === null) return reply.code(400).send({ error: 'invalid_request' })

  const page = listLocationEventsPage(app.db, request.userId, limit, anchors)
  if (!page) return reply.code(400).send({ error: 'invalid_request' })

  const firstId = page.events[0]?.id
  const lastId = page.events[page.events.length - 1]?.id

  return {
    events: page.events.map(serializeLocationEvent),
    _links: buildHalLinks({
      basePath: '/data/location/events',
      limit,
      before: anchors.before,
      after: anchors.after,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      firstId,
      lastId,
    }),
  }
})
```

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/routes/conversations.ts messaging-api/src/routes/messages.ts messaging-api/src/routes/data-location.ts
git commit -m "feat(api): HAL _links on all REST list endpoints"
```

---

## Task 5: MCP get_location_history HAL parity

**Files:**
- Modify: `messaging-api/src/services/mcp-tools.ts`
- Modify: `messaging-api/src/routes/mcp.ts`

- [ ] **Step 1: Add after to MCP tool schema**

In `mcp.ts`, extend `get_location_history` inputSchema:

```typescript
after: z.string().optional().describe('Optional event id — page newer than this anchor'),
```

Reject when both `before` and `after` are set (handler or shared validator).

- [ ] **Step 2: Return HAL envelope from mcp-tools**

```typescript
async get_location_history(input) {
  const user = resolveUserByUsername(db, input.username)
  if (input.before && input.after) throw new Error('invalid_request')

  const limit = clampHistoryLimit(input.limit)
  const page = listLocationEventsPage(db, user.id, limit, {
    before: input.before,
    after: input.after,
  })
  if (!page) throw new Error('invalid_request')

  const firstId = page.events[0]?.id
  const lastId = page.events[page.events.length - 1]?.id

  return {
    events: page.events.map(serializeHistoryEvent),
    _links: buildHalLinks({
      basePath: '/data/location/events',
      limit,
      before: input.before,
      after: input.after,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      firstId,
      lastId,
    }),
  }
}
```

- [ ] **Step 3: Update mcp.test.ts**

Assert `get_location_history` returns `_links.self` and `next` on multi-event fixture; second call uses `before` from parsed `next.href` or passed explicitly.

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/services/mcp-tools.ts messaging-api/src/routes/mcp.ts messaging-api/test/mcp.test.ts
git commit -m "feat(mcp): HAL _links on get_location_history"
```

---

## Task 6: Route tests

**Files:**
- Modify: `messaging-api/test/conversations.test.ts`
- Modify: `messaging-api/test/messages.test.ts`
- Modify: `messaging-api/test/data-location.test.ts`

- [ ] **Step 1: Update existing list assertions**

Replace `next_cursor` / `prev_cursor` expectations with `_links`:

```typescript
expect(list.json()).toEqual({
  conversations: [create.json()],
  _links: {
    self: { href: '/conversations?limit=20' },
  },
})
```

- [ ] **Step 2: Update pagination test to follow hrefs**

```typescript
const firstPage = await app!.inject({
  method: 'GET',
  url: '/conversations?limit=2',
  headers: { authorization: `Bearer ${operatorToken}` },
})

expect(firstPage.json()).toMatchObject({
  conversations: [expect.objectContaining({ id: ids[4] }), expect.objectContaining({ id: ids[3] })],
  _links: {
    self: { href: '/conversations?limit=2' },
    next: { href: `/conversations?limit=2&before=${ids[3]}` },
  },
})

const secondPage = await app!.inject({
  method: 'GET',
  url: (firstPage.json() as { _links: { next: { href: string } } })._links.next.href,
  headers: { authorization: `Bearer ${operatorToken}` },
})
```

- [ ] **Step 3: Messages pagination test — prev link for older history**

Assert tail page has `_links.prev` and no `_links.next`. Following `prev.href` returns older slice with `_links.next` pointing back.

- [ ] **Step 4: Add validation tests**

```typescript
it('rejects before and after together', async () => {
  const response = await app!.inject({
    method: 'GET',
    url: `/conversations?before=${randomUUID()}&after=${randomUUID()}`,
    headers: { authorization: `Bearer ${operatorToken}` },
  })
  expect(response.statusCode).toBe(400)
})
```

- [ ] **Step 5: Update data-location.test.ts**

Replace:

```typescript
expect(firstPage.json()).toEqual({
  events: [ ... ],
})
```

With HAL shape:

```typescript
expect(firstPage.json()).toEqual({
  events: [ ... ],
  _links: {
    self: { href: '/data/location/events?limit=2' },
    next: { href: `/data/location/events?limit=2&before=${createdIds[1]}` },
  },
})
```

Add `after` back-navigation test following `_links.prev.href`.

- [ ] **Step 6: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add messaging-api/test/conversations.test.ts messaging-api/test/messages.test.ts messaging-api/test/data-location.test.ts
git commit -m "test(api): HAL _links on all list endpoints"
```

---

## Task 7: OpenAPI v1.6.0 (mandatory — contract gate)

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

This task is **blocking**. No backend pagination work ships without a matching OpenAPI bump. Verify every changed list route, query param, and response schema is documented.

- [ ] **Step 1: Bump version and changelog**

Add v1.6.0 entry:

```yaml
**v1.6.0 changes:** HAL `_links` pagination on all list endpoints:
`GET /conversations`, `GET /conversations/{id}/messages`, and
`GET /data/location/events`. Query params `limit` (default 20, max 100),
`before`, `after`. MCP `get_location_history` returns the same envelope.
Replaces bare array / events-only responses.
```

- [ ] **Step 2: Add schemas**

```yaml
HalLink:
  type: object
  required: [href]
  properties:
    href:
      type: string
      example: /conversations?limit=20&before=uuid

HalLinks:
  type: object
  required: [self]
  properties:
    self:
      $ref: '#/components/schemas/HalLink'
    next:
      $ref: '#/components/schemas/HalLink'
    prev:
      $ref: '#/components/schemas/HalLink'

ConversationListResponse:
  type: object
  required: [conversations, _links]
  properties:
    conversations:
      type: array
      items:
        $ref: '#/components/schemas/Conversation'
    _links:
      $ref: '#/components/schemas/HalLinks'

MessageListResponse:
  type: object
  required: [messages, _links]
  properties:
    messages:
      type: array
      items:
        $ref: '#/components/schemas/Message'
    _links:
      $ref: '#/components/schemas/HalLinks'

LocationEventListResponse:
  type: object
  required: [events, _links]
  properties:
    events:
      type: array
      items:
        $ref: '#/components/schemas/LocationEvent'
    _links:
      $ref: '#/components/schemas/HalLinks'
```

Remove or deprecate bare `LocationEventList` schema (events-only).

- [ ] **Step 3: Update all three GET list endpoints**

Add query parameters `limit`, `before`, `after` and paginated response schemas. Update `GET /data/location/events` 200 from `LocationEventList` to `LocationEventListResponse`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs: messaging-api OpenAPI v1.6.0 HAL list pagination"
```

---

## Task 8: Skill, smoke test, README

**Files:**
- Modify: `messaging-api/scripts/smoke-test.mjs`
- Modify: `data/skills/companion-user-location/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update smoke test**

```javascript
const conversationsBefore = listBefore.json.conversations ?? []
if (listBefore.json._links?.self?.href) {
  pass('conversation list returns HAL self link')
}
// After MCP get_location_history: assert result._links?.self
```

- [ ] **Step 2: Update companion-user-location skill**

Document that `get_location_history` returns `{ events, _links }`. To load older events, re-call with `before` from `_links.next.href` query string (or pass `after` for newer page).

- [ ] **Step 3: README note**

```markdown
**API (v1.6.0):** All list endpoints return HAL paginated responses (`_links.self|next|prev`): `GET /conversations`, `GET /conversations/:id/messages`, `GET /data/location/events`. Default `limit=20`, max 100. See OpenAPI and AGENTS.md.
```

- [ ] **Step 3: Run smoke test against local instance (if running)**

Run: `node messaging-api/scripts/smoke-test.mjs`  
Expected: list checks pass

- [ ] **Step 4: Commit**

```bash
git add messaging-api/scripts/smoke-test.mjs README.md
git commit -m "docs: smoke test and README for v1.6.0 HAL pagination"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|------------------|------|
| HAL `_links` with relative `href` | Task 1, 4, 5 |
| `before` / `after` anchors | Task 1, 2, 3 |
| Default limit 20, max 100 | Task 1 |
| Conversations newest-first | Task 2 |
| Messages tail default | Task 2 |
| Location events newest-first + HAL | Task 3, 4, 6 |
| MCP `get_location_history` parity | Task 5 |
| No counts | Task 1 |
| OpenAPI v1.6.0 (all list endpoints) | Task 7 |
| AGENTS.md list pagination rule | Done in spec pass |
| companion-user-location skill | Task 8 |
| Internal full-history unchanged | Verify — no edits to `listMessages` run paths |
| Breaking change documented | Task 7, 8 |
| iOS not implemented in hermes | Hard rule — reference plan only |
| OpenAPI gate enforced | Task 7 blocking |