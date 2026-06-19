# Companion Session Stream — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. The iOS client (`assistant-companion`) should read this plan plus `docs/superpowers/specs/messaging-api.openapi.yaml` v2.2.0 and `docs/superpowers/specs/2026-06-18-companion-session-stream-design.md`.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml` in the same change set.

**Goal:** Add persistent per-auth-session SSE (`GET /events/stream`) with `tooling` / `reply` / `title` events routed to the session that started each run, while keeping the legacy per-conversation stream working until iOS migrates.

**Architecture:** JWTs gain a `jti` session claim. `message_runs.origin_session_id` records which session started each run. `StreamHub` keys new listeners by `sessionId` and emits session-scoped events with `conversationId` + `runId`. During phase 1, `run-executor` dual-publishes legacy conversation events so existing iOS keeps working. Sync feeds and HAL history are unchanged.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-18-companion-session-stream-design.md`

---

## Client integration summary (for `assistant-companion` agent)

1. **Login** → store JWT → open `GET /events/stream` (persistent; reconnect on drop).
2. **Send** → `POST /conversations/:id/messages` only (no per-send stream open).
3. **Route events** by `conversationId` to the active `ChatViewModel`.
4. **Three UX lanes:** `tooling` (process block), `reply` (streaming answer), `title` (conversation rename).
5. **On `reply` with `phase: "done"`** → commit locally → `GET /conversations/:id/sync`.
6. **Other devices** do not receive live SSE for runs they did not start; use sync feeds.
7. **Logout** → close SSE → `POST /auth/logout`.
8. **Tokens without `jti`** cannot open `/events/stream` (`401 session_required`); re-login to migrate.

---

## File structure

```
messaging-api/
  src/
    plugins/auth.ts                    — MODIFY: request.sessionId from jti
    routes/auth.ts                     — MODIFY: jti in jwtSign
    routes/events.ts                   — CREATE: GET /events/stream
    routes/messages.ts                 — MODIFY: pass sessionId; legacy stream unchanged
    db/schema.ts                       — MODIFY: origin_session_id column migration
    db/repos/runs.ts                   — MODIFY: createRun(..., originSessionId)
    streams/hub.ts                     — MODIFY: session + legacy dual hub
    streams/run-event-publisher.ts       — CREATE: map run events → session + legacy SSE
    services/run-executor.ts             — MODIFY: use run-event-publisher
    services/title-generator.ts          — MODIFY: session title publish
    services/message-editor.ts           — MODIFY: createRun with originSessionId
    app.ts                             — MODIFY: register events routes
  test/
    session-stream.test.ts             — CREATE: integration tests for new route
    streams/hub.test.ts                — CREATE: session subscribe/replace/publish
    run-executor.test.ts               — MODIFY: session event expectations
    message-editor.test.ts             — MODIFY: origin_session_id on edit rerun
    messages.test.ts                   — MODIFY: legacy stream tests still pass
    helpers/users.ts                   — MODIFY: jti in seedTestUser tokens

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v2.2.0
README.md                                           — MODIFY: session stream section
```

---

## Task 1: OpenAPI v2.2.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Bump version and changelog**

Set `info.version: 2.2.0` and add at top of description:

```yaml
    **v2.2.0 changes:** persistent per-auth-session SSE at `GET /events/stream`.
    Events: `tooling`, `reply`, `title`, `rewind`, `error` (all include `conversationId`;
    run-scoped events include `runId`). JWT login responses include `jti` session claim.
    `GET /conversations/{id}/stream` is deprecated. See
    `docs/superpowers/specs/2026-06-18-companion-session-stream-design.md`.
