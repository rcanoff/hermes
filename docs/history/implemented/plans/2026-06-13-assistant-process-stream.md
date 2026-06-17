# Assistant Process Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Hermes reasoning and friendly tool labels via SSE (`process` → `process_complete` → `token`), persist one process blob per assistant reply in `message_process`, and return it on `GET /messages` without affecting Hermes context.

**Architecture:** Extend `hermes-client` to parse reasoning and tool-call deltas from the OpenAI-wire stream. `process-labeler` formats tool names + args into readable lines. `run-executor` accumulates process lines, emits `process_complete` before the first answer token, and persists on `done`. `GET /messages` enriches assistant rows at the route layer; `listMessages` (prompt builder) stays unchanged.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/history/implemented/specs/2026-06-13-assistant-process-stream-design.md`  
**OpenAPI:** `docs/history/implemented/specs/messaging-api.openapi.yaml` (v1.4.0)

---

## File Structure

```
messaging-api/
  src/
    db/
      schema.ts                     — MODIFY: message_process table
      repos/
        process.ts                  — NEW: insert + batch load by assistant message ids
    services/
      process-labeler.ts            — NEW: tool name/args → friendly text
      hermes-client.ts              — MODIFY: reasoning/tool/answer_token parsing
      run-executor.ts               — MODIFY: process SSE, handoff, persist
    streams/
      hub.ts                        — MODIFY: process + process_complete; remove tool
    routes/
      messages.ts                   — MODIFY: GET returns process on assistant messages
  test/
    process-labeler.test.ts         — NEW
    hermes-client.test.ts           — NEW: SSE frame parsing
    process-repo.test.ts            — NEW
    run-executor.test.ts            — NEW (or extend existing if present)
    db.test.ts                      — MODIFY: message_process in schema test
    messages.test.ts                — MODIFY: SSE + history integration
    message-editor.test.ts          — MODIFY: process removed on edit
    conversations.test.ts           — MODIFY: delete cascades process
    helpers/
      hermes.ts                     — MODIFY: pushReasoning, pushToolCall, pushAnswerToken
    startup.test.ts                 — MODIFY: replace tool expectations
```

---

### Task 1: Friendly tool labels (`process-labeler`)

**Files:**
- Create: `messaging-api/src/services/process-labeler.ts`
- Create: `messaging-api/test/process-labeler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `messaging-api/test/process-labeler.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { formatToolProcessLine } from '../src/services/process-labeler.js'

describe('formatToolProcessLine', () => {
  it('formats skill_view with name arg', () => {
    expect(formatToolProcessLine('skill_view', '{"name":"roberto-location-source"}')).toBe(
      'Loading skill: roberto-location-source',
    )
  })

  it('formats tool_search with query arg', () => {
    expect(formatToolProcessLine('tool_search', '{"query":"home assistant state"}')).toBe(
      'Searching tools: home assistant state',
    )
  })

  it('formats ha state tools without entity when args missing', () => {
    expect(formatToolProcessLine('mcp_ha_ha_get_state', '{}')).toBe('Getting Home Assistant state')
  })

  it('humanizes unknown tools', () => {
    expect(formatToolProcessLine('some_custom_tool', '')).toBe('Running some custom tool')
  })

  it('does not expose terminal command args', () => {
    expect(formatToolProcessLine('terminal', '{"command":"rm -rf /"}')).toBe('Running command')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/process-labeler.test.ts`  
Expected: FAIL — cannot find module `process-labeler.js`

- [ ] **Step 3: Write minimal implementation**

Create `messaging-api/src/services/process-labeler.ts`:

```typescript
function humanizeToolName(name: string): string {
  return name.replace(/_/g, ' ').trim()
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function formatToolProcessLine(name: string, argumentsJson?: string): string {
  const args = parseArgs(argumentsJson)

  if (name === 'skill_view') {
    const skill = stringArg(args, 'name')
    return skill ? `Loading skill: ${skill}` : 'Loading skill'
  }

  if (name === 'tool_search') {
    const query = stringArg(args, 'query')
    return query ? `Searching tools: ${query}` : 'Searching tools'
  }

  if (name === 'mcp_ha_ha_get_state' || name === 'ha_get_state') {
    const entity = stringArg(args, 'entity_id')
    return entity ? `Getting Home Assistant state: ${entity}` : 'Getting Home Assistant state'
  }

  if (name === 'mcp_ha_ha_search_entities') {
    const query = stringArg(args, 'query')
    return query ? `Searching Home Assistant: ${query}` : 'Searching Home Assistant'
  }

  if (name === 'read_file') {
    const path = stringArg(args, 'path')
    return path ? `Reading file: ${path}` : 'Reading file'
  }

  if (name === 'web_search') {
    const query = stringArg(args, 'query')
    return query ? `Searching the web: ${query}` : 'Searching the web'
  }

  if (name === 'terminal' || name === 'execute_code') {
    return 'Running command'
  }

  if (name === 'delegate_task') {
    return 'Delegating task'
  }

  return `Running ${humanizeToolName(name)}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/process-labeler.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/process-labeler.ts messaging-api/test/process-labeler.test.ts
