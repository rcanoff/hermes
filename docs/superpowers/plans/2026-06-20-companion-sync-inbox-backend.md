# Companion Sync Inbox — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, tests, OpenAPI, README, `.env.example`). Do **not** implement iOS/Swift changes here. The iOS client (`assistant-companion`) must write its own plan — see `docs/superpowers/specs/2026-06-20-companion-sync-inbox-ios-design.md`.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml` in the same change set. Target version **v2.6.0**.

**Goal:** Add per-device sync inbox (`PUT /devices/me`, `GET /sync/inbox`) so each logged-in user on each physical device polls a server-coalesced dirty set, then runs targeted thread sync.

**Architecture:** New `device_sync_state` table stores cursor per `(user_id, device_id)`. Inbox is a read projection over existing `chat_sync_events` — account events define the cursor window; conversation-scoped events detect message-only updates. Gap overflow or invalid cursor returns `reset_required: true` so clients fall back to `GET /conversations/sync`. No new event emitters.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md`

---

## Client integration summary (for `assistant-companion` agent)

| Topic | Rule |
|-------|------|
| Stable identity | Generate install-scoped `device_id` (UUID in Keychain); **not** JWT `jti` |
| Registration | `PUT /devices/me` after every login, before first inbox poll |
| Normal poll | `GET /sync/inbox?device_id=<uuid>` — omit `since` (server uses stored cursor) |
| `changes[].kind: deleted` | Purge local conversation + messages; tombstone id |
| `changes[].kind: updated` | `GET /conversations/{id}/sync` (apply snapshot even when `events` empty) |
| `reset_required: true` | Clear markers → `GET /conversations/sync` (paginate) → HAL-rehydrate → resume inbox |
| Unknown device | `400 invalid_request` — call `PUT /devices/me` first |
| Account switch | Same `device_id`, different server cursor per `user_id` |
| Thread sync | Unchanged v2.1 routes; inbox only selects targets |
| Push | Out of scope; `push_devices` and `device_sync_state` are separate tables |

**iOS agent:** write the implementation plan at `docs/superpowers/plans/2026-06-20-companion-sync-inbox-ios.md` in `assistant-companion`. Follow OpenAPI v2.6.0 and the API rules above.

---

## File structure

```
messaging-api/
  src/
    config.ts                              — MODIFY: SYNC_INBOX_MAX_GAP
    types.ts                               — MODIFY: syncInboxMaxGap on AppOptions
    db/schema.ts                           — MODIFY: device_sync_state table
    db/repos/device-sync-state.ts          — CREATE: upsert + cursor read/write
    db/repos/chat-sync-events.ts           — MODIFY: export account tip + scoped row fetch helpers
    lib/sync-inbox.ts                      — CREATE: buildInbox coalescing
    routes/devices.ts                      — CREATE: PUT /devices/me
    routes/sync-inbox.ts                   — CREATE: GET /sync/inbox
    app.ts                                 — MODIFY: register routes; decorate syncInboxMaxGap
  test/
    db.test.ts                             — MODIFY: device_sync_state table assertion
    config.test.ts                         — MODIFY: SYNC_INBOX_MAX_GAP parsing
    device-sync-state.test.ts              — CREATE: repo tests
    sync-inbox.test.ts                     — CREATE: coalescing unit tests
    sync-inbox-routes.test.ts              — CREATE: HTTP integration tests
    helpers/app.ts                         — MODIFY: default syncInboxMaxGap in test app

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v2.6.0
.env.example                                         — MODIFY: SYNC_INBOX_MAX_GAP
README.md                                            — MODIFY: sync inbox section
```

---

## Task 1: OpenAPI v2.6.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Bump version and changelog**

Set `info.version: 2.6.0` and add at top of `info.description`:

```yaml
    **v2.6.0 changes:** per-device sync inbox. `PUT /devices/me` registers a stable
    install `device_id` per authenticated user. `GET /sync/inbox` returns a coalesced
    `changes[]` (`deleted` | `updated`) since the server-stored cursor for
    `(user_id, device_id)`. `reset_required: true` when the cursor is missing, invalid,
    or the account gap exceeds `SYNC_INBOX_MAX_GAP` (default 500). Existing
    `GET /conversations/sync` and `GET /conversations/{id}/sync` are unchanged.
    See `docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md`.