```

- [ ] **Step 2: Add session SSE schemas**

Add under `components/schemas`:

```yaml
    SseToolingEvent:
      oneOf:
        - type: object
          required: [conversationId, runId, kind, text]
          properties:
            conversationId:
              type: string
              format: uuid
            runId:
              type: string
              format: uuid
            kind:
              type: string
              enum: [reasoning, tool]
            text:
              type: string
            draft:
              type: boolean
              const: true
              description: Reasoning delta; append to in-flight draft
        - type: object
          required: [conversationId, runId, phase]
          properties:
            conversationId:
              type: string
              format: uuid
            runId:
              type: string
              format: uuid
            phase:
              type: string
              const: complete
              description: Process phase ended; reply tokens follow

    SseReplyEvent:
      oneOf:
        - type: object
          required: [conversationId, runId, text]
          properties:
            conversationId:
              type: string
              format: uuid
            runId:
              type: string
              format: uuid
            text:
              type: string
        - type: object
          required: [conversationId, runId, phase, messageId]
          properties:
            conversationId:
              type: string
              format: uuid
            runId:
              type: string
              format: uuid
            phase:
              type: string
              const: done
            messageId:
              type: string
              format: uuid

    SseSessionTitleEvent:
      type: object
      required: [conversationId, title]
      properties:
        conversationId:
          type: string
          format: uuid
        title:
          type: string
          maxLength: 80

    SseSessionRewindEvent:
      type: object
      required: [conversationId, runId, removedMessageIds]
      properties:
        conversationId:
          type: string
          format: uuid
        runId:
          type: string
          format: uuid
        removedMessageIds:
          type: array
          items:
            type: string
            format: uuid

    SseSessionErrorEvent:
      type: object
      required: [conversationId, runId, code]
      properties:
        conversationId:
          type: string
          format: uuid
        runId:
          type: string
          format: uuid
        code:
          type: string
          example: hermes_stream_failed
```

- [ ] **Step 3: Add `GET /events/stream` path**

```yaml
  /events/stream:
    get:
      tags: [messages]
      summary: Persistent SSE stream for the authenticated session
      description: |
        Server-Sent Events for the current auth session (`jti` claim). Stays open across
        runs until the client disconnects or the token is denied. Does not close on
        individual run completion.

        Events route only to the session that started each run (`POST` / `PATCH`).

        **SSE events:**

        | event | data schema | when |
        |-------|-------------|------|
        | `tooling` | `SseToolingEvent` | Process lines, reasoning drafts, phase complete |
        | `reply` | `SseReplyEvent` | Answer tokens and run commit |
        | `title` | `SseSessionTitleEvent` | Auto-generated title saved |
        | `rewind` | `SseSessionRewindEvent` | Messages removed before edit rerun |
        | `error` | `SseSessionErrorEvent` | Run failed (stream stays open) |

        Requires JWT with `jti`. Tokens without `jti` receive `401 session_required`.
      security:
        - bearerAuth: []
      x-sse-events:
        tooling:
          $ref: '#/components/schemas/SseToolingEvent'
        reply:
          $ref: '#/components/schemas/SseReplyEvent'
        title:
          $ref: '#/components/schemas/SseSessionTitleEvent'
        rewind:
          $ref: '#/components/schemas/SseSessionRewindEvent'
        error:
          $ref: '#/components/schemas/SseSessionErrorEvent'
      responses:
        '200':
          description: Event stream
          content:
            text/event-stream:
              schema:
                type: string
        '401':
          description: Missing or denied token, or token without jti
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

- [ ] **Step 4: Deprecate legacy stream path**

On `GET /conversations/{id}/stream` `get` operation add:

```yaml
      deprecated: true
      description: |
        **Deprecated:** use `GET /events/stream` (v2.2.0). Retained for older companion
        clients until iOS migrates.
        ...
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs(openapi): v2.2.0 companion session stream contract"
```

---

## Task 2: JWT `jti` and `request.sessionId`

**Files:**
- Modify: `messaging-api/src/plugins/auth.ts`
- Modify: `messaging-api/src/routes/auth.ts`
- Modify: `messaging-api/test/helpers/users.ts`
- Create: `messaging-api/test/auth-session.test.ts`

- [ ] **Step 1: Write failing login jti test**

Create `messaging-api/test/auth-session.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { createUser } from '../src/db/repos/users.js'
import { hashPassword } from '../src/services/password.js'

describe('auth session jti', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const passwordHash = await hashPassword('password123')
    createUser(app.db, {
      username: 'operator',
      passwordHash,
      passwordChangedAt: new Date().toISOString(),
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('includes jti in login JWT payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })

    expect(response.statusCode).toBe(200)
    const { token } = response.json() as { token: string }
    const claims = app.jwt.decode<{ jti?: string; sub: string }>(token)
    expect(claims?.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(claims?.sub).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/auth-session.test.ts -t "includes jti"`  
