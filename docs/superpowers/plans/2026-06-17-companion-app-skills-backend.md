# Companion App Skills & iOS Bootstrap — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, `data/skills/`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. Client impact is in `docs/superpowers/plans/2026-06-17-companion-app-skills-ios.md`.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml`. A task is not done until OpenAPI matches shipped behavior.

**Goal:** Add `companion-app` index skill, separate data from format skills, store iOS-authored `bootstrap` per conversation, and forward it to Hermes instead of hardcoding skill routing in `messaging-api`.

**Architecture:** `conversations.bootstrap_prompt` column (nullable, write-only). iOS sends `bootstrap` once on first message or at conversation create. `buildHermesSystemPrompt` prepends stored bootstrap + optional JWT username safety line. Remove `COMPANION_APP_SYSTEM_PROMPT`. OpenAPI v1.9.0.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-17-companion-app-skills-design.md`  
**Client plan (reference only):** `docs/superpowers/plans/2026-06-17-companion-app-skills-ios.md`

---

## File Structure

```
data/skills/
  companion-app/SKILL.md              — CREATE: index/router skill
  companion-replies/SKILL.md          — MODIFY: parent ref, non-app location text
  companion-user-location/SKILL.md    — MODIFY: data-only
  companion-map-preview/SKILL.md      — MODIFY: LocationRecord rendering

messaging-api/
  src/
    lib/bootstrap.ts                  — CREATE: validateBootstrap()
    db/schema.ts                      — MODIFY: bootstrap_prompt column migration
    db/repos/conversations.ts         — MODIFY: row type, setBootstrapPrompt, create with bootstrap
    services/prompt-builder.ts        — MODIFY: remove COMPANION_APP_SYSTEM_PROMPT
    services/run-executor.ts          — MODIFY: pass bootstrap from conversation
    routes/messages.ts                — MODIFY: accept bootstrap on first message
    routes/conversations.ts           — MODIFY: optional bootstrap on create
  test/
    bootstrap.test.ts                 — CREATE
    startup.test.ts                   — MODIFY: new prompt builder assertions
    messages.test.ts                  — MODIFY: bootstrap HTTP + Hermes payload tests
    db.test.ts                        — MODIFY: bootstrap_prompt column assertion

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v1.9.0 (done in plan prep)
README.md                                         — MODIFY: bootstrap / remove API-owned skill text
docs/superpowers/specs/2026-06-17-companion-app-skills-design.md — MODIFY: status → Approved
```

---

## Task 1: OpenAPI v1.9.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

OpenAPI is updated in this commit before implementation. Key changes:

- `info.version`: `1.9.0`
- Changelog entry for optional `bootstrap` on `POST /conversations` and `POST /conversations/{id}/messages`
- New `CreateConversationRequest` schema with optional `bootstrap`
- `CreateMessageRequest` extended with optional `bootstrap` (minLength 1, maxLength 4000)
- Route descriptions document write-only semantics (never returned in GET)

---

## Task 2: Bootstrap validation helper

**Files:**
- Create: `messaging-api/src/lib/bootstrap.ts`
- Create: `messaging-api/test/bootstrap.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_PROMPT_MAX_LENGTH, validateBootstrap } from '../src/lib/bootstrap.js'

