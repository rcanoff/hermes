# Conversation Title Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-generate a conversation title from the first user message via Hermes, persist it, emit an SSE `title` event, and add `PATCH /conversations/:id` for manual renames.

**Architecture:** A new `title-generator` service makes a one-shot parallel Hermes call (throwaway session ID) while `executeAssistantRun` handles the assistant reply. Title persistence uses `UPDATE ... WHERE title IS NULL` so user PATCH wins races. The existing stream hub fans out a new `title` event; the stream still closes only on `done`/`error` (a late title after `done` is saved to DB but may not reach SSE — clients refetch).

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-13-conversation-title-generation-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml`

---

## File Structure

```
messaging-api/
  src/
    services/
      title-generator.ts          — NEW: prompt build, sanitize, Hermes call, save + SSE publish
    db/repos/
      conversations.ts            — MODIFY: updateConversationTitleIfNull, updateConversationTitle
    streams/
      hub.ts                      — MODIFY: add title StreamEvent variant
    routes/
      conversations.ts            — MODIFY: PATCH /conversations/:id
      messages.ts                   — MODIFY: trigger background title gen on first message
  test/
    title-generator.test.ts       — NEW: unit tests for sanitize + prompt
    conversations.test.ts         — MODIFY: PATCH route tests
    messages.test.ts              — MODIFY: title gen + SSE integration tests
    helpers/
      hermes.ts                   — MODIFY: concurrent streamChat support
```

---

### Task 1: Title sanitization and prompt builder

**Files:**
- Create: `messaging-api/src/services/title-generator.ts`
- Create: `messaging-api/test/title-generator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `messaging-api/test/title-generator.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { buildTitlePromptMessages, sanitizeGeneratedTitle } from '../src/services/title-generator.js'

describe('sanitizeGeneratedTitle', () => {
  it('trims whitespace and strips wrapping quotes', () => {
    expect(sanitizeGeneratedTitle('  "Grocery list"  ')).toBe('Grocery list')
  })

  it('removes newlines and caps length at 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeGeneratedTitle(long)).toHaveLength(80)
    expect(sanitizeGeneratedTitle('Line one\nLine two')).toBe('Line one Line two')
  })

  it('returns null for empty results', () => {
    expect(sanitizeGeneratedTitle('   ')).toBeNull()
    expect(sanitizeGeneratedTitle('""')).toBeNull()
  })
})

describe('buildTitlePromptMessages', () => {
  it('includes a system instruction and truncated user message', () => {
    const messages = buildTitlePromptMessages('What is the weather in Lisbon?')
    expect(messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('max 6 words'),
      },
      {
        role: 'user',
        content: 'What is the weather in Lisbon?',
      },
    ])
  })

  it('truncates very long user messages to 500 characters', () => {
    const long = 'x'.repeat(600)
    const messages = buildTitlePromptMessages(long)
    expect(messages[1]?.content).toHaveLength(500)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/title-generator.test.ts`  
Expected: FAIL — cannot find module `title-generator.js`

- [ ] **Step 3: Write minimal implementation**

Create `messaging-api/src/services/title-generator.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { updateConversationTitleIfNull } from '../db/repos/conversations.js'
import type { HermesClient } from './hermes-client.js'
import type { HermesPromptMessage } from './prompt-builder.js'
import type { StreamHub } from '../streams/hub.js'

const TITLE_SYSTEM_PROMPT =
  "Generate a short conversation title (max 6 words) from the user's message. Reply with only the title — no quotes, no punctuation."

const MAX_USER_MESSAGE_CHARS = 500
const MAX_GENERATED_TITLE_CHARS = 80

export function buildTitlePromptMessages(userMessageText: string): HermesPromptMessage[] {
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userMessageText.slice(0, MAX_USER_MESSAGE_CHARS) },
  ]
}

export function sanitizeGeneratedTitle(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ')
  const unquoted = collapsed.replace(/^["'`]+|["'`]+$/g, '').trim()
  const capped = unquoted.slice(0, MAX_GENERATED_TITLE_CHARS).trim()
  return capped.length > 0 ? capped : null
}