Expected: FAIL — `claims.jti` is undefined

- [ ] **Step 3: Add jti to all jwtSign calls**

In `messaging-api/src/routes/auth.ts`, ensure `randomUUID` is imported and update all three sign sites:

```typescript
const token = await reply.jwtSign(
  { sub: user.id, username: user.username, jti: randomUUID() },
  { sign: { expiresIn: ONE_YEAR_IN_SECONDS } },
)
```

Apply the same `jti: randomUUID()` pattern to `POST /auth/activate` and `POST /auth/reset-password`.

- [ ] **Step 4: Expose `request.sessionId` in auth plugin**

In `messaging-api/src/plugins/auth.ts`:

```typescript
interface JwtClaims {
  sub: string
  username: string
  jti?: string
  iat?: number
  exp?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
    username: string
    bearerToken: string
    sessionId: string | null
  }
}
```

After verifying claims:

```typescript
      request.userId = user.id
      request.username = user.username
      request.bearerToken = token
      request.sessionId = claims.jti ?? null
```

- [ ] **Step 5: Update test helper**

In `messaging-api/test/helpers/users.ts`:

```typescript
import { randomUUID } from 'node:crypto'

export async function seedTestUser(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<{ id: string; username: string; token: string; sessionId: string }> {
  const passwordHash = await hashPassword(password)
  const passwordChangedAt = new Date().toISOString()
  const user = createUser(app.db, { username, passwordHash, passwordChangedAt })
  const sessionId = randomUUID()
  const token = await app.jwt.sign({ sub: user.id, username: user.username, jti: sessionId })
  return { id: user.id, username: user.username, token, sessionId }
}
```

- [ ] **Step 6: Run tests**

Run: `cd messaging-api && npm test -- test/auth-session.test.ts`  
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add messaging-api/src/plugins/auth.ts messaging-api/src/routes/auth.ts \
  messaging-api/test/helpers/users.ts messaging-api/test/auth-session.test.ts
git commit -m "feat(messaging-api): add jti session claim to auth tokens"
```

---

## Task 3: `origin_session_id` on `message_runs`

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/src/db/repos/runs.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing column test**

Add to `messaging-api/test/db.test.ts`:

```typescript
  it('includes origin_session_id on message_runs', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(message_runs)`)
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('origin_session_id')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/db.test.ts -t "origin_session_id"`  
Expected: FAIL

- [ ] **Step 3: Add migration helper and update createRun**

In `messaging-api/src/db/schema.ts`, call `ensureMessageRunsOriginSessionId(db)` from `initSchema`:

```typescript
function ensureMessageRunsOriginSessionId(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(message_runs)`)
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'origin_session_id')) {
    db.exec(`
      ALTER TABLE message_runs
      ADD COLUMN origin_session_id TEXT NOT NULL DEFAULT 'legacy'
    `)
  }
}
```

In `messaging-api/src/db/repos/runs.ts`:

```typescript
export interface RunRow {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  origin_session_id: string
  status: RunStatus
  error_code: string | null
  error_detail: string | null
  started_at: string
  finished_at: string | null
}

export function createRun(
  db: Database.Database,
  conversationId: string,
  userMessageId: string,
  originSessionId: string,
): string {
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, origin_session_id, status)
      VALUES (?, ?, ?, ?, 'running')
    `).run(id, conversationId, userMessageId, originSessionId)
  } catch (error) {
    if (isRunConflictError(error)) {
      throw new Error('run_conflict')
    }
    throw error
  }
  return id
}
```

Update `getActiveRun` SELECT to include `origin_session_id`.

- [ ] **Step 4: Run test**

