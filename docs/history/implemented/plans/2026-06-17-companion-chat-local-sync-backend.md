# Companion Chat Local-First Sync — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. The iOS client (`assistant-companion`) should read this plan plus `docs/superpowers/specs/messaging-api.openapi.yaml` v2.1.0.

> **HARD RULE — OpenAPI gate:** Contract is pre-drafted at v2.1.0. Implementation must match `docs/superpowers/specs/messaging-api.openapi.yaml` exactly.

**Goal:** Add durable chat sync feeds (`GET /conversations/sync`, `GET /conversations/{id}/sync`) so the iOS app can open from SwiftData and reconcile committed server mutations incrementally.

**Architecture:** Append-only `chat_sync_events` table with two scopes (`account`, `conversation`). Mutation sites that already change conversations/messages emit typed events. Sync routes page events by opaque UUID marker (`event_id`). HAL list/history and SSE remain unchanged.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-17-companion-chat-local-sync-backend-design.md`

---

## Backend review decisions (answers for client agent)

| Question | Decision |
|----------|----------|
| Two feeds vs `/chat/sync`? | **Two feeds** as proposed |
| Marker format? | **UUID `event_id`** from `chat_sync_events.id` |
| Deleted thread sync? | **`200` + `conversation_deleted` event**; `404` only when no conversation and no sync tail |
| Schema work? | **New event log table** + wire existing mutation points; no message-ID schema change |

**Client integration summary:**

1. **Seed locally** with existing HAL routes (`GET /conversations`, `GET /conversations/{id}/messages`).
2. **Store markers** — one for account list, one per conversation. Always persist `next_sync_marker` from every successful `200` (including empty `events` pages).
3. **Reconcile** on launch, foreground, chat open, send/edit completion, pull-to-refresh.
4. **Paginate** sync responses while `has_more: true` using `since=<previous next_sync_marker>` before advancing stored marker.
5. **Apply thread snapshot** — even when `events` is empty, update local conversation metadata from `conversation` field (title-only changes).
6. **SSE unchanged** for live runs; sync is durable reconciliation after relaunch/background.
7. **Missing marker recovery:**
   - **Account:** call `GET /conversations/sync` with `since` omitted (self-heal from retained events).
   - **Thread:** HAL-rehydrate (`GET /conversations/{id}/messages`), then call thread sync with `since` omitted to establish tip marker.
8. **Invalid marker recovery:** on `400 { error: sync_marker_invalid }`, clear marker and repeat the missing-marker path for that scope.
9. **Retention (v2.1.0):** event log is append-only; server does not prune. `sync_marker_invalid` means unknown marker, not aged-out data.

---

## File Structure

```
messaging-api/
  src/
    db/schema.ts                         — MODIFY: chat_sync_events table + backfill hook
    db/repos/chat-sync-events.ts         — CREATE: append + list page helpers
    db/repos/conversations.ts            — MODIFY: touch updated_at on title changes
    lib/sync-marker.ts                   — CREATE: SYNC_MARKER_ORIGIN constant
    lib/conversation-sync-entry.ts       — CREATE: build list-visible sync row + snapshot
    services/chat-sync-emitter.ts        — CREATE: typed emit helpers
    routes/chat-sync.ts                  — CREATE: GET /conversations/sync, GET /conversations/:id/sync
    routes/conversations.ts              — MODIFY: emit on create/delete/title patch
    routes/messages.ts                   — MODIFY: (no route change; mutations wired elsewhere)
    services/message-editor.ts           — MODIFY: emit rewind + user upsert
    services/run-executor.ts             — MODIFY: emit assistant upsert
    services/title-generator.ts          — MODIFY: emit conversation upsert after auto-title
    app.ts                               — MODIFY: register chat-sync routes
  test/
    chat-sync.test.ts                    — CREATE: HTTP + event emission tests
    db.test.ts                           — MODIFY: chat_sync_events table assertion
    conversations.test.ts                — MODIFY: title patch bumps updated_at

docs/superpowers/specs/messaging-api.openapi.yaml — DONE: v2.1.0 sync contract
README.md                                          — MODIFY: local-first sync section
```

---

## Task 1: OpenAPI v2.1.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml` (**already updated in plan prep**)