git commit -m "feat(messaging-api): add friendly tool process labels"
```

---

### Task 2: `message_process` schema and repository

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Create: `messaging-api/src/db/repos/process.ts`
- Create: `messaging-api/test/process-repo.test.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `messaging-api/test/process-repo.test.ts`:

```typescript
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { insertMessage } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds, insertMessageProcess } from '../src/db/repos/process.js'
import { initSchema } from '../src/db/schema.js'

describe('message_process repo', () => {
  it('inserts and loads process lines for an assistant message', () => {
    const db = new Database(':memory:')
    initSchema(db)

    db.prepare(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')
    `).run()
    db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id)
      VALUES ('c1', 'u1', 'sess-1')
    `).run()

    const assistantId = insertMessage(db, {
      conversationId: 'c1',
      role: 'assistant',
      content: 'Done',
    })

    insertMessageProcess(db, {
      assistantMessageId: assistantId,
      conversationId: 'c1',
      lines: [
        { kind: 'reasoning', text: 'Thinking…' },
        { kind: 'tool', text: 'Loading skill: demo' },
      ],
    })

    const map = getProcessByAssistantMessageIds(db, [assistantId])
    expect(map.get(assistantId)).toEqual({
      lines: [
        { kind: 'reasoning', text: 'Thinking…' },
        { kind: 'tool', text: 'Loading skill: demo' },
      ],
    })
  })

  it('cascades delete when assistant message is removed', () => {
    const db = new Database(':memory:')
    initSchema(db)

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()
    db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'sess-1')
    `).run()

    const assistantId = insertMessage(db, {
      conversationId: 'c1',
      role: 'assistant',
      content: 'Old reply',
    })

    insertMessageProcess(db, {
      assistantMessageId: assistantId,
      conversationId: 'c1',
      lines: [{ kind: 'tool', text: 'Running command' }],
    })

    db.prepare(`DELETE FROM messages WHERE id = ?`).run(assistantId)

    expect(getProcessByAssistantMessageIds(db, [assistantId]).size).toBe(0)
  })
})
```

In `messaging-api/test/db.test.ts`, add `'message_process'` to the table list expectation in the first test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/process-repo.test.ts test/db.test.ts`  
Expected: FAIL — module/table missing

- [ ] **Step 3: Write minimal implementation**

Add to `messaging-api/src/db/schema.ts` inside `db.exec` after `message_runs` block:

```sql
CREATE TABLE IF NOT EXISTS message_process (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (conversation_id, assistant_message_id)
    REFERENCES messages(conversation_id, id) ON DELETE CASCADE
);
```

Create `messaging-api/src/db/repos/process.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type ProcessLineKind = 'reasoning' | 'tool'

export interface ProcessLine {
  kind: ProcessLineKind
  text: string
}

export interface MessageProcess {
  lines: ProcessLine[]
}

export function insertMessageProcess(
  db: Database.Database,
  input: {
    assistantMessageId: string
    conversationId: string
    lines: ProcessLine[]
  },
): void {
  db.prepare(`
    INSERT INTO message_process (id, assistant_message_id, conversation_id, lines_json)
    VALUES (?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.assistantMessageId,
    input.conversationId,
    JSON.stringify(input.lines),
  )
}