Run: `cd messaging-api && npm test -- test/db.test.ts -t "origin_session_id"`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/src/db/repos/runs.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): store origin_session_id on message runs"
```

---

## Task 4: Session-aware `StreamHub`

**Files:**
- Modify: `messaging-api/src/streams/hub.ts`
- Create: `messaging-api/test/streams/hub.test.ts`

- [ ] **Step 1: Write failing hub tests**

Create `messaging-api/test/streams/hub.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { StreamHub, type SessionStreamEvent } from '../../src/streams/hub.js'

describe('StreamHub session listeners', () => {
  it('publishes session events only to the matching session', () => {
    const hub = new StreamHub()
    const a: SessionStreamEvent[] = []
    const b: SessionStreamEvent[] = []
    hub.subscribeSession('sess-a', (event) => a.push(event))
    hub.subscribeSession('sess-b', (event) => b.push(event))

    hub.publishSession('sess-a', {
      event: 'reply',
      data: { conversationId: 'c1', runId: 'r1', text: 'hi' },
    })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })

  it('replaces the previous session connection on reconnect', () => {
    const hub = new StreamHub()
    const first: SessionStreamEvent[] = []
    const second: SessionStreamEvent[] = []

    hub.replaceSessionConnection('sess-a', (event) => first.push(event))
    hub.replaceSessionConnection('sess-a', (event) => second.push(event))

    hub.publishSession('sess-a', {
      event: 'title',
      data: { conversationId: 'c1', title: 'Demo' },
    })

    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/streams/hub.test.ts`  
Expected: FAIL — methods not defined

- [ ] **Step 3: Implement dual hub**

Replace `messaging-api/src/streams/hub.ts` with session + legacy support:

```typescript
export type ProcessLineKind = 'reasoning' | 'tool'

export type LegacyStreamEvent =
  | { event: 'rewind'; data: { removedMessageIds: string[] } }
  | { event: 'process'; data: { kind: ProcessLineKind; text: string } }
  | { event: 'process_token'; data: { kind: 'reasoning'; text: string } }
  | { event: 'process_complete'; data: Record<string, never> }
  | { event: 'token'; data: { text: string } }
  | { event: 'title'; data: { title: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }

export type SessionStreamEvent =
  | {
      event: 'tooling'
      data: {
        conversationId: string
        runId: string
        kind?: ProcessLineKind
        text?: string
        draft?: true
        phase?: 'complete'
      }
    }
  | {
      event: 'reply'
      data: {
        conversationId: string
        runId: string
        text?: string
        phase?: 'done'
        messageId?: string
      }
    }
  | { event: 'title'; data: { conversationId: string; title: string } }
  | {
      event: 'rewind'
      data: { conversationId: string; runId: string; removedMessageIds: string[] }
    }
  | { event: 'error'; data: { conversationId: string; runId: string; code: string } }

type SessionListener = (event: SessionStreamEvent) => void
type LegacyListener = (event: LegacyStreamEvent) => void

export class StreamHub {
  private readonly sessionListeners = new Map<string, SessionListener>()
  private readonly legacyListeners = new Map<string, Set<LegacyListener>>()
  private readonly pendingRewinds = new Map<string, string[]>()

  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    this.sessionListeners.set(sessionId, listener)
    return () => {
      if (this.sessionListeners.get(sessionId) === listener) {
        this.sessionListeners.delete(sessionId)
      }
    }
  }

  replaceSessionConnection(sessionId: string, listener: SessionListener): () => void {
    const previous = this.sessionListeners.get(sessionId)
    if (previous) {
      this.sessionListeners.delete(sessionId)
    }
    return this.subscribeSession(sessionId, listener)
  }

  publishSession(sessionId: string, event: SessionStreamEvent): void {
    const listener = this.sessionListeners.get(sessionId)
    if (!listener) {
      return
    }
    try {
      listener(event)
    } catch {
      this.sessionListeners.delete(sessionId)
    }
  }

  setPendingRewind(conversationId: string, removedMessageIds: string[]): void {
    this.pendingRewinds.set(conversationId, removedMessageIds)
  }

  subscribeLegacy(conversationId: string, listener: LegacyListener): () => void {
    const listeners = this.legacyListeners.get(conversationId) ?? new Set<LegacyListener>()
    listeners.add(listener)
    this.legacyListeners.set(conversationId, listeners)

    const pendingRewind = this.pendingRewinds.get(conversationId)
    if (pendingRewind) {
      this.pendingRewinds.delete(conversationId)
      listener({ event: 'rewind', data: { removedMessageIds: pendingRewind } })
    }

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.legacyListeners.delete(conversationId)
      }
    }
  }

  publishLegacy(conversationId: string, event: LegacyStreamEvent): void {
    const listeners = this.legacyListeners.get(conversationId)
    if (!listeners) {
      return
    }

    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        listeners.delete(listener)
      }
    }

    if (listeners.size === 0) {
      this.legacyListeners.delete(conversationId)
    }
  }
}