- [x] **Step 1: Version bump and changelog** — `info.version: 2.1.0`
- [x] **Step 2: Schemas** — `ConversationSyncEntry`, account/thread event unions, response envelopes
- [x] **Step 3: Routes** — `GET /conversations/sync`, `GET /conversations/{id}/sync`

No further OpenAPI edits expected unless implementation reveals a gap.

---

## Task 2: Schema and one-time backfill

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing table test**

Add to `messaging-api/test/db.test.ts`:

```typescript
  it('includes chat_sync_events table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('chat_sync_events')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/db.test.ts -t "chat_sync_events"`  
Expected: FAIL — table missing

- [ ] **Step 3: Add table + backfill in schema**

Add after health tables in `initSchema` body, plus call `ensureChatSyncBackfill(db)` from `initSchema`:

```typescript
    CREATE TABLE IF NOT EXISTS chat_sync_events (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('account', 'conversation')),
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS chat_sync_events_account_idx
      ON chat_sync_events (user_id, occurred_at ASC, id ASC)
      WHERE scope = 'account';

    CREATE INDEX IF NOT EXISTS chat_sync_events_conversation_idx
      ON chat_sync_events (conversation_id, occurred_at ASC, id ASC)
      WHERE scope = 'conversation';
```

Add helper (imports from repo once it exists — stub inline first, refactor in Task 3):

```typescript
function ensureChatSyncBackfill(db: Database.Database): void {
  const done = db
    .prepare(`SELECT 1 FROM chat_sync_events LIMIT 1`)
    .get() as { 1: number } | undefined
  if (done) {
    return
  }

  const conversations = db
    .prepare(`SELECT id, user_id FROM conversations`)
    .all() as Array<{ id: string; user_id: string }>

  for (const row of conversations) {
    // Task 3 replaces with appendAccountConversationUpsert()
    backfillAccountConversationUpsert(db, row.user_id, row.id)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/db.test.ts -t "chat_sync_events"`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): add chat_sync_events schema and backfill hook"
```

---

## Task 3: Sync events repo

**Files:**
- Create: `messaging-api/src/db/repos/chat-sync-events.ts`
- Create: `messaging-api/test/chat-sync-events.test.ts`

- [ ] **Step 1: Write failing repo tests**

```typescript
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'
import {
  appendAccountConversationDeleted,
  appendAccountConversationUpsert,
  appendConversationMessageUpsert,
  appendConversationMessagesRewound,
  listAccountSyncEvents,
  listConversationSyncEvents,
} from '../src/db/repos/chat-sync-events.js'