```

- [ ] **Step 2: Add schemas under `components/schemas`**

```yaml
    RegisterDeviceRequest:
      type: object
      required: [device_id]
      properties:
        device_id:
          type: string
          format: uuid
          description: Stable install-scoped identifier from the companion app

    RegisterDeviceResponse:
      type: object
      required: [ok]
      properties:
        ok:
          type: boolean
          const: true

    SyncInboxChangeKind:
      type: string
      enum: [deleted, updated]

    SyncInboxChange:
      type: object
      required: [conversation_id, kind]
      properties:
        conversation_id:
          type: string
          format: uuid
        kind:
          $ref: '#/components/schemas/SyncInboxChangeKind'

    SyncInboxResponse:
      type: object
      required: [changes, next_cursor, has_more, reset_required]
      properties:
        changes:
          type: array
          items:
            $ref: '#/components/schemas/SyncInboxChange'
        next_cursor:
          type: string
          format: uuid
          description: |
            Account feed tip after this poll. Server persists per (user, device).
            Origin sentinel `00000000-0000-4000-8000-000000000000` when feed is empty.
        has_more:
          type: boolean
          description: Always false in v2.6.0; gap overflow uses reset_required instead
        reset_required:
          type: boolean
          description: |
            When true, client must run full account bootstrap via GET /conversations/sync
            before resuming inbox polling.
```

- [ ] **Step 3: Add routes**

```yaml
  /devices/me:
    put:
      tags: [sync-inbox]
      summary: Register stable device identity
      description: |
        Upserts `(user_id, device_id)` in `device_sync_state`. Does not reset an
        existing cursor. Required before `GET /sync/inbox`.
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RegisterDeviceRequest'
      responses:
        '200':
          description: Device registered
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RegisterDeviceResponse'
        '400':
          description: Invalid body
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '401':
          description: Unauthorized
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'

  /sync/inbox:
    get:
      tags: [sync-inbox]
      summary: Coalesced per-device change feed
      description: |
        Returns a coalesced dirty set for the authenticated user and registered device.

        **Coalescing (per conversation_id in cursor window):**
        - Any account `conversation_deleted` → `kind: deleted` (wins)
        - Else account `conversation_upsert` or any conversation-scoped event → `kind: updated`
        - At most one row per conversation; `deleted` rows before `updated`; `updated`
          ordered by latest activity descending

        **Cursor:** omit `since` to use the server-stored cursor. First poll after
        registration returns `reset_required: true` (null cursor).

        **Fallback:** `reset_required: true` when cursor is unknown or account events
        since cursor exceed `SYNC_INBOX_MAX_GAP`.
      security:
        - bearerAuth: []
      parameters:
        - name: device_id
          in: query
          required: true
          schema:
            type: string
            format: uuid
        - name: since
          in: query
          required: false
          description: Override stored cursor (advanced debugging)
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Inbox page
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SyncInboxResponse'
        '400':
          description: Invalid params or unregistered device
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '401':
          description: Unauthorized
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs(openapi): v2.6.0 sync inbox contract"
```

---

## Task 2: Config — `SYNC_INBOX_MAX_GAP`

**Files:**
- Modify: `messaging-api/src/config.ts`
- Modify: `messaging-api/src/types.ts`
- Modify: `messaging-api/test/config.test.ts`
- Modify: `messaging-api/test/helpers/app.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing config test**

Add to `messaging-api/test/config.test.ts`:

```typescript
  it('parses SYNC_INBOX_MAX_GAP with default 500', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
      }).syncInboxMaxGap,
    ).toBe(500)
  })

  it('parses SYNC_INBOX_MAX_GAP override', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
        SYNC_INBOX_MAX_GAP: '250',
      }).syncInboxMaxGap,
    ).toBe(250)
  })
```

Update the existing `returns config when required values are present` expectation to include `syncInboxMaxGap: 500`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/config.test.ts -t "SYNC_INBOX_MAX_GAP"`  
Expected: FAIL — `syncInboxMaxGap` undefined

- [ ] **Step 3: Implement config**

In `messaging-api/src/types.ts`, add to `AppOptions`:

```typescript
  syncInboxMaxGap: number