export async function generateConversationTitle(
  hermesClient: HermesClient,
  userMessageText: string,
): Promise<string | null> {
  let raw = ''

  try {
    for await (const event of hermesClient.streamChat({
      hermesSessionId: randomUUID(),
      messages: buildTitlePromptMessages(userMessageText),
    })) {
      if (event.type === 'token' && event.text) {
        raw += event.text
      }
    }
  } catch {
    return null
  }

  return sanitizeGeneratedTitle(raw)
}

export async function generateAndSaveTitle(input: {
  db: Database.Database
  hermesClient: HermesClient
  hub: StreamHub
  conversationId: string
  userMessageText: string
}): Promise<void> {
  const title = await generateConversationTitle(input.hermesClient, input.userMessageText)
  if (!title) {
    return
  }

  const updated = updateConversationTitleIfNull(input.db, input.conversationId, title)
  if (updated) {
    input.hub.publish(input.conversationId, { event: 'title', data: { title } })
  }
}
```

Add stubs in `messaging-api/src/db/repos/conversations.ts` (implemented fully in Task 2):

```typescript
export function updateConversationTitleIfNull(
  db: Database.Database,
  conversationId: string,
  title: string,
): boolean {
  const result = db
    .prepare(`
      UPDATE conversations
      SET title = ?
      WHERE id = ? AND title IS NULL
    `)
    .run(title, conversationId)

  return result.changes === 1
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/title-generator.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/title-generator.ts messaging-api/src/db/repos/conversations.ts messaging-api/test/title-generator.test.ts
git commit -m "feat(messaging-api): add title generator helpers"
```

---

### Task 2: Conversation title repo helpers

**Files:**
- Modify: `messaging-api/src/db/repos/conversations.ts`
- Modify: `messaging-api/test/conversations.test.ts`

- [ ] **Step 1: Write the failing PATCH tests**

Append to `messaging-api/test/conversations.test.ts`:

```typescript
  it('patches a conversation title for its owner', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: '  My thread  ' },
    })

    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({
      id: conversation.id,
      title: 'My thread',
    })

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.json()).toEqual([patch.json()])
  })

  it('rejects empty or oversized titles', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const empty = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: '   ' },
    })

    const oversized = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'a'.repeat(121) },
    })

    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toEqual({ error: 'invalid_request' })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json()).toEqual({ error: 'invalid_request' })
  })

  it('returns 404 when patching another user conversation', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
      payload: { title: 'Nope' },
    })

    expect(patch.statusCode).toBe(404)
    expect(patch.json()).toEqual({ error: 'not_found' })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/conversations.test.ts`  
Expected: FAIL — PATCH route missing (404)

- [ ] **Step 3: Implement repo helper and PATCH route**

In `messaging-api/src/db/repos/conversations.ts`, add:

```typescript
const MAX_CONVERSATION_TITLE_CHARS = 120

export function normalizeConversationTitle(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_CONVERSATION_TITLE_CHARS) {
    return null
  }
  return trimmed
}

export function updateConversationTitle(
  db: Database.Database,
  conversationId: string,
  title: string,
): ConversationRow | undefined {
  db.prepare(`
    UPDATE conversations
    SET title = ?
    WHERE id = ?
  `).run(title, conversationId)

  return db
    .prepare(`
      SELECT id, user_id, hermes_session_id, title, created_at
      FROM conversations
      WHERE id = ?
    `)
    .get(conversationId) as ConversationRow | undefined
}
```

In `messaging-api/src/routes/conversations.ts`, add import and route:

```typescript
import {
  createConversation,
  getConversationForUser,
  listConversations,
  normalizeConversationTitle,
  updateConversationTitle,
} from '../db/repos/conversations.js'