describe('chat-sync-events repo', () => {
  it('lists account events after marker in stable order', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = '00000000-0000-4000-8000-000000000101'
    const conversationId = '00000000-0000-4000-8000-000000000201'
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)
    db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(conversationId, userId, '00000000-0000-4000-8000-000000000301')

    const first = appendAccountConversationUpsert(db, userId, conversationId, {
      id: conversationId,
      hermes_session_id: '00000000-0000-4000-8000-000000000301',
      title: null,
      created_at: '2026-06-17 10:00:00',
      updated_at: '2026-06-17 10:00:00',
      latest_message_id: null,
      latest_message_created_at: null,
    })
    const second = appendAccountConversationDeleted(db, userId, conversationId)

    const page = listAccountSyncEvents(db, userId, undefined, 100)
    expect(page.events).toHaveLength(2)
    expect(page.events[0]!.event_id).toBe(first.event_id)
    expect(page.events[1]!.event_id).toBe(second.event_id)
    expect(page.next_sync_marker).toBe(second.event_id)
    expect(page.has_more).toBe(false)

    const tail = listAccountSyncEvents(db, userId, first.event_id, 100)
    expect(tail.events).toHaveLength(1)
    expect(tail.events[0]!.type).toBe('conversation_deleted')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/chat-sync-events.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement repo**

Core types and append/list functions:

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type AccountSyncEvent =
  | {
      event_id: string
      type: 'conversation_upsert'
      occurred_at: string
      conversation: ConversationSyncEntryPayload
    }
  | {
      event_id: string
      type: 'conversation_deleted'
      occurred_at: string
      conversation_id: string
    }

export interface ConversationSyncEntryPayload {
  id: string
  hermes_session_id: string
  title: string | null
  created_at: string
  updated_at: string
  latest_message_id: string | null
  latest_message_created_at: string | null
}

export const SYNC_MARKER_ORIGIN = '00000000-0000-4000-8000-000000000000'

export interface SyncEventPage<T> {
  events: T[]
  next_sync_marker: string
  has_more: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function insertEvent(
  db: Database.Database,
  input: {
    scope: 'account' | 'conversation'
    userId: string
    conversationId: string
    eventType: string
    payload: unknown
  },
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO chat_sync_events (id, scope, user_id, conversation_id, event_type, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.scope,
    input.userId,
    input.conversationId,
    input.eventType,
    nowIso(),
    JSON.stringify(input.payload),
  )
  return id
}

export function appendAccountConversationUpsert(
  db: Database.Database,
  userId: string,
  conversationId: string,
  conversation: ConversationSyncEntryPayload,
): { event_id: string } {
  const event_id = insertEvent(db, {
    scope: 'account',
    userId,
    conversationId,
    eventType: 'conversation_upsert',
    payload: { conversation },
  })
  return { event_id }
}

// ... appendAccountConversationDeleted, appendConversationMessageUpsert,
// appendConversationMessagesRewound, appendConversationConversationDeleted,
// getSyncEventMarker, listAccountSyncEvents, listConversationSyncEvents
```

`list*SyncEvents` rules:

- Order by `occurred_at ASC, id ASC`
- `since` omitted or `since=SYNC_MARKER_ORIGIN` → start at oldest retained event
- `since` provided → events strictly after that marker; unknown marker (not in log, not origin) → return `null` (route maps to `400 { error: sync_marker_invalid }`)
- Fetch `limit + 1` rows to compute `has_more`
- `next_sync_marker` **always** set: last `event_id` in page when non-empty; when empty, `resolveFeedTip()` (latest retained event id in scope, or `SYNC_MARKER_ORIGIN`)

- [ ] **Step 4: Wire schema backfill to repo helper**

Replace inline backfill stub with `appendAccountConversationUpsert` using live conversation row + latest-message query.

- [ ] **Step 5: Run tests**

Run: `cd messaging-api && npm test -- test/chat-sync-events.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/db/repos/chat-sync-events.ts messaging-api/test/chat-sync-events.test.ts messaging-api/src/db/schema.ts
git commit -m "feat(messaging-api): add chat sync events repository"
```

---

## Task 4: Conversation sync entry builder + title `updated_at` fix

**Files:**
- Create: `messaging-api/src/lib/conversation-sync-entry.ts`
- Modify: `messaging-api/src/db/repos/conversations.ts`
- Modify: `messaging-api/test/conversations.test.ts`

- [ ] **Step 1: Write failing title ordering test**

Extend `conversations.test.ts` — after `PATCH` title, `updated_at` must increase and list order reflects change.

- [ ] **Step 2: Implement builder**

```typescript
import type Database from 'better-sqlite3'
import type { ConversationRow } from '../db/repos/conversations.js'
import type { ConversationSyncEntryPayload } from '../db/repos/chat-sync-events.js'

export function buildConversationSyncEntry(
  db: Database.Database,
  conversation: ConversationRow,
): ConversationSyncEntryPayload {
  const latest = db
    .prepare(`
      SELECT id, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(conversation.id) as { id: string; created_at: string } | undefined

  return {
    id: conversation.id,
    hermes_session_id: conversation.hermes_session_id,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    latest_message_id: latest?.id ?? null,
    latest_message_created_at: latest?.created_at ?? null,
  }
}
```

- [ ] **Step 3: Touch `updated_at` on title writes**

In `updateConversationTitle` and `updateConversationTitleIfNull`, call `touchConversationUpdatedAt(db, conversationId)` (or set `updated_at` in the same UPDATE).

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/conversations.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/lib/conversation-sync-entry.ts messaging-api/src/db/repos/conversations.ts messaging-api/test/conversations.test.ts
git commit -m "fix(messaging-api): bump updated_at on title changes and add sync entry builder"
```

---

## Task 5: Sync emitter service and mutation wiring

**Files:**
- Create: `messaging-api/src/services/chat-sync-emitter.ts`
- Modify: `messaging-api/src/db/repos/messages.ts`
- Modify: `messaging-api/src/db/repos/conversations.ts`
- Modify: `messaging-api/src/services/message-editor.ts`
- Modify: `messaging-api/src/services/run-executor.ts`
- Modify: `messaging-api/src/services/title-generator.ts`
- Modify: `messaging-api/src/routes/conversations.ts`

- [ ] **Step 1: Write failing emission test**

In `chat-sync.test.ts`:

```typescript
  it('emits account + conversation events when assistant message completes', async () => {
    const { app, token, conversationId } = await seedConversationWithUserMessage(app)
    await completeAssistantRun(app, conversationId)

    const list = await app.inject({
      method: 'GET',
      url: '/conversations/sync',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(list.json().events.some((e: { type: string }) => e.type === 'conversation_upsert')).toBe(true)

    const thread = await app.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/sync`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(thread.json().events.some((e: { type: string }) => e.type === 'message_upsert')).toBe(true)
  })
```

- [ ] **Step 2: Implement emitter**

```typescript
export function emitAccountConversationUpsert(db: Database.Database, userId: string, conversationId: string): void {
  const conversation = getConversationForUser(db, userId, conversationId)
  if (!conversation) return
  appendAccountConversationUpsert(db, userId, conversationId, buildConversationSyncEntry(db, conversation))
}

export function emitConversationMessageUpsert(
  db: Database.Database,
  userId: string,
  conversationId: string,
  message: MessageRow,
  process?: MessageProcess,
): void {
  appendConversationMessageUpsert(db, userId, conversationId, { ...message, ...(process ? { process } : {}) })
  emitAccountConversationUpsert(db, userId, conversationId)
}

export function emitConversationMessagesRewound(
  db: Database.Database,
  userId: string,
  conversationId: string,
  removedMessageIds: string[],
): void {
  appendConversationMessagesRewound(db, userId, conversationId, removedMessageIds)
  emitAccountConversationUpsert(db, userId, conversationId)
}
```

- [ ] **Step 3: Wire mutation sites**

| Site | Events emitted |
|------|----------------|
| `createConversation` (route) | account `conversation_upsert` |
| `insertMessage` (user) | conversation `message_upsert`, account `conversation_upsert` |
| `persistCompletedRun` (assistant) | conversation `message_upsert` (+ process), account `conversation_upsert` |
| `applyMessageEdit` | conversation `messages_rewound`, conversation `message_upsert` (edited user), account `conversation_upsert` |
| `deleteConversationForUser` | account `conversation_deleted`, conversation `conversation_deleted` |
| `updateConversationTitle` / auto-title | account `conversation_upsert` |

Pass `userId` into editor/executor paths from routes (already available as `request.userId`).

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/chat-sync.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/chat-sync-emitter.ts messaging-api/src/services/message-editor.ts messaging-api/src/services/run-executor.ts messaging-api/src/services/title-generator.ts messaging-api/src/routes/conversations.ts messaging-api/test/chat-sync.test.ts
git commit -m "feat(messaging-api): emit chat sync events from mutation sites"
```

---

## Task 6: Sync HTTP routes

**Files:**
- Create: `messaging-api/src/routes/chat-sync.ts`
- Modify: `messaging-api/src/app.ts`
- Modify: `messaging-api/test/chat-sync.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- account sync returns upsert + delete events in order
- thread sync returns rewind then replacement upserts after PATCH edit
- deleted conversation returns `200` + `conversation_deleted` on thread sync
- unknown `since` marker → `400 { error: sync_marker_invalid }`
- missing thread marker flow documented in tests (HAL hydrate → sync with omitted since → tip marker)
- `has_more` pagination loops
- thread sync returns updated `conversation.title` with empty `events` after title-only PATCH
- empty account sync page returns `next_sync_marker: SYNC_MARKER_ORIGIN` (or feed tip when caught up)
- empty thread sync page after HAL bootstrap returns `next_sync_marker` (origin or tip)

- [ ] **Step 2: Implement routes**

```typescript
const DEFAULT_ACCOUNT_SYNC_LIMIT = 100
const MAX_ACCOUNT_SYNC_LIMIT = 500
const DEFAULT_CONVERSATION_SYNC_LIMIT = 200
const MAX_CONVERSATION_SYNC_LIMIT = 1000

app.get('/conversations/sync', { preHandler: app.authenticate }, async (request, reply) => {
  const query = request.query as { since?: string; limit?: string }
  const limit = parseSyncLimit(query.limit, DEFAULT_ACCOUNT_SYNC_LIMIT, MAX_ACCOUNT_SYNC_LIMIT)
  if (limit === null) return reply.code(400).send({ error: 'invalid_request' })

  const page = listAccountSyncEvents(app.db, request.userId, query.since, limit)
  if (page === null) {
    return query.since
      ? reply.code(400).send({ error: 'sync_marker_invalid' })
      : reply.code(400).send({ error: 'invalid_request' })
  }

  return page
})

app.get('/conversations/:id/sync', { preHandler: app.authenticate }, async (request, reply) => {
  const conversationId = (request.params as { id: string }).id
  const existing = getConversationForUser(app.db, request.userId, conversationId)

  if (existing) {
    const page = buildConversationSyncResponse(app.db, request.userId, existing, querySince, limit)
    return page
  }

  const deletionPage = listConversationDeletionTail(app.db, request.userId, conversationId, querySince, limit)
  if (!deletionPage) return reply.code(404).send({ error: 'not_found' })
  return deletionPage
})
```

`buildConversationSyncResponse` must attach `process` on assistant `message_upsert` events (reuse `getProcessByAssistantMessageIds`).

- [ ] **Step 3: Register routes in `app.ts`**

```typescript
import chatSyncRoutes from './routes/chat-sync.js'
// ...
app.register(chatSyncRoutes)
```

- [ ] **Step 4: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/routes/chat-sync.ts messaging-api/src/app.ts messaging-api/test/chat-sync.test.ts
git commit -m "feat(messaging-api): add chat sync REST routes"
```

---

## Task 7: README and spec status

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-17-companion-chat-local-sync-backend-design.md` (**status already Approved**)

- [ ] **Step 1: Add README section**

Document:

- new sync routes and marker semantics
- HAL + SSE still required
- OpenAPI v2.1.0 reference
- no MCP tools for sync in v1

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document companion chat local-first sync API"
```

---

## Client agent checklist (iOS — built in `assistant-companion`)

Reference only; do not implement here.

- [ ] SwiftData models: `Conversation`, `Message`, `Draft`, `SyncCursor` (account + per-conversation)
- [ ] HAL hydration on first install / empty store
- [ ] `GET /conversations/sync` reconciler for list rows
- [ ] `GET /conversations/{id}/sync` reconciler for thread + metadata snapshot
- [ ] Handle `messages_rewound` by deleting local rows by server ID
- [ ] Handle `conversation_deleted` on both feeds
- [ ] Paginate while `has_more`
- [ ] Keep SSE path for active runs; call thread sync after `done` / foreground
- [ ] Do not sync drafts to server
- [ ] **Missing account marker:** `GET /conversations/sync` with `since` omitted
- [ ] **Missing thread marker:** HAL thread rehydrate, then thread sync with `since` omitted
- [ ] **`sync_marker_invalid`:** clear scope marker, run the missing-marker recovery path

---

## Self-review (spec coverage)

| Spec requirement | Task |
|------------------|------|
| Account conversation deltas | Task 3, 5, 6 |
| Thread message/metadata deltas | Task 3, 5, 6 |
| Explicit rewind by message ID | Task 5 (`messages_rewound`) |
| Title in list + thread | Task 4, 6 (snapshot + upsert) |
| Durable markers | Task 2, 3 |
| Missing/invalid marker recovery | Spec + OpenAPI + plan client checklist |
| `next_sync_marker` always on `200` | OpenAPI required field + `SYNC_MARKER_ORIGIN` in Task 3 |
| `sync_marker_invalid` reset signal | Task 6 |
| No event compaction v2.1.0 | Task 2 schema (append-only) |
| HAL history unchanged | No changes to pagination routes |
| Additive rollout | No breaking changes to existing routes |
| No draft sync | Out of scope |