```

In `messaging-api/src/config.ts` `readConfig` return object:

```typescript
    syncInboxMaxGap: readPositiveInt(env.SYNC_INBOX_MAX_GAP, 500),
```

In `messaging-api/test/helpers/app.ts` `createTestApp` defaults:

```typescript
    syncInboxMaxGap: 500,
```

In `.env.example` (commented):

```
# SYNC_INBOX_MAX_GAP=500
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/config.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/config.ts messaging-api/src/types.ts messaging-api/test/config.test.ts messaging-api/test/helpers/app.ts .env.example
git commit -m "feat(messaging-api): add SYNC_INBOX_MAX_GAP config"
```

---

## Task 3: Schema — `device_sync_state`

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing table test**

Add to `messaging-api/test/db.test.ts`:

```typescript
  it('includes device_sync_state table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'device_sync_state'`)
      .get()
    expect(row).toBeDefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/db.test.ts -t "device_sync_state"`  
Expected: FAIL

- [ ] **Step 3: Add migration helper**

In `messaging-api/src/db/schema.ts`, call `ensureDeviceSyncState(db)` from `initSchema` (after `ensurePushDevices`):

```typescript
function ensureDeviceSyncState(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_sync_state (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_account_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, device_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS device_sync_state_user_idx
      ON device_sync_state (user_id);
  `)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/db.test.ts -t "device_sync_state"`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): add device_sync_state schema"
```

---

## Task 4: `device-sync-state` repo

**Files:**
- Create: `messaging-api/src/db/repos/device-sync-state.ts`
- Create: `messaging-api/test/device-sync-state.test.ts`

- [ ] **Step 1: Write failing repo tests**

Create `messaging-api/test/device-sync-state.test.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'
import {
  ensureDeviceRegistered,
  getDeviceSyncCursor,
  setDeviceSyncCursor,
} from '../src/db/repos/device-sync-state.js'

describe('device-sync-state repo', () => {
  it('ensureDeviceRegistered creates row without cursor', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const deviceId = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)

    ensureDeviceRegistered(db, userId, deviceId)

    expect(getDeviceSyncCursor(db, userId, deviceId)).toBeNull()
  })

  it('ensureDeviceRegistered is idempotent and preserves cursor', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const deviceId = randomUUID()
    const cursor = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)

    ensureDeviceRegistered(db, userId, deviceId)
    setDeviceSyncCursor(db, userId, deviceId, cursor)
    ensureDeviceRegistered(db, userId, deviceId)

    expect(getDeviceSyncCursor(db, userId, deviceId)).toBe(cursor)
  })

  it('getDeviceSyncCursor returns undefined for unknown device', () => {
    const db = new Database(':memory:')
    initSchema(db)
    expect(getDeviceSyncCursor(db, randomUUID(), randomUUID())).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/device-sync-state.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement repo**

Create `messaging-api/src/db/repos/device-sync-state.ts`:

```typescript
import type Database from 'better-sqlite3'

export function ensureDeviceRegistered(
  db: Database.Database,
  userId: string,
  deviceId: string,
): void {
  db.prepare(`
    INSERT INTO device_sync_state (user_id, device_id)
    VALUES (?, ?)
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      updated_at = datetime('now')
  `).run(userId, deviceId)
}

export function getDeviceSyncCursor(
  db: Database.Database,
  userId: string,
  deviceId: string,
): string | null | undefined {
  const row = db
    .prepare(`
      SELECT last_account_event_id
      FROM device_sync_state
      WHERE user_id = ? AND device_id = ?
    `)
    .get(userId, deviceId) as { last_account_event_id: string | null } | undefined

  if (!row) {
    return undefined
  }

  return row.last_account_event_id
}

export function setDeviceSyncCursor(
  db: Database.Database,
  userId: string,
  deviceId: string,
  cursor: string,
): void {
  db.prepare(`
    UPDATE device_sync_state
    SET last_account_event_id = ?, updated_at = datetime('now')
    WHERE user_id = ? AND device_id = ?
  `).run(cursor, userId, deviceId)
}

export function isDeviceRegistered(
  db: Database.Database,
  userId: string,
  deviceId: string,
): boolean {
  const row = db
    .prepare(`SELECT 1 FROM device_sync_state WHERE user_id = ? AND device_id = ?`)
    .get(userId, deviceId) as { 1: number } | undefined

  return row !== undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/device-sync-state.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/repos/device-sync-state.ts messaging-api/test/device-sync-state.test.ts
git commit -m "feat(messaging-api): device sync state repo"
```

---

## Task 5: Chat-sync helpers + `buildInbox` lib

**Files:**
- Modify: `messaging-api/src/db/repos/chat-sync-events.ts`
- Create: `messaging-api/src/lib/sync-inbox.ts`
- Create: `messaging-api/test/sync-inbox.test.ts`

- [ ] **Step 1: Export account feed helpers from chat-sync-events**

In `messaging-api/src/db/repos/chat-sync-events.ts`, export these (rename private functions or re-export):

```typescript
export function resolveAccountFeedTip(db: Database.Database, userId: string): string {
  // move existing private resolveAccountFeedTip body here
}

export function accountSyncMarkerExists(
  db: Database.Database,
  userId: string,
  marker: string | undefined,
): boolean {
  // use existing validateSinceMarker(db, marker, 'account', userId) logic
}

interface ScopedEventRow {
  id: string
  conversation_id: string
  event_type: string
  occurred_at: string
}

export function listAccountEventRowsAfterMarker(
  db: Database.Database,
  userId: string,
  since: string | undefined,
  limit: number,
): ScopedEventRow[] {
  // use existing fetchScopedRows for scope='account', map to ScopedEventRow
}

export function listConversationActivitySinceMarker(
  db: Database.Database,
  userId: string,
  since: string | undefined,
): Array<{ conversation_id: string; latest_occurred_at: string }> {
  if (isSyncMarkerOrigin(since)) {
    return db
      .prepare(`
        SELECT conversation_id, MAX(occurred_at) AS latest_occurred_at
        FROM chat_sync_events
        WHERE scope = 'conversation' AND user_id = ?
        GROUP BY conversation_id
      `)
      .all(userId) as Array<{ conversation_id: string; latest_occurred_at: string }>
  }

  const cursor = db
    .prepare(`
      SELECT id, occurred_at
      FROM chat_sync_events
      WHERE id = ? AND scope = 'account' AND user_id = ?
    `)
    .get(since!, userId) as { id: string; occurred_at: string } | undefined

  if (!cursor) {
    return []
  }

  return db
    .prepare(`
      SELECT conversation_id, MAX(occurred_at) AS latest_occurred_at
      FROM chat_sync_events
      WHERE scope = 'conversation'
        AND user_id = ?
        AND (
          occurred_at > ?
          OR (occurred_at = ? AND id > ?)
        )
      GROUP BY conversation_id
    `)
    .all(userId, cursor.occurred_at, cursor.occurred_at, cursor.id) as Array<{
      conversation_id: string
      latest_occurred_at: string
    }>
}
```

Refactor existing private `resolveAccountFeedTip` / `fetchScopedRows` / `validateSinceMarker` to call the exported versions internally (no behavior change to existing sync routes).

- [ ] **Step 2: Write failing coalescing tests**

Create `messaging-api/test/sync-inbox.test.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'
import {
  appendAccountConversationDeleted,
  appendAccountConversationUpsert,
  appendConversationMessageUpsert,
} from '../src/db/repos/chat-sync-events.js'
import { buildConversationSyncEntry } from '../src/lib/conversation-sync-entry.js'
import { buildInbox } from '../src/lib/sync-inbox.js'
import { SYNC_MARKER_ORIGIN } from '../src/lib/sync-marker.js'

function seedUser(db: Database.Database, userId: string) {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)
}

function seedConversation(db: Database.Database, userId: string, conversationId: string) {
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id, title, created_at, updated_at)
    VALUES (?, ?, ?, 't', datetime('now'), datetime('now'))
  `).run(conversationId, userId, randomUUID())
}