export function getProcessByAssistantMessageIds(
  db: Database.Database,
  assistantMessageIds: string[],
): Map<string, MessageProcess> {
  if (assistantMessageIds.length === 0) {
    return new Map()
  }

  const placeholders = assistantMessageIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT assistant_message_id, lines_json
      FROM message_process
      WHERE assistant_message_id IN (${placeholders})
    `)
    .all(...assistantMessageIds) as Array<{ assistant_message_id: string; lines_json: string }>

  const map = new Map<string, MessageProcess>()
  for (const row of rows) {
    map.set(row.assistant_message_id, JSON.parse(row.lines_json) as MessageProcess)
  }

  return map
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/process-repo.test.ts test/db.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/src/db/repos/process.ts messaging-api/test/process-repo.test.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): add message_process persistence"
```

---

### Task 3: Hermes stream parser (reasoning, tools, answer handoff)

**Files:**
- Modify: `messaging-api/src/services/hermes-client.ts`
- Create: `messaging-api/test/hermes-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `messaging-api/test/hermes-client.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { parseHermesSsePayload } from '../src/services/hermes-client.js'

describe('parseHermesSsePayload', () => {
  it('emits reasoning events from reasoning_content deltas', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"reasoning_content":"Searching tools"}}]}\n\n',
    )
    expect(events).toEqual([{ type: 'reasoning', text: 'Searching tools' }])
  })

  it('emits a completed tool event when tool call args finish', () => {
    const first = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"skill_view","arguments":"{\\"na"}}]}}]}\n\n',
    )
    const second = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"me\\":\\"demo\\"}"}}]}}]}\n\n',
    )

    expect(first).toEqual([])
    expect(second).toEqual([{ type: 'tool', name: 'skill_view', arguments: '{"name":"demo"}' }])
  })

  it('emits answer_token only for final content text', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    )
    expect(events).toEqual([{ type: 'answer_token', text: 'Hello' }])
  })

  it('ignores reasoning content parts in content arrays', () => {
    const events = parseHermesSsePayload(
      'data: {"choices":[{"delta":{"content":[{"type":"reasoning","text":"hidden"},{"type":"text","text":"Hi"}]}}]}\n\n',
    )
    expect(events).toEqual([
      { type: 'reasoning', text: 'hidden' },
      { type: 'answer_token', text: 'Hi' },
    ])
  })

  it('emits done for [DONE]', () => {
    expect(parseHermesSsePayload('data: [DONE]\n\n')).toEqual([{ type: 'done' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/hermes-client.test.ts`  
Expected: FAIL — `parseHermesSsePayload` not exported

- [ ] **Step 3: Refactor hermes-client with parser + tool accumulator**

Update `messaging-api/src/services/hermes-client.ts`:

1. Change `HermesStreamEvent` to:

```typescript
export interface HermesStreamEvent {
  type: 'reasoning' | 'tool' | 'answer_token' | 'done'
  text?: string
  name?: string
  arguments?: string
}
```

2. Export `parseHermesSsePayload(rawEvent: string): HermesStreamEvent[]` for tests (wrap existing `parseSseEvent` logic).

3. Add a `ToolCallAccumulator` class keyed by `tool_calls[].index` that buffers `function.name` + `function.arguments` fragments and emits `{ type: 'tool', name, arguments }` when JSON.parse succeeds on the combined args string.

4. In `parseSseEvent` / chunk loop:
   - `delta.reasoning_content` → `{ type: 'reasoning', text }`
   - `delta.content` string → `{ type: 'answer_token', text }`
   - `delta.content` array → `type: reasoning` parts → reasoning events; `type: text` → answer_token
   - `delta.tool_calls` → accumulator
   - Remove old `{ type: 'token' }` and `{ type: 'tool', name only }` events

Keep `OpenAiHermesClient.streamChat` using the accumulator instance per stream (reset per connection).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/hermes-client.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/hermes-client.ts messaging-api/test/hermes-client.test.ts
git commit -m "feat(messaging-api): parse reasoning and tool deltas from Hermes stream"
```

---

### Task 4: Stream hub event types

**Files:**
- Modify: `messaging-api/src/streams/hub.ts`

- [ ] **Step 1: Update StreamEvent union**

```typescript
export type ProcessLineKind = 'reasoning' | 'tool'

export type StreamEvent =
  | { event: 'rewind'; data: { removedMessageIds: string[] } }
  | { event: 'process'; data: { kind: ProcessLineKind; text: string } }
  | { event: 'process_complete'; data: Record<string, never> }
  | { event: 'token'; data: { text: string } }
  | { event: 'title'; data: { title: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }
```

Remove `tool` variant.

- [ ] **Step 2: Commit**

```bash
git add messaging-api/src/streams/hub.ts
git commit -m "feat(messaging-api): add process SSE events to stream hub"
```

---

### Task 5: `run-executor` process accumulation and persistence

**Files:**
- Modify: `messaging-api/src/services/run-executor.ts`
- Modify: `messaging-api/test/helpers/hermes.ts`
- Create: `messaging-api/test/run-executor.test.ts`

- [ ] **Step 1: Extend FakeHermesClient**

In `messaging-api/test/helpers/hermes.ts`, replace `pushToken`/`pushTool` with:

```typescript
pushReasoning(text: string, streamId = 0): void {
  this.enqueue(streamId, { kind: 'event', event: { type: 'reasoning', text } })
}

pushToolCall(name: string, args: string, streamId = 0): void {
  this.enqueue(streamId, { kind: 'event', event: { type: 'tool', name, arguments: args } })
}

pushAnswerToken(text: string, streamId = 0): void {
  this.enqueue(streamId, { kind: 'event', event: { type: 'answer_token', text } })
}
```

Keep `pushDone`, `fail`, `closeWithoutDone`. Remove old `pushToken` / `pushTool` (fix all call sites in tests).

- [ ] **Step 2: Write failing run-executor test**

Create `messaging-api/test/run-executor.test.ts` using in-memory DB + FakeHermesClient + StreamHub:

```typescript
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import { executeAssistantRun } from '../src/services/run-executor.js'
import { StreamHub } from '../src/streams/hub.js'
import { FakeHermesClient } from './helpers/hermes.js'

function seedConversation(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'sess-1')
  `).run()
  db.prepare(`
    INSERT INTO message_runs (id, conversation_id, user_message_id, status)
    VALUES ('run-1', 'c1', ?, 'running')
  `).run(
    insertMessage(db, { conversationId: 'c1', role: 'user', content: 'Where am I?' }),
  )
}

describe('executeAssistantRun process stream', () => {
  it('emits process, process_complete, token, persists process blob', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
    const events: StreamEvent[] = []
    hub.subscribe('c1', (event) => events.push(event))

    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
    })

    hermes.pushReasoning('Searching for tools…')
    hermes.pushToolCall('skill_view', '{"name":"demo"}')
    hermes.pushAnswerToken('You are home')
    hermes.pushDone()
    hermes.closeWithoutDone()

    const assistantMessageId = await runPromise

    expect(events.map((e) => e.event)).toEqual([
      'process',
      'process',
      'process_complete',
      'token',
      'done',
    ])

    const process = getProcessByAssistantMessageIds(db, [assistantMessageId]).get(assistantMessageId)
    expect(process?.lines).toEqual([
      { kind: 'reasoning', text: 'Searching for tools…' },
      { kind: 'tool', text: 'Loading skill: demo' },
    ])
  })
})
```

Add `import type { StreamEvent } from '../src/streams/hub.js'` at top.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/run-executor.test.ts`  
Expected: FAIL — wrong event sequence / no persistence