// inside conversationRoutes, after GET /conversations/:id:

  app.patch('/conversations/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    const existing = getConversationForUser(app.db, request.userId, conversationId)
    if (!existing) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (!isPatchConversationBody(request.body)) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const title = normalizeConversationTitle(request.body.title)
    if (!title) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const updated = updateConversationTitle(app.db, conversationId, title)
    return updated
  })

function isPatchConversationBody(value: unknown): value is { title: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { title?: unknown }).title === 'string'
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/conversations.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/repos/conversations.ts messaging-api/src/routes/conversations.ts messaging-api/test/conversations.test.ts
git commit -m "feat(messaging-api): add PATCH conversation title endpoint"
```

---

### Task 3: Stream hub title event type

**Files:**
- Modify: `messaging-api/src/streams/hub.ts`

- [ ] **Step 1: Extend StreamEvent union**

Update `messaging-api/src/streams/hub.ts`:

```typescript
export type StreamEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool'; data: { name: string } }
  | { event: 'title'; data: { title: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }
```

No dedicated test file needed — covered by message integration tests in Task 5.

- [ ] **Step 2: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: PASS (no behavior change yet)

- [ ] **Step 3: Commit**

```bash
git add messaging-api/src/streams/hub.ts
git commit -m "feat(messaging-api): add SSE title stream event type"
```

---

### Task 4: Concurrent FakeHermesClient streams

**Files:**
- Modify: `messaging-api/test/helpers/hermes.ts`

Background: title generation and assistant runs call `streamChat` concurrently. The current fake client uses one shared queue and breaks parallel calls.

- [ ] **Step 1: Write a failing concurrent-stream test**

Create `messaging-api/test/hermes-fake.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { FakeHermesClient } from './helpers/hermes.js'

describe('FakeHermesClient concurrent streams', () => {
  it('routes events to independent streamChat calls', async () => {
    const client = new FakeHermesClient()

    const assistantPromise = (async () => {
      let text = ''
      for await (const event of client.streamChat({
        hermesSessionId: 'assistant-session',
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        if (event.type === 'token' && event.text) {
          text += event.text
        }
        if (event.type === 'done') {
          return text
        }
      }
      return text
    })()

    const titlePromise = (async () => {
      let text = ''
      for await (const event of client.streamChat({
        hermesSessionId: 'title-session',
        messages: [
          { role: 'system', content: 'Generate a short conversation title' },
          { role: 'user', content: 'Hello' },
        ],
      })) {
        if (event.type === 'token' && event.text) {
          text += event.text
        }
        if (event.type === 'done') {
          return text
        }
      }
      return text
    })()

    expect(client.requests).toHaveLength(2)

    client.pushToken('Hi', 0)
    client.pushDone(0)
    client.closeWithoutDone(0)

    client.pushToken('Greetings', 1)
    client.pushDone(1)
    client.closeWithoutDone(1)

    await expect(assistantPromise).resolves.toBe('Hi')
    await expect(titlePromise).resolves.toBe('Greetings')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/hermes-fake.test.ts`  
Expected: FAIL — `pushToken` does not accept stream index / events cross-contaminate

- [ ] **Step 3: Refactor FakeHermesClient**

Replace `messaging-api/test/helpers/hermes.ts` with:

```typescript
import type { HermesClient, HermesStreamEvent, StreamChatInput } from '../../src/services/hermes-client.js'

type QueueEntry =
  | { kind: 'event'; event: HermesStreamEvent }
  | { kind: 'error'; error: Error }
  | { kind: 'close' }

export class FakeHermesClient implements HermesClient {
  readonly requests: StreamChatInput[] = []

  private readonly queues = new Map<number, QueueEntry[]>()
  private readonly waiters = new Map<number, Array<() => void>>()
  private nextStreamId = 0

  pushToken(text: string, streamId = 0): void {
    this.push(streamId, { kind: 'event', event: { type: 'token', text } })
  }

  pushTool(name: string, streamId = 0): void {
    this.push(streamId, { kind: 'event', event: { type: 'tool', name } })
  }

  pushDone(streamId = 0): void {
    this.push(streamId, { kind: 'event', event: { type: 'done' } })
  }

  closeWithoutDone(streamId = 0): void {
    this.push(streamId, { kind: 'close' })
  }

  fail(error: Error, streamId = 0): void {
    this.push(streamId, { kind: 'error', error })
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<HermesStreamEvent> {
    const streamId = this.nextStreamId++
    this.requests.push(input)
    this.queues.set(streamId, [])
    this.waiters.set(streamId, [])

    while (true) {
      const entry = await this.nextEntry(streamId)

      if (entry.kind === 'event') {
        yield entry.event
        continue
      }

      if (entry.kind === 'error') {
        throw entry.error
      }

      return
    }
  }

  private push(streamId: number, entry: QueueEntry): void {
    const queue = this.queues.get(streamId)
    if (!queue) {
      throw new Error(`Unknown stream id ${streamId}`)
    }

    queue.push(entry)
    const waiter = this.waiters.get(streamId)?.shift()
    waiter?.()
  }

  private async nextEntry(streamId: number): Promise<QueueEntry> {
    const queue = this.queues.get(streamId)
    if (!queue) {
      throw new Error(`Unknown stream id ${streamId}`)
    }

    if (queue.length > 0) {
      return queue.shift() as QueueEntry
    }

    await new Promise<void>((resolve) => {
      this.waiters.get(streamId)?.push(resolve)
    })

    return queue.shift() as QueueEntry
  }
}
```

- [ ] **Step 4: Update existing message tests to pass streamId 0**

In `messaging-api/test/messages.test.ts`, `startup.test.ts`, and any other files using `FakeHermesClient`, existing calls like `hermesClient.pushToken('Hello')` still default to `streamId = 0` (assistant stream). No changes required unless tests start title generation (Task 5).

Run: `cd messaging-api && npm test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/test/helpers/hermes.ts messaging-api/test/hermes-fake.test.ts
git commit -m "test(messaging-api): support concurrent fake Hermes streams"
```

---

### Task 5: Wire title generation into first message POST

**Files:**
- Modify: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/test/messages.test.ts`

- [ ] **Step 1: Write failing integration tests**

Append to `messaging-api/test/messages.test.ts`:

```typescript
  it('auto-generates a title from the first message and emits an SSE title event', async () => {
    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address() as AddressInfo

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Plan a weekend in Porto' },
    })
    expect(postResponse.statusCode).toBe(202)

    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/stream`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const reader = response.body?.getReader()
    expect(reader).toBeTruthy()

    // stream 0 = assistant, stream 1 = title
    hermesClient.pushToken('Porto weekend', 1)
    hermesClient.pushDone(1)
    hermesClient.closeWithoutDone(1)

    hermesClient.pushToken('Here is', 0)
    hermesClient.pushToken(' an idea', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    const payload = await readUntilTitleOrDone(reader!)
    expect(payload).toContain('event: title\ndata: {"title":"Porto weekend"}')
    expect(payload).toContain('event: done\ndata: {"messageId":')

    await waitFor(() => {
      const row = app!.db
        .prepare('SELECT title FROM conversations WHERE id = ?')
        .get(conversationId) as { title: string | null }
      return row.title === 'Porto weekend'
    })

    expect(hermesClient.requests).toHaveLength(2)
    expect(hermesClient.requests[1]?.messages[0]?.role).toBe('system')
  })

  it('does not auto-generate a title when one is already set', async () => {
    app!.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run('Existing title', conversationId)

    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Follow up question' },
    })
    expect(postResponse.statusCode).toBe(202)

    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    expect(hermesClient.requests).toHaveLength(1)
  })

  it('does not overwrite a user title set before auto-generation finishes', async () => {
    const postResponse = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Late title generation' },
    })
    expect(postResponse.statusCode).toBe(202)

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'User chosen title' },
    })
    expect(patch.statusCode).toBe(200)

    hermesClient.pushToken('Generated title', 1)
    hermesClient.pushDone(1)
    hermesClient.closeWithoutDone(1)

    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)
    await waitFor(() => listMessages(app!.db, conversationId).length === 2)

    const row = app!.db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string | null }

    expect(row.title).toBe('User chosen title')
  })
```

Add helper at bottom of `messages.test.ts`:

```typescript
async function readUntilTitleOrDone(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let payload = ''

  while (true) {
    const { value, done } = await reader.read()
    if (value) {
      payload += decoder.decode(value, { stream: !done })
      if (payload.includes('event: done')) {
        await reader.cancel()
        return payload
      }
    }

    if (done) {
      return payload + decoder.decode()
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/messages.test.ts`  
Expected: FAIL — no title in DB, no second Hermes request

- [ ] **Step 3: Wire title generation in messages route**

Update `messaging-api/src/routes/messages.ts`:

```typescript
import { generateAndSaveTitle } from '../services/title-generator.js'

// inside POST handler, after executeAssistantRun void call:

      const shouldGenerateTitle = conversation.title === null && listMessages(app.db, conversation.id).length === 1

      void executeAssistantRun({
        db: app.db,
        hermesClient: app.hermesClient,
        hub: app.streamHub,
        conversationId: conversation.id,
        hermesSessionId: conversation.hermes_session_id,
        userMessageId: created.message.id,
        runId: created.runId,
      }).catch((error) => {
        app.log.error({ err: error, conversationId: conversation.id }, 'assistant run failed')
      })

      if (shouldGenerateTitle) {
        void generateAndSaveTitle({
          db: app.db,
          hermesClient: app.hermesClient,
          hub: app.streamHub,
          conversationId: conversation.id,
          userMessageText: content,
        }).catch((error) => {
          app.log.warn({ err: error, conversationId: conversation.id }, 'title generation failed')
        })
      }
```

Note: `shouldGenerateTitle` is evaluated inside the transaction callback scope — move the message count check to use `created.message` and query after insert:

```typescript
      const created = app.db.transaction(() => {
        const messageId = insertMessage(app.db, {
          conversationId: conversation.id,
          role: 'user',
          content,
        })
        const runId = createRun(app.db, conversation.id, messageId)
        const messages = listMessages(app.db, conversation.id)
        const message = messages.find((entry) => entry.id === messageId)

        if (!message) {
          throw new Error('message_not_found')
        }

        return { message, runId, shouldGenerateTitle: conversation.title === null && messages.length === 1 }
      })()

      // use created.shouldGenerateTitle in the if block
```

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/routes/messages.ts messaging-api/test/messages.test.ts
git commit -m "feat(messaging-api): auto-generate title on first message"
```

---

### Task 6: Final verification

**Files:**
- Verify: `docs/superpowers/specs/messaging-api.openapi.yaml` still matches behavior

- [ ] **Step 1: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: all tests PASS

- [ ] **Step 2: Run TypeScript build**

Run: `cd messaging-api && npm run build`  
Expected: compiles without errors

- [ ] **Step 3: Commit if any fixups needed**

```bash
git add -A messaging-api/
git commit -m "chore(messaging-api): verify title generation build"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Title from first user message only | Task 5 (`shouldGenerateTitle`) |
| Parallel with assistant run | Task 5 (separate void calls) |
| Throwaway Hermes session | Task 1 (`randomUUID()` in `generateConversationTitle`) |
| `UPDATE ... WHERE title IS NULL` | Task 1 / Task 2 |
| SSE `title` event | Task 3 + Task 5 |
| `PATCH /conversations/:id` | Task 2 |
| Title failure does not break assistant run | Task 5 (separate catch + warn log) |
| Concurrent FakeHermesClient | Task 4 |
| OpenAPI contract | Pre-written; verify in Task 6 |

## Out of scope (do not implement)

- iOS `title` SSE handling or rename UI
- Title regeneration endpoint
- Backfill for existing multi-message conversations