describe('buildInbox', () => {
  it('returns reset_required when since cursor is null', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    seedUser(db, userId)

    const result = buildInbox(db, userId, null, { maxGap: 500 })

    expect(result).toEqual({
      changes: [],
      next_cursor: SYNC_MARKER_ORIGIN,
      has_more: false,
      reset_required: true,
    })
  })

  it('coalesces delete over update for same conversation', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const conversationId = randomUUID()
    seedUser(db, userId)
    seedConversation(db, userId, conversationId)

    const upsert = appendAccountConversationUpsert(
      db,
      userId,
      conversationId,
      buildConversationSyncEntry(db, {
        id: conversationId,
        user_id: userId,
        hermes_session_id: randomUUID(),
        title: 't',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        kind: 'regular',
      } as never),
    )
    appendAccountConversationDeleted(db, userId, conversationId)

    const result = buildInbox(db, userId, upsert.event_id, { maxGap: 500 })

    expect(result.reset_required).toBe(false)
    expect(result.changes).toEqual([{ conversation_id: conversationId, kind: 'deleted' }])
  })

  it('returns updated when only conversation-scoped message events exist', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const conversationId = randomUUID()
    seedUser(db, userId)
    seedConversation(db, userId, conversationId)

    const upsert = appendAccountConversationUpsert(
      db,
      userId,
      conversationId,
      buildConversationSyncEntry(db, {
        id: conversationId,
        user_id: userId,
        hermes_session_id: randomUUID(),
        title: 't',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        kind: 'regular',
      } as never),
    )

    for (let i = 0; i < 10; i += 1) {
      appendConversationMessageUpsert(db, userId, conversationId, {
        id: randomUUID(),
        conversation_id: conversationId,
        role: 'assistant',
        content: `m${i}`,
        created_at: `2026-01-01T00:00:0${i}.000Z`,
      })
    }

    const result = buildInbox(db, userId, upsert.event_id, { maxGap: 500 })

    expect(result.reset_required).toBe(false)
    expect(result.changes).toEqual([{ conversation_id: conversationId, kind: 'updated' }])
  })

  it('returns reset_required when account gap exceeds maxGap', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    seedUser(db, userId)

    let since = SYNC_MARKER_ORIGIN
    for (let i = 0; i < 3; i += 1) {
      const conversationId = randomUUID()
      seedConversation(db, userId, conversationId)
      const row = appendAccountConversationUpsert(
        db,
        userId,
        conversationId,
        buildConversationSyncEntry(db, {
          id: conversationId,
          user_id: userId,
          hermes_session_id: randomUUID(),
          title: `c${i}`,
          created_at: `2026-01-01T00:00:0${i}.000Z`,
          updated_at: `2026-01-01T00:00:0${i}.000Z`,
          kind: 'regular',
        } as never),
      )
      since = row.event_id
    }

    const result = buildInbox(db, userId, since, { maxGap: 2 })

    expect(result.reset_required).toBe(true)
    expect(result.changes).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/sync-inbox.test.ts`  
Expected: FAIL — `buildInbox` not defined

- [ ] **Step 4: Implement `buildInbox`**

Create `messaging-api/src/lib/sync-inbox.ts`:

```typescript
import type Database from 'better-sqlite3'
import {
  accountSyncMarkerExists,
  listAccountEventRowsAfterMarker,
  listConversationActivitySinceMarker,
  resolveAccountFeedTip,
} from '../db/repos/chat-sync-events.js'
import { isSyncMarkerOrigin } from './sync-marker.js'

export interface SyncInboxChange {
  conversation_id: string
  kind: 'deleted' | 'updated'
}

export interface SyncInboxResult {
  changes: SyncInboxChange[]
  next_cursor: string
  has_more: boolean
  reset_required: boolean
}

export interface BuildInboxOptions {
  maxGap: number
}

export function buildInbox(
  db: Database.Database,
  userId: string,
  since: string | null | undefined,
  options: BuildInboxOptions,
): SyncInboxResult {
  const tip = resolveAccountFeedTip(db, userId)

  if (since === null || since === undefined) {
    return { changes: [], next_cursor: tip, has_more: false, reset_required: true }
  }

  if (!accountSyncMarkerExists(db, userId, since)) {
    return { changes: [], next_cursor: tip, has_more: false, reset_required: true }
  }

  const accountRows = listAccountEventRowsAfterMarker(db, userId, since, options.maxGap + 1)
  if (accountRows.length > options.maxGap) {
    return { changes: [], next_cursor: tip, has_more: false, reset_required: true }
  }

  const deleted = new Set<string>()
  const updatedLatest = new Map<string, string>()

  for (const row of accountRows) {
    if (row.event_type === 'conversation_deleted') {
      deleted.add(row.conversation_id)
      updatedLatest.delete(row.conversation_id)
      continue
    }

    if (row.event_type === 'conversation_upsert' && !deleted.has(row.conversation_id)) {
      const prev = updatedLatest.get(row.conversation_id)
      if (!prev || row.occurred_at > prev) {
        updatedLatest.set(row.conversation_id, row.occurred_at)
      }
    }
  }

  for (const activity of listConversationActivitySinceMarker(db, userId, since)) {
    if (deleted.has(activity.conversation_id)) {
      continue
    }

    const prev = updatedLatest.get(activity.conversation_id)
    if (!prev || activity.latest_occurred_at > prev) {
      updatedLatest.set(activity.conversation_id, activity.latest_occurred_at)
    }
  }

  const changes: SyncInboxChange[] = [
    ...[...deleted].map((conversation_id) => ({ conversation_id, kind: 'deleted' as const })),
    ...[...updatedLatest.entries()]
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .map(([conversation_id]) => ({ conversation_id, kind: 'updated' as const })),
  ]

  return { changes, next_cursor: tip, has_more: false, reset_required: false }
}

export function isValidDeviceId(value: string | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
```

- [ ] **Step 5: Run tests**

Run: `cd messaging-api && npm test -- test/sync-inbox.test.ts test/chat-sync.test.ts test/chat-sync-events.test.ts`  
Expected: PASS (existing sync tests unchanged)

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/db/repos/chat-sync-events.ts messaging-api/src/lib/sync-inbox.ts messaging-api/test/sync-inbox.test.ts
git commit -m "feat(messaging-api): sync inbox coalescing lib"
```

---

## Task 6: Routes — `PUT /devices/me` and `GET /sync/inbox`

**Files:**
- Create: `messaging-api/src/routes/devices.ts`
- Create: `messaging-api/src/routes/sync-inbox.ts`
- Modify: `messaging-api/src/app.ts`

- [ ] **Step 1: Write failing route tests**

Create `messaging-api/test/sync-inbox-routes.test.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SYNC_MARKER_ORIGIN } from '../src/lib/sync-marker.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('sync inbox routes', () => {
  let app: FastifyInstance | undefined
  let token: string
  let deviceId: string
  let conversationId: string

  beforeEach(async () => {
    app = await createTestApp({ syncInboxMaxGap: 500 })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
    deviceId = randomUUID()

    const created = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })
    conversationId = (created.json() as { id: string }).id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('PUT /devices/me registers device', async () => {
    const response = await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: deviceId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('GET /sync/inbox rejects unregistered device', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('GET /sync/inbox returns reset_required on first poll', async () => {
    await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: deviceId },
    })

    const response = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      changes: [],
      reset_required: true,
      has_more: false,
    })
  })

  it('GET /sync/inbox returns deleted after conversation delete on other cursor', async () => {
    await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: deviceId },
    })

    const accountSync = await app!.inject({
      method: 'GET',
      url: '/conversations/sync',
      headers: { authorization: `Bearer ${token}` },
    })
    const marker = (accountSync.json() as { next_sync_marker: string }).next_sync_marker

    await app!.db
      .prepare(`UPDATE device_sync_state SET last_account_event_id = ? WHERE device_id = ?`)
      .run(marker, deviceId)

    await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    const inbox = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(inbox.statusCode).toBe(200)
    expect(inbox.json()).toMatchObject({
      reset_required: false,
      changes: [{ conversation_id: conversationId, kind: 'deleted' }],
    })
  })

  it('isolates cursors per device for same user', async () => {
    const deviceB = randomUUID()

    for (const id of [deviceId, deviceB]) {
      await app!.inject({
        method: 'PUT',
        url: '/devices/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { device_id: id },
      })
    }

    const tip = (
      await app!.inject({
        method: 'GET',
        url: '/conversations/sync',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json() as { next_sync_marker: string }

    await app!.db
      .prepare(`UPDATE device_sync_state SET last_account_event_id = ? WHERE device_id = ?`)
      .run(tip.next_sync_marker, deviceId)

    await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    const inboxA = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const inboxB = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceB}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(inboxA.json().changes).toEqual([{ conversation_id: conversationId, kind: 'deleted' }])
    expect(inboxB.json()).toMatchObject({ reset_required: true, changes: [] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/sync-inbox-routes.test.ts`  
Expected: FAIL — 404 routes

- [ ] **Step 3: Implement routes**

Create `messaging-api/src/routes/devices.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { ensureDeviceRegistered } from '../db/repos/device-sync-state.js'

const registerSchema = z.object({
  device_id: z.string().uuid(),
})

const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.put('/devices/me', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    ensureDeviceRegistered(app.db, request.userId, parsed.data.device_id)
    return { ok: true as const }
  })
}

export default devicesRoutes
```

Create `messaging-api/src/routes/sync-inbox.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import {
  getDeviceSyncCursor,
  isDeviceRegistered,
  setDeviceSyncCursor,
} from '../db/repos/device-sync-state.js'
import { buildInbox, isValidDeviceId } from '../lib/sync-inbox.js'

const syncInboxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/sync/inbox', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { device_id?: string; since?: string }
    if (!isValidDeviceId(query.device_id)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    if (!isDeviceRegistered(app.db, request.userId, query.device_id!)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const storedCursor = getDeviceSyncCursor(app.db, request.userId, query.device_id!)
    const since =
      query.since !== undefined
        ? query.since
        : storedCursor === undefined
          ? null
          : storedCursor

    if (query.since !== undefined && !isValidDeviceId(query.since)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const result = buildInbox(app.db, request.userId, since, {
      maxGap: app.syncInboxMaxGap,
    })

    if (!result.reset_required) {
      setDeviceSyncCursor(app.db, request.userId, query.device_id!, result.next_cursor)
    }

    return result
  })
}

export default syncInboxRoutes
```

In `messaging-api/src/app.ts`:

```typescript
import devicesRoutes from './routes/devices.js'
import syncInboxRoutes from './routes/sync-inbox.js'
```

Add to Fastify module declaration:

```typescript
    syncInboxMaxGap: number
```

Decorate in `buildApp`:

```typescript
  app.decorate('syncInboxMaxGap', options.syncInboxMaxGap)
```

Register routes (after `chatSyncRoutes`):

```typescript
  app.register(devicesRoutes)
  app.register(syncInboxRoutes)
```

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/sync-inbox-routes.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/routes/devices.ts messaging-api/src/routes/sync-inbox.ts messaging-api/src/app.ts messaging-api/test/sync-inbox-routes.test.ts
git commit -m "feat(messaging-api): sync inbox routes"
```

---

## Task 7: README operator docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add sync inbox section**

Add after the local-first sync section (or companion sync area):

```markdown
### Sync inbox (v2.6.0)

Per-device reconciliation for multi-device companion use:

- `PUT /devices/me` — register stable `device_id` per user
- `GET /sync/inbox?device_id=…` — coalesced `changes[]` since server cursor

Config: `SYNC_INBOX_MAX_GAP` (default `500`) — gap overflow returns `reset_required: true`.

Spec: `docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md`
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: sync inbox operator notes"
```

---

## Task 8: Full test suite

- [ ] **Step 1: Run full messaging-api tests**

Run: `cd messaging-api && npm test`  
Expected: all PASS

- [ ] **Step 2: Final commit if any fixups**

```bash
git add -A
git commit -m "fix(messaging-api): sync inbox review fixups"
```

---

## Spec coverage checklist

| Requirement | Task |
|-------------|------|
| `device_sync_state` table | Task 3 |
| `PUT /devices/me` upsert, no cursor reset | Task 4, 6 |
| `GET /sync/inbox` coalesced response | Task 5, 6 |
| Independent cursors per `(user_id, device_id)` | Task 6 tests |
| `reset_required` on null/invalid/gap cursor | Task 5, 6 |
| `400` for unknown `device_id` | Task 6 |
| `SYNC_INBOX_MAX_GAP` config | Task 2 |
| OpenAPI v2.6.0 | Task 1 |
| No new event emitters | N/A (read-only projection) |
| Thread/account sync unchanged | No route edits |

---

## Ship checklist

When implementation is complete and tests pass:

1. Move this plan to `docs/history/implemented/plans/`
2. Move `docs/superpowers/specs/2026-06-20-companion-sync-inbox-design.md` to `docs/history/implemented/specs/`
3. Update `docs/superpowers/README.md` (remove active inbox entry or mark shipped)
4. Keep iOS reference spec in superpowers until iOS ships, or move with coordinated release