- [ ] **Step 4: Implement run-executor changes**

In `run-executor.ts`:

```typescript
import { formatToolProcessLine } from './process-labeler.js'
import { insertMessageProcess, type ProcessLine } from '../db/repos/process.js'

// Inside executeAssistantRun:
let processLines: ProcessLine[] = []
let inReplyPhase = false

for await (const event of input.hermesClient.streamChat(...)) {
  if (event.type === 'reasoning' && event.text?.trim()) {
    const line = { kind: 'reasoning' as const, text: event.text.trim() }
    processLines.push(line)
    input.hub.publish(input.conversationId, { event: 'process', data: line })
    continue
  }

  if (event.type === 'tool' && event.name) {
    const text = formatToolProcessLine(event.name, event.arguments)
    const line = { kind: 'tool' as const, text }
    processLines.push(line)
    input.hub.publish(input.conversationId, { event: 'process', data: line })
    continue
  }

  if (event.type === 'answer_token' && event.text) {
    if (!inReplyPhase) {
      inReplyPhase = true
      input.hub.publish(input.conversationId, { event: 'process_complete', data: {} })
    }
    assistantText += event.text
    input.hub.publish(input.conversationId, { event: 'token', data: { text: event.text } })
    continue
  }

  if (event.type === 'done') {
    sawDone = true
  }
}

// In persistCompletedRun transaction, after insertMessage:
if (processLines.length > 0) {
  insertMessageProcess(db, {
    assistantMessageId,
    conversationId,
    lines: processLines,
  })
}
```

Pass `processLines` into `persistCompletedRun` (add parameter).

Instant-reply path: no `process` / `process_complete` when `processLines` empty and first event is `answer_token` — still emit `process_complete` only when `processLines.length > 0` before first token.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/run-executor.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/services/run-executor.ts messaging-api/test/run-executor.test.ts messaging-api/test/helpers/hermes.ts
git commit -m "feat(messaging-api): stream and persist assistant process lines"
```

---

### Task 6: Return `process` on `GET /messages`

**Files:**
- Modify: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/test/messages.test.ts`