describe('validateBootstrap', () => {
  it('accepts non-empty trimmed text within max length', () => {
    expect(validateBootstrap('  call skill_view  ')).toBe('call skill_view')
  })

  it('rejects empty or whitespace-only', () => {
    expect(validateBootstrap('')).toBeNull()
    expect(validateBootstrap('   ')).toBeNull()
    expect(validateBootstrap(undefined)).toBeNull()
  })

  it('rejects text over max length', () => {
    expect(validateBootstrap('x'.repeat(BOOTSTRAP_PROMPT_MAX_LENGTH + 1))).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/bootstrap.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
export const BOOTSTRAP_PROMPT_MAX_LENGTH = 4000

export function validateBootstrap(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > BOOTSTRAP_PROMPT_MAX_LENGTH) {
    return null
  }

  return trimmed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- test/bootstrap.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/lib/bootstrap.ts messaging-api/test/bootstrap.test.ts
git commit -m "feat(messaging-api): add bootstrap prompt validation helper"
```

---

## Task 3: Schema migration and conversation repo

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/src/db/repos/conversations.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing column test**

Add to `messaging-api/test/db.test.ts`:

```typescript
  it('includes bootstrap_prompt on conversations', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('bootstrap_prompt')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- test/db.test.ts -t bootstrap_prompt`  
Expected: FAIL

- [ ] **Step 3: Add migration in schema.ts**

In `ensureLegacyConversationColumns`:

```typescript
  if (!columns.some((column) => column.name === 'bootstrap_prompt')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN bootstrap_prompt TEXT`)
  }
```

- [ ] **Step 4: Extend ConversationRow and repo helpers**

In `conversations.ts`:

```typescript
export interface ConversationRow {
  id: string
  user_id: string
  hermes_session_id: string
  title: string | null
  bootstrap_prompt: string | null
  created_at: string
  updated_at: string
}
```

Update all `SELECT` lists to include `bootstrap_prompt`.

Add:

```typescript
export function setBootstrapPrompt(
  db: Database.Database,
  conversationId: string,
  bootstrapPrompt: string,
): boolean {
  const result = db
    .prepare(`
      UPDATE conversations
      SET bootstrap_prompt = ?
      WHERE id = ?
        AND bootstrap_prompt IS NULL
    `)
    .run(bootstrapPrompt, conversationId)

  return result.changes === 1
}

export function createConversation(
  db: Database.Database,
  userId: string,
  hermesSessionId: string,
  bootstrapPrompt?: string | null,
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id, bootstrap_prompt, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, userId, hermesSessionId, bootstrapPrompt ?? null)
  return id
}
```

- [ ] **Step 5: Run db test**

Run: `cd messaging-api && npm test -- test/db.test.ts -t bootstrap_prompt`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/src/db/repos/conversations.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): store bootstrap_prompt on conversations"
```

---

## Task 4: Prompt builder refactor

**Files:**
- Modify: `messaging-api/src/services/prompt-builder.ts`
- Modify: `messaging-api/test/startup.test.ts`

- [ ] **Step 1: Write failing tests**

Replace `describe('prompt builder')` in `startup.test.ts`:

```typescript
describe('prompt builder', () => {
  const sampleBootstrap =
    "Before composing your reply, you MUST call skill_view(name='companion-app') and follow it."

  it('prepends stored bootstrap before transcript history', () => {
    const messages = buildHermesMessages(
      [{ role: 'user', content: 'Where am I?' }],
      { bootstrapPrompt: sampleBootstrap },
    )

    expect(messages).toEqual([
      { role: 'system', content: sampleBootstrap },
      { role: 'user', content: 'Where am I?' },
    ])
  })

  it('omits system message when bootstrap and username are absent', () => {
    const messages = buildHermesMessages([{ role: 'user', content: 'Hi' }])

    expect(messages).toEqual([{ role: 'user', content: 'Hi' }])
  })

  it('appends username safety line when bootstrap omits username', () => {
    const system = buildHermesSystemPrompt({
      bootstrapPrompt: sampleBootstrap,
      companionUsername: 'roberto',
    })

    expect(system).toContain(sampleBootstrap)
    expect(system).toContain('authenticated companion user for this conversation is "roberto"')
  })

  it('does not duplicate username when bootstrap already includes it', () => {
    const bootstrap = 'The authenticated companion user for this conversation is "roberto".'
    const system = buildHermesSystemPrompt({
      bootstrapPrompt: bootstrap,
      companionUsername: 'roberto',
    })

    expect(system).toBe(bootstrap)
  })
})
```

Update durable run test Hermes expectation — legacy conversation with no bootstrap:

```typescript
        messages: [{ role: 'user', content: 'hello' }],
```

(remove system message from expectation at line ~125)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd messaging-api && npm test -- test/startup.test.ts -t "prompt builder|streams Hermes"`  
Expected: FAIL — `buildHermesSystemPrompt` not exported; old `COMPANION_APP_SYSTEM_PROMPT` behavior

- [ ] **Step 3: Replace prompt-builder.ts**

```typescript
export interface BuildHermesMessagesOptions {
  bootstrapPrompt?: string | null
  companionUsername?: string
}

const USERNAME_SAFETY_TEMPLATE =
  'The authenticated companion user for this conversation is "{username}". Use this username for companion MCP data calls unless the user explicitly asks about someone else.'

export function buildHermesSystemPrompt(options?: BuildHermesMessagesOptions): string {
  const parts: string[] = []
  const bootstrap = options?.bootstrapPrompt?.trim()

  if (bootstrap) {
    parts.push(bootstrap)
  }

  const username = options?.companionUsername?.trim()
  if (username && !bootstrap?.includes(username)) {
    parts.push(USERNAME_SAFETY_TEMPLATE.replace('{username}', username))
  }

  return parts.join(' ')
}

export function buildHermesMessages(
  history: TranscriptMessage[],
  options?: BuildHermesMessagesOptions,
): HermesPromptMessage[] {
  const systemContent = buildHermesSystemPrompt(options)
  const messages: HermesPromptMessage[] = []

  if (systemContent) {
    messages.push({ role: 'system', content: systemContent })
  }

  return [
    ...messages,
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ]
}
```

Remove `COMPANION_APP_SYSTEM_PROMPT`, `buildCompanionAppSystemPrompt`, and `COMPANION_APP_SYSTEM_PROMPT` exports entirely.

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- test/startup.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/prompt-builder.ts messaging-api/test/startup.test.ts
git commit -m "feat(messaging-api): forward stored bootstrap to Hermes; remove hardcoded skill prompt"
```

---

## Task 5: Run executor passes bootstrap from conversation

**Files:**
- Modify: `messaging-api/src/services/run-executor.ts`

- [ ] **Step 1: Load conversation row in executeAssistantRun**

Add import:

```typescript
import { getConversationForUser } from '../db/repos/conversations.js'
```

Extend `ExecuteAssistantRunInput` with optional `userId` OR pass `bootstrapPrompt` directly. Prefer passing `bootstrapPrompt` from routes (routes already have conversation row):

```typescript
export interface ExecuteAssistantRunInput {
  ...
  bootstrapPrompt?: string | null
}
```

In `executeAssistantRun`:

```typescript
  const hermesMessages = buildHermesMessages(history, {
    bootstrapPrompt: input.bootstrapPrompt,
    companionUsername: input.companionUsername,
  })
```

- [ ] **Step 2: Update message routes to pass bootstrapPrompt**

In `routes/messages.ts`, both `executeAssistantRun` call sites:

```typescript
        bootstrapPrompt: conversation.bootstrap_prompt,
```

After first-message bootstrap storage (Task 6), re-fetch conversation or use local variable for freshly set bootstrap.

- [ ] **Step 3: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: PASS (fix any remaining `buildCompanionAppSystemPrompt` imports)

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/services/run-executor.ts messaging-api/src/routes/messages.ts
git commit -m "feat(messaging-api): pass conversation bootstrap into Hermes runs"
```

---

## Task 6: HTTP routes — accept and store bootstrap

**Files:**
- Modify: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/src/routes/conversations.ts`
- Modify: `messaging-api/test/messages.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Add to `messages.test.ts`:

```typescript
  it('stores bootstrap on the first message and forwards it to Hermes', async () => {
    const bootstrap =
      "Before composing your reply, you MUST call skill_view(name='companion-app') and follow it."

    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Where am I?', bootstrap },
    })

    expect(response.statusCode).toBe(202)
    await waitFor(() => hermesClient.requests.length >= 1)

    expect(hermesClient.requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: bootstrap,
    })

    const row = app!.db
      .prepare('SELECT bootstrap_prompt FROM conversations WHERE id = ?')
      .get(conversationId) as { bootstrap_prompt: string }
    expect(row.bootstrap_prompt).toBe(bootstrap)
  })

  it('ignores bootstrap on the second message', async () => {
    const bootstrap = 'first-only bootstrap'
    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'First', bootstrap },
    })
    await waitFor(() => listMessages(app!.db, conversationId).length >= 1)

    hermesClient.requests.length = 0
    hermesClient.pushAnswerToken('ok', 0)
    hermesClient.pushDone(0)
    hermesClient.closeWithoutDone(0)

    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Second', bootstrap: 'should be ignored' },
    })
    await waitFor(() => hermesClient.requests.length >= 1)

    expect(hermesClient.requests[0]?.messages[0]?.content).toBe(bootstrap)
  })

  it('rejects bootstrap longer than 4000 characters on first message', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Hi', bootstrap: 'x'.repeat(4001) },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('never returns bootstrap in conversation or message list responses', async () => {
    const bootstrap = 'hidden bootstrap'
    await app!.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'Hi', bootstrap },
    })

    const conversation = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const messages = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(conversation.json()).not.toHaveProperty('bootstrap_prompt')
    expect(conversation.json()).not.toHaveProperty('bootstrap')
    for (const message of messages.json().messages) {
      expect(message).not.toHaveProperty('bootstrap')
    }
  })
```

Update existing Hermes assertion that used `buildCompanionAppSystemPrompt` — expect username-only system line for conversations without bootstrap:

```typescript
    expect(hermesClient.requests[0]).toEqual({
      hermesSessionId: expect.any(String),
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('authenticated companion user for this conversation is "operator"'),
        },
        { role: 'user', content: 'What time is it?' },
      ],
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd messaging-api && npm test -- test/messages.test.ts -t bootstrap`  
Expected: FAIL

- [ ] **Step 3: Implement messages route bootstrap handling**

Extend `MessageBody`:

```typescript
interface MessageBody {
  text?: string
  content?: string
  bootstrap?: string
}
```

In POST handler transaction, before `insertMessage`:

```typescript
        const existingMessages = listMessages(app.db, conversation.id)
        const isFirstMessage = existingMessages.length === 0

        if (isFirstMessage && request.body.bootstrap !== undefined) {
          const bootstrap = validateBootstrap(request.body.bootstrap)
          if (!bootstrap) {
            throw new BootstrapValidationError()
          }
          setBootstrapPrompt(app.db, conversation.id, bootstrap)
        }
```

Define `BootstrapValidationError` or return 400 inline before transaction.

Re-fetch conversation after transaction for `bootstrap_prompt` passed to `executeAssistantRun`.

Catch validation: `return reply.code(400).send({ error: 'invalid_request' })`

- [ ] **Step 4: Implement conversations route optional bootstrap**

```typescript
  app.post('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    let bootstrapPrompt: string | null = null
    if (isCreateConversationBody(request.body)) {
      const bootstrap = validateBootstrap(request.body.bootstrap)
      if (request.body?.bootstrap !== undefined && !bootstrap) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      bootstrapPrompt = bootstrap
    }

    const conversationId = createConversation(app.db, request.userId, randomUUID(), bootstrapPrompt)
    ...
  })
```

```typescript
function isCreateConversationBody(value: unknown): value is { bootstrap?: string } {
  return typeof value === 'object' && value !== null
}
```

- [ ] **Step 5: Run messages tests**

Run: `cd messaging-api && npm test -- test/messages.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/routes/messages.ts messaging-api/src/routes/conversations.ts messaging-api/test/messages.test.ts
git commit -m "feat(messaging-api): accept bootstrap on first message and conversation create"
```

---

## Task 7: Companion skills

**Files:**
- Create: `data/skills/companion-app/SKILL.md`
- Modify: `data/skills/companion-replies/SKILL.md`
- Modify: `data/skills/companion-user-location/SKILL.md`
- Modify: `data/skills/companion-map-preview/SKILL.md`

- [ ] **Step 1: Create companion-app skill**

Create `data/skills/companion-app/SKILL.md`:

```markdown
---
name: companion-app
description: REQUIRED entry point for Companion App replies. iOS bootstrap tells Hermes to load this skill first. Routes intents to reply, block, and data skills. Does not own fence syntax.
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, index, routing, mobile]
    related_skills: [companion-replies, companion-user-location, companion-map-preview, companion-links, companion-markdown-blocks]
---

# Companion App

## Overview

Entry point for the assistant-companion iOS channel. The client bootstrap prompt instructs Hermes to call `skill_view(name='companion-app')` before composing a reply.

This skill routes by intent. It does **not** define block syntax — delegate to child skills.

Operator tasks (invites, password resets) use `companion-account-management` directly; do not route them from here.

## Reply composition

Before writing any Companion App reply, load `companion-replies` and follow its reply model.

## Intent routing

| User intent | Load (in order) | Notes |
|-------------|-----------------|-------|
| Short text answer | `companion-replies` | Plain text only |
| Rich layout (list, table, headings) | `companion-replies` → `companion-markdown-blocks` | |
| Show a place on map | `companion-replies` → `companion-map-preview` | Known coordinates required |
| Share tappable URL | `companion-replies` → `companion-links` | URLs outside `map` fences |
| "Where am I?" / current position | `companion-user-location` → `companion-replies` → `companion-map-preview` | Fetch data first |
| Route / directions | `companion-user-location` (if origin is "here") → `companion-map-preview` (+ optional `companion-links`) | |
| Location history | `companion-user-location` → plain text or `companion-markdown-blocks` | Map only if user asks to see a place |

## Workflow

1. Parse user intent from the message.
2. Load data skills if the answer needs vault data.
3. Load `companion-replies`, then only the block skills the reply needs.
4. Compose sibling parts — plain text, blocks, links — per child skills.

## Do not

- Duplicate fence syntax from `companion-map-preview`, `companion-links`, or `companion-markdown-blocks`
- Call Home Assistant for companion user location
- Route account invites from this skill
```

- [ ] **Step 2: Trim companion-user-location to data-only**

Remove lines 90–122 (Presentation section and channel plain-text layout). Update frontmatter `description` to remove "present with companion-map-preview". Add Consumers section per design spec.

- [ ] **Step 3: Update companion-map-preview**

Add **Rendering from LocationRecord** subsection after Place format with field mapping table and rules from design spec.

- [ ] **Step 4: Update companion-replies**

- Reference `companion-app` as parent entry in Overview/When to use.
- Move non-app plain-text four-line location format here (from removed companion-user-location section):

```text
Address: ...
Coordinates: lat, lon
Accuracy: Xm
Updated: 12 min ago
```

(Omit address line when `address_status: pending`.)

- [ ] **Step 5: Commit**

```bash
git add data/skills/companion-app/SKILL.md data/skills/companion-replies/SKILL.md data/skills/companion-user-location/SKILL.md data/skills/companion-map-preview/SKILL.md
git commit -m "feat(skills): add companion-app index; separate location data from presentation"
```

---

## Task 8: README and design spec status

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-17-companion-app-skills-design.md`

- [ ] **Step 1: Update README**

Replace API-owned skill injection sentence (~line 316) with:

> `messaging-api` sends `X-Hermes-Session-Key: companion-app` on every Hermes call. Skill routing is **not** hardcoded in the API — the iOS app sends a `bootstrap` prompt on the first message of each conversation; the API stores and forwards it. See `companion-app` skill and OpenAPI v1.9.0.

- [ ] **Step 2: Mark design spec Approved**

Change status line to `**Status:** Approved` and note backend plan path.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-06-17-companion-app-skills-design.md
git commit -m "docs: companion-app bootstrap README and approved design spec"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run full messaging-api test suite**

Run: `cd messaging-api && npm test`  
Expected: all tests PASS

- [ ] **Step 2: Run smoke test if present**

Run: `cd messaging-api && node scripts/smoke-test.mjs` (if env configured) or skip with note.

- [ ] **Step 3: Grep for removed symbols**

Run: `rg "COMPANION_APP_SYSTEM_PROMPT|buildCompanionAppSystemPrompt|companion-replies'" messaging-api/`  
Expected: no matches

- [ ] **Step 4: Verify companion-user-location has no map fences**

Run: `rg '```map' data/skills/companion-user-location/SKILL.md`  
Expected: no matches

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `companion-app` index skill | Task 7 |
| Data-only `companion-user-location` | Task 7 |
| LocationRecord rendering in map skill | Task 7 |
| `bootstrap_prompt` column | Task 3 |
| POST messages `bootstrap` field | Task 1, 6 |
| POST conversations optional `bootstrap` | Task 1, 6 |
| No bootstrap in GET responses | Task 6 tests |
| Remove hardcoded system prompt | Task 4 |
| Username JWT safety net | Task 4 |
| OpenAPI v1.9.0 | Task 1 |
| README update | Task 8 |