/** @deprecated use LegacyStreamEvent */
export type StreamEvent = LegacyStreamEvent
```

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/streams/hub.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/streams/hub.ts messaging-api/test/streams/hub.test.ts
git commit -m "feat(messaging-api): add session-scoped StreamHub listeners"
```

---

## Task 5: Run event publisher (session + legacy dual publish)

**Files:**
- Create: `messaging-api/src/streams/run-event-publisher.ts`

- [ ] **Step 1: Create publisher helper**

```typescript
import type { ProcessLineKind } from './hub.js'
import type { StreamHub } from './hub.js'

export interface RunEventContext {
  hub: StreamHub
  conversationId: string
  runId: string
  originSessionId: string | null
  legacyStreamEnabled?: boolean
}

export function publishToolingDraft(ctx: RunEventContext, text: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'tooling',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        kind: 'reasoning',
        text,
        draft: true,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, {
      event: 'process_token',
      data: { kind: 'reasoning', text },
    })
  }
}

export function publishToolingLine(
  ctx: RunEventContext,
  line: { kind: ProcessLineKind; text: string },
): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'tooling',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        kind: line.kind,
        text: line.text,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'process', data: line })
  }
}

export function publishToolingComplete(ctx: RunEventContext): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'tooling',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        phase: 'complete',
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'process_complete', data: {} })
  }
}

export function publishReplyToken(ctx: RunEventContext, text: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'reply',
      data: { conversationId: ctx.conversationId, runId: ctx.runId, text },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'token', data: { text } })
  }
}

export function publishReplyDone(ctx: RunEventContext, messageId: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'reply',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        phase: 'done',
        messageId,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'done', data: { messageId } })
  }
}

export function publishRunError(ctx: RunEventContext, code: string): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'error',
      data: { conversationId: ctx.conversationId, runId: ctx.runId, code },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.publishLegacy(ctx.conversationId, { event: 'error', data: { code } })
  }
}

export function publishRewind(
  ctx: RunEventContext,
  removedMessageIds: string[],
): void {
  if (ctx.originSessionId) {
    ctx.hub.publishSession(ctx.originSessionId, {
      event: 'rewind',
      data: {
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        removedMessageIds,
      },
    })
  }
  if (ctx.legacyStreamEnabled !== false) {
    ctx.hub.setPendingRewind(ctx.conversationId, removedMessageIds)
    ctx.hub.publishLegacy(ctx.conversationId, {
      event: 'rewind',
      data: { removedMessageIds },
    })
  }
}

export function publishSessionTitle(
  hub: StreamHub,
  originSessionId: string | null,
  conversationId: string,
  title: string,
  legacyStreamEnabled = true,
): void {
  if (originSessionId) {
    hub.publishSession(originSessionId, {
      event: 'title',
      data: { conversationId, title },
    })
  }
  if (legacyStreamEnabled) {
    hub.publishLegacy(conversationId, { event: 'title', data: { title } })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add messaging-api/src/streams/run-event-publisher.ts
git commit -m "feat(messaging-api): add session and legacy run event publisher"
```

---

## Task 6: Wire `run-executor` to session events

**Files:**
- Modify: `messaging-api/src/services/run-executor.ts`
- Modify: `messaging-api/test/run-executor.test.ts`

- [ ] **Step 1: Update failing run-executor test**

In `messaging-api/test/run-executor.test.ts`, change hub subscription and expectations:

```typescript
import type { SessionStreamEvent } from '../src/streams/hub.js'

function seedConversation(db: Database.Database, originSessionId = 'sess-1') {
  // ... existing user/conversation insert ...
  db.prepare(`
    INSERT INTO message_runs (id, conversation_id, user_message_id, origin_session_id, status)
    VALUES ('run-1', 'c1', ?, ?, 'running')
  `).run(
    insertMessage(db, { conversationId: 'c1', role: 'user', content: 'Where am I?' }),
    originSessionId,
  )
}

// inside test:
const events: SessionStreamEvent[] = []
hub.subscribeSession('sess-1', (event) => events.push(event))

const runPromise = executeAssistantRun({
  // ...existing fields...
  originSessionId: 'sess-1',
})

expect(events.map((e) => e.event)).toEqual([
  'tooling',
  'tooling',
  'tooling',
  'tooling',
  'reply',
  'reply',
])
expect(events[0]).toEqual({
  event: 'tooling',
  data: {
    conversationId: 'c1',
    runId: 'run-1',
    kind: 'reasoning',
    text: 'Search',
    draft: true,
  },
})
expect(events.at(-1)).toEqual({
  event: 'reply',
  data: expect.objectContaining({ phase: 'done', messageId: assistantMessageId }),
})
```

Adjust token expectations for the two `process_token` deltas and final events accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/run-executor.test.ts`  
Expected: FAIL — old event names / missing `originSessionId`

- [ ] **Step 3: Update executeAssistantRun**

In `messaging-api/src/services/run-executor.ts`:

1. Add `originSessionId: string | null` to `ExecuteAssistantRunInput`.
2. Import publisher helpers from `../streams/run-event-publisher.js`.
3. Build `const streamCtx = { hub: input.hub, conversationId: input.conversationId, runId, originSessionId: input.originSessionId }`.
4. Replace every `input.hub.publish(input.conversationId, …)` with the matching publisher function.
5. Replace rewind block with `publishRewind(streamCtx, input.rewindMessageIds)`.

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/run-executor.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/run-executor.ts messaging-api/test/run-executor.test.ts
git commit -m "feat(messaging-api): publish session stream events from run executor"
```

---

## Task 7: `GET /events/stream` route

**Files:**
- Create: `messaging-api/src/routes/events.ts`
- Modify: `messaging-api/src/app.ts`
- Create: `messaging-api/test/session-stream.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `messaging-api/test/session-stream.test.ts` with helpers copied from `messages.test.ts` (`readUntilReplyDone`, `waitFor`).

```typescript
  it('streams tooling and reply on the session opened before POST', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo

    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(streamResponse.status).toBe(200)

    const reader = streamResponse.body?.getReader()
    expect(reader).toBeTruthy()

    await new Promise((resolve) => setTimeout(resolve, 100))

    const postResponse = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Stream from session' },
    })
    expect(postResponse.statusCode).toBe(202)

    completeTitleStream(hermesClient)
    hermesClient.pushToolCall('skills_list', '{"category":"productivity"}', 0)
    hermesClient.pushAnswerToken('One skill', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    const payload = await readUntilReplyDone(reader!)
    expect(payload).toContain('"kind":"tool"')
    expect(payload).toContain('event: tooling')
    expect(payload).toContain('"phase":"complete"')
    expect(payload).toContain('event: reply')
    expect(payload).toContain('"phase":"done"')

    const secondChunk = await reader!.read()
    expect(secondChunk.done).toBe(false)
  })
```

`readUntilReplyDone` reads until payload contains `"phase":"done"` but does **not** expect stream close.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/session-stream.test.ts -t "streams tooling"`  
Expected: FAIL — 404 route missing

- [ ] **Step 3: Implement events route**

Create `messaging-api/src/routes/events.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/stream', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.sessionId) {
      return reply.code(401).send({ error: 'session_required' })
    }

    reply.sseInit()

    let closed = false
    const pingInterval = setInterval(() => {
      if (!closed && !reply.raw.writableEnded) {
        reply.raw.write(': ping\n\n')
      }
    }, 30_000)

    const unsubscribe = app.streamHub.replaceSessionConnection(request.sessionId, (event) => {
      reply.sseSend(event.event, event.data)
    })

    const closeStream = () => {
      if (closed) {
        return
      }
      closed = true
      clearInterval(pingInterval)
      unsubscribe()
      reply.sseEnd()
    }

    request.raw.on('close', closeStream)
  })
}

export default eventsRoutes
```

Register in `messaging-api/src/app.ts`:

```typescript
import eventsRoutes from './routes/events.js'
// ...
  app.register(eventsRoutes)
```

- [ ] **Step 4: Run test**

Run: `cd messaging-api && npm test -- test/session-stream.test.ts -t "streams tooling"`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/routes/events.ts messaging-api/src/app.ts messaging-api/test/session-stream.test.ts
git commit -m "feat(messaging-api): add persistent GET /events/stream route"
```

---

## Task 8: Wire routes to pass `sessionId` and update legacy stream

**Files:**
- Modify: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/src/services/message-editor.ts`
- Modify: `messaging-api/src/services/title-generator.ts`
- Modify: `messaging-api/test/session-stream.test.ts`
- Modify: `messaging-api/test/message-editor.test.ts`

- [ ] **Step 1: Pass sessionId into createRun and executeAssistantRun**

In `messaging-api/src/routes/messages.ts` POST handler:

```typescript
const originSessionId = request.sessionId ?? 'legacy'
// inside transaction:
const runId = createRun(app.db, conversation.id, messageId, originSessionId)
// executeAssistantRun call add:
originSessionId: request.sessionId,
```

PATCH handler: pass `request.sessionId ?? 'legacy'` into `applyMessageEdit` and `executeAssistantRun`.

In `messaging-api/src/services/message-editor.ts`:

```typescript
export function applyMessageEdit(
  db: Database.Database,
  userId: string,
  conversationId: string,
  messageId: string,
  content: string,
  originSessionId: string,
): ApplyMessageEditResult {
  // ...
  const runId = createRun(db, conversationId, messageId, originSessionId)
```

- [ ] **Step 2: Update title generator**

In `messaging-api/src/services/title-generator.ts`:

```typescript
import { publishSessionTitle } from '../streams/run-event-publisher.js'

export async function generateAndSaveTitle(input: {
  db: Database.Database
  hermesClient: HermesClient
  hub: StreamHub
  conversationId: string
  userId: string
  userMessageText: string
  originSessionId: string | null
}): Promise<void> {
  // ...
  if (updated) {
    emitAccountConversationUpsert(input.db, input.userId, input.conversationId)
    publishSessionTitle(input.hub, input.originSessionId, input.conversationId, title)
  }
}
```

Update `messages.ts` `generateAndSaveTitle` call to pass `originSessionId: request.sessionId`.

- [ ] **Step 3: Update legacy stream route to use subscribeLegacy**

In `messaging-api/src/routes/messages.ts` legacy `GET /conversations/:id/stream`:

```typescript
const unsubscribe = app.streamHub.subscribeLegacy(conversation.id, (event) => {
  // unchanged sseSend + close on done/error
})
```

- [ ] **Step 4: Add two-session isolation test**

Add to `session-stream.test.ts`:

```typescript
  it('does not deliver session A run events to session B', async () => {
    const userId = app.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const sessionB = randomUUID()
    const tokenB = await app.jwt.sign({ sub: userId, username: 'operator', jti: sessionB })

    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as AddressInfo

    const streamB = await fetch(`http://127.0.0.1:${address.port}/events/stream`, {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const readerB = streamB.body!.getReader()

    await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Only for session A' },
    })

    completeTitleStream(hermesClient)
    hermesClient.pushAnswerToken('Hello', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    await waitFor(() => listMessages(app.db, conversationId).length === 2)

    const chunk = await Promise.race([
      readerB.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 500),
      ),
    ])
    expect(chunk.done).toBe(true)
  })
```

- [ ] **Step 5: Fix message-editor test createRun calls**

Update `applyMessageEdit` invocations to pass `'sess-edit'` as `originSessionId`. Update direct SQL seeds to include `origin_session_id`.

- [ ] **Step 6: Run full messaging-api tests**

Run: `cd messaging-api && npm test`  
Expected: PASS (fix any remaining `createRun` arity or `hub.subscribe` call sites)

- [ ] **Step 7: Commit**

```bash
git add messaging-api/src/routes/messages.ts messaging-api/src/services/message-editor.ts \
  messaging-api/src/services/title-generator.ts messaging-api/test/session-stream.test.ts \
  messaging-api/test/message-editor.test.ts
git commit -m "feat(messaging-api): route runs and titles to originating session"
```

---

## Task 9: Session stream edge-case tests

**Files:**
- Modify: `messaging-api/test/session-stream.test.ts`

- [ ] **Step 1: Add session_required test**

```typescript
  it('returns 401 session_required when JWT has no jti', async () => {
    const userId = app.db.prepare(`SELECT id FROM users WHERE username = 'operator'`).pluck().get() as string
    const legacyToken = await app.jwt.sign({ sub: userId, username: 'operator' })

    const response = await app.inject({
      method: 'GET',
      url: '/events/stream',
      headers: { authorization: `Bearer ${legacyToken}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'session_required' })
  })
```

- [ ] **Step 2: Add run error keeps stream open test**

Open session stream, trigger a failing Hermes run (use `FakeHermesClient` that closes without done), assert `event: error` arrives and a subsequent read does not end the stream immediately.

- [ ] **Step 3: Run tests**

Run: `cd messaging-api && npm test -- test/session-stream.test.ts`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add messaging-api/test/session-stream.test.ts
git commit -m "test(messaging-api): cover session stream auth and error lifecycle"
```

---

## Task 10: README and iOS handoff doc

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/plans/2026-06-18-companion-session-stream-ios.md`

- [ ] **Step 1: Update README**

Replace/extend the "Assistant process stream" section with:

- `GET /events/stream` persistent session SSE (v2.2.0)
- Event lanes: `tooling`, `reply`, `title`
- Legacy `GET /conversations/:id/stream` deprecated
- Cross-device: sync feeds, not live SSE on non-sending devices

- [ ] **Step 2: Write iOS reference plan (no Swift in this repo)**

Create `docs/superpowers/plans/2026-06-18-companion-session-stream-ios.md` summarizing:

- `StreamService` at login
- Event router by `conversationId`
- Handler mapping from design spec
- Remove per-send `GET /conversations/:id/stream`
- Test scenarios from design spec manual section

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/plans/2026-06-18-companion-session-stream-ios.md
git commit -m "docs: session stream operator notes and iOS handoff plan"
```

---

## Task 11 (deferred): Remove legacy per-conversation stream

**Trigger:** iOS ships session stream consumer and verification passes on device.

**Files:**
- Modify: `messaging-api/src/routes/messages.ts` — delete legacy stream route
- Modify: `messaging-api/src/streams/hub.ts` — remove legacy listeners + `run-event-publisher` legacy branch
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml` — remove deprecated path

Do **not** execute this task until iOS migration is confirmed.

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| JWT `jti` per login | Task 2 |
| `request.sessionId` | Task 2 |
| `origin_session_id` on runs | Task 3 |
| Session-keyed StreamHub | Task 4 |
| `tooling` / `reply` / `title` / `rewind` / `error` events | Tasks 5–6 |
| `GET /events/stream` persistent + keepalive | Task 7 |
| Events only to originating session | Tasks 6, 8, 9 |
| Legacy stream backward compat | Tasks 5, 8 |
| OpenAPI v2.2.0 | Task 1 |
| iOS handoff (reference only) | Task 10 |
| Remove legacy route | Task 11 (deferred) |

---

## Verification gate

Before claiming the backend phase complete:

```bash
cd messaging-api && npm test
```

All tests must pass. Manually smoke-test with curl:

```bash
# Terminal 1
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:3000/events/stream

# Terminal 2
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Use skills_list with category productivity; one skill name only."}' \
  http://localhost:3000/conversations/$CONV_ID/messages
```

Expected: `tooling` lines before `reply` tokens; stream stays open after `"phase":"done"`.