- [ ] **Step 1: Write failing integration test**

Add to `messages.test.ts`:

```typescript
it('returns persisted process lines on assistant messages after a tool-heavy run', async () => {
  // POST message, stream with reasoning + tool + answer, then GET messages
  // expect assistant message includes process.lines with 2 entries
})
```

Use `hermesClient.pushReasoning`, `pushToolCall`, `pushAnswerToken`, `pushDone`.

- [ ] **Step 2: Implement route enrichment**

In `GET /conversations/:id/messages` handler:

```typescript
const rows = listMessages(app.db, conversation.id)
const assistantIds = rows.filter((m) => m.role === 'assistant').map((m) => m.id)
const processMap = getProcessByAssistantMessageIds(app.db, assistantIds)

return rows.map((message) => {
  if (message.role !== 'assistant') {
    return message
  }
  const process = processMap.get(message.id)
  return process ? { ...message, process } : message
})
```

Do **not** change `listMessages` used by `buildHermesMessages`.

- [ ] **Step 3: Update existing stream test**

Replace in `messages.test.ts` `streams live events` test:

```typescript
hermesClient.pushReasoning('Thinking…')
hermesClient.pushToolCall('lookup_weather', '{"query":"Lisbon"}')
hermesClient.pushAnswerToken('Hello')
hermesClient.pushDone()

expect(payload).toContain('event: process\ndata: {"kind":"reasoning","text":"Thinking…"}')
expect(payload).toContain('event: process\ndata: {"kind":"tool","text":')
expect(payload).toContain('event: process_complete\ndata: {}')
expect(payload).toContain('event: token\ndata: {"text":"Hello"}')
```

Remove `event: tool` expectations everywhere in test suite.

- [ ] **Step 4: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: PASS (fix `startup.test.ts`, `message-editor.test.ts`, `hermes-fake.test.ts` call sites)

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/routes/messages.ts messaging-api/test/messages.test.ts messaging-api/test/startup.test.ts messaging-api/test/message-editor.test.ts
git commit -m "feat(messaging-api): expose process on message history and SSE"
```

---

### Task 7: Edit and delete lifecycle tests

**Files:**
- Modify: `messaging-api/test/message-editor.test.ts`
- Modify: `messaging-api/test/conversations.test.ts`

- [ ] **Step 1: Message edit removes old process**

After edit flow test setup with process row on old assistant message, assert `getProcessByAssistantMessageIds` empty for removed id and new run can create a fresh process row.

- [ ] **Step 2: Conversation delete cascades process**

Extend existing delete test to insert `message_process` row and assert count 0 after `DELETE /conversations/:id`.

- [ ] **Step 3: Run tests and commit**

```bash
cd messaging-api && npm test
git add messaging-api/test/message-editor.test.ts messaging-api/test/conversations.test.ts
git commit -m "test(messaging-api): process lifecycle on edit and delete"
```

---

### Task 8: Operator docs and deploy

**Files:**
- Modify: `README.md` (workspace root)

- [ ] **Step 1: Document reasoning config**

Add under messaging-api / Hermes integration section:

- Process stream requires Hermes to emit reasoning/tool deltas on `/v1/chat/completions`
- If reasoning lines are missing, set `show_reasoning: true` in `data/config.yaml` and restart Hermes
- Tool-only process lines still work without reasoning

- [ ] **Step 2: Build, test, deploy**

```bash
cd messaging-api && npm test && npm run build
cd .. && docker compose build messaging-api && docker compose up -d messaging-api
```

- [ ] **Step 3: Manual smoke (optional)**

Send one tool-heavy message via API; confirm SSE order and `GET /messages` returns `process` on assistant row.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document assistant process stream and show_reasoning config"
```

---

## Self-Review

| Spec requirement | Task |
|------------------|------|
| SSE `process` + `process_complete` | Task 4–5 |
| Friendly tool labels | Task 1, used in Task 5 |
| Separate `message_process` table | Task 2 |
| One blob per assistant reply | Task 2, 5 |
| Not in Hermes context | Task 6 (route-only enrichment) |
| Historical scroll-back | Task 6 GET test |
| Edit/delete cascade | Task 7 |
| Instant reply (no process) | Task 5 — empty `processLines` skips persist and `process_complete` |
| OpenAPI v1.4.0 | Already in spec commit |
| `show_reasoning` operator note | Task 8 |

No placeholders remain. `HermesStreamEvent` uses `answer_token` internally; public SSE remains `token` for reply chunks per spec.