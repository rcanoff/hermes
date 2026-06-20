# Companion Push Notifications — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, tests, OpenAPI, README, `.env.example`). Do **not** implement iOS/Swift changes here.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml`. A task is not done until OpenAPI matches shipped behavior.

> **BLOCKER:** §10 APNs key is TODO — ship with `APNS_ENABLED=false` until operator provisions Apple credentials.

**Goal:** APNs alert push when assistant messages or cron output commit while the user is not watching live SSE on the originating session.

**Architecture:** Client registers device tokens via `PUT /push/device`. After message commit in `run-executor` or `cron-deliver`, `push-dispatcher` selects recipients (skip origin session when SSE connected), sends via HTTP/2 APNs client. Invalid tokens deleted on 410.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, `node:http2`, `node:crypto`, Vitest

**Status:** Parked — do not execute until Apple Developer credentials exist.  
**Spec:** `docs/history/parked/push/2026-06-19-companion-push-design.md`  
**iOS reference:** `docs/history/parked/push/2026-06-19-companion-push-ios-design.md`

---

## File Structure

```
messaging-api/
  src/
    config.ts                         — MODIFY: APNS_* config
    db/schema.ts                      — MODIFY: push_devices table
    db/repos/push-devices.ts          — CREATE
    lib/push-preview.ts               — CREATE
    routes/push.ts                    — CREATE
    routes/index.ts                   — MODIFY: register push routes
    services/apns-client.ts           — CREATE
    services/push-dispatcher.ts         — CREATE
    services/run-executor.ts          — MODIFY: dispatch after persist
    db/repos/cron-deliver.ts          — MODIFY: dispatch after deliver
    streams/hub.ts                    — MODIFY: hasSessionListener
    types.ts                          — MODIFY: ApnsClient on app if needed
  test/
    push-preview.test.ts              — CREATE
    push-devices.test.ts              — CREATE
    push-routes.test.ts               — CREATE
    push-dispatcher.test.ts           — CREATE
    apns-client.test.ts               — CREATE
    run-executor.test.ts              — MODIFY: push dispatch assertions
    cron-deliver.test.ts              — MODIFY: push dispatch assertions
    helpers/apns.ts                   — CREATE: fake ApnsClient

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v2.5.0
.env.example                                        — MODIFY: APNS_*
README.md                                           — MODIFY: push setup section
```

---

## Task 0: OpenAPI v2.5.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] Bump `info.version` to `2.5.0` with changelog entry for push routes
- [ ] Add tag `push`
- [ ] Add schemas `PushDeviceRegisterRequest`, `PushDeviceDeleteRequest`, `OkResponse`
- [ ] Add `PUT /push/device` and `DELETE /push/device` with JWT security
- [ ] Document `companion` custom payload keys in description (informational; not a REST response)

---

## Task 1: Config — APNs environment

**Files:**
- Modify: `messaging-api/src/config.ts`
- Modify: `messaging-api/test/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing test**

```typescript
it('parses APNS_ENABLED false by default', () => {
  const config = loadConfig({})
  expect(config.apns.enabled).toBe(false)
})

it('requires APNS fields when enabled', () => {
  expect(() =>
    loadConfig({ APNS_ENABLED: 'true' }),
  ).toThrow(/APNS_TEAM_ID/)
})
```

- [ ] **Step 2: Run test**

Run: `cd messaging-api && npm test -- test/config.test.ts -t "APNS"`  
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
export interface ApnsConfig {
  enabled: boolean
  teamId: string
  keyId: string
  bundleId: string
  keyPath: string
  environment: 'development' | 'production'
  previewMaxChars: number
}

// In loadConfig:
const apnsEnabled = env.APNS_ENABLED === 'true'
const apns: ApnsConfig = {
  enabled: apnsEnabled,
  teamId: env.APNS_TEAM_ID ?? '',
  keyId: env.APNS_KEY_ID ?? '',
  bundleId: env.APNS_BUNDLE_ID ?? '',
  keyPath: env.APNS_KEY_PATH ?? '',
  environment: env.APNS_ENVIRONMENT === 'production' ? 'production' : 'development',
  previewMaxChars: Number(env.PUSH_PREVIEW_MAX_CHARS ?? 120),
}
if (apnsEnabled) {
  for (const [k, v] of Object.entries({ teamId: apns.teamId, keyId: apns.keyId, bundleId: apns.bundleId, keyPath: apns.keyPath })) {
    if (!v) throw new Error(`Missing APNS config: ${k}`)
  }
}
```

- [ ] **Step 4: Add `.env.example` entries (commented defaults)**

- [ ] **Step 5: Run tests — PASS**

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/config.ts messaging-api/test/config.test.ts .env.example
git commit -m "feat(api): add APNs configuration"
```

---

## Task 2: DB — `push_devices` table

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('includes push_devices table', () => {
  const db = openTestDb()
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'push_devices'`).get()
  expect(row).toBeTruthy()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add migration in `initSchema`**

```sql
CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS push_devices_device_token_idx ON push_devices (device_token);
CREATE INDEX IF NOT EXISTS push_devices_user_id_idx ON push_devices (user_id);
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

---

## Task 3: Repo — `push-devices.ts`

**Files:**
- Create: `messaging-api/src/db/repos/push-devices.ts`
- Create: `messaging-api/test/push-devices.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('push devices repo', () => {
  it('upserts by device_token and updates session_id', () => {
    const db = openTestDb()
    const userId = insertTestUser(db)
    upsertPushDevice(db, { userId, deviceToken: 'aa'.repeat(32), environment: 'development', sessionId: 'sess-1' })
    upsertPushDevice(db, { userId, deviceToken: 'aa'.repeat(32), environment: 'development', sessionId: 'sess-2' })
    const rows = listPushDevicesByUserId(db, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].session_id).toBe('sess-2')
  })

  it('reassigns token to new user', () => {
    const db = openTestDb()
    const u1 = insertTestUser(db, 'alice')
    const u2 = insertTestUser(db, 'bob')
    upsertPushDevice(db, { userId: u1, deviceToken: 'bb'.repeat(32), environment: 'development', sessionId: 's1' })
    upsertPushDevice(db, { userId: u2, deviceToken: 'bb'.repeat(32), environment: 'development', sessionId: 's2' })
    expect(listPushDevicesByUserId(db, u1)).toHaveLength(0)
    expect(listPushDevicesByUserId(db, u2)).toHaveLength(1)
  })

  it('deletes by device_token', () => {
    const db = openTestDb()
    const userId = insertTestUser(db)
    const token = 'cc'.repeat(32)
    upsertPushDevice(db, { userId, deviceToken: token, environment: 'development', sessionId: 's' })
    deletePushDevice(db, token)
    expect(listPushDevicesByUserId(db, userId)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
export interface PushDeviceRow {
  id: string
  user_id: string
  device_token: string
  platform: 'ios'
  environment: 'development' | 'production'
  session_id: string | null
}

export function upsertPushDevice(db: Database.Database, input: {
  userId: string
  deviceToken: string
  environment: 'development' | 'production'
  sessionId: string | null
}): void {
  const existing = db.prepare(`SELECT id FROM push_devices WHERE device_token = ?`).get(input.deviceToken) as { id: string } | undefined
  if (existing) {
    db.prepare(`
      UPDATE push_devices
      SET user_id = ?, environment = ?, session_id = ?, updated_at = datetime('now')
      WHERE device_token = ?
    `).run(input.userId, input.environment, input.sessionId, input.deviceToken)
    return
  }
  db.prepare(`
    INSERT INTO push_devices (id, user_id, device_token, environment, session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), input.userId, input.deviceToken, input.environment, input.sessionId)
}

export function deletePushDevice(db: Database.Database, deviceToken: string): void {
  db.prepare(`DELETE FROM push_devices WHERE device_token = ?`).run(deviceToken)
}

export function deletePushDeviceById(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM push_devices WHERE id = ?`).run(id)
}

export function listPushDevicesByUserId(db: Database.Database, userId: string): PushDeviceRow[] {
  return db.prepare(`
    SELECT id, user_id, device_token, platform, environment, session_id
    FROM push_devices WHERE user_id = ?
  `).all(userId) as PushDeviceRow[]
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

---

## Task 4: Preview helper

**Files:**
- Create: `messaging-api/src/lib/push-preview.ts`
- Create: `messaging-api/test/push-preview.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { buildPushAlert, stripPushPreview } from '../src/lib/push-preview.js'

describe('stripPushPreview', () => {
  it('truncates long text', () => {
    expect(stripPushPreview('a'.repeat(200), 120)).toBe(`${'a'.repeat(120)}…`)
  })
  it('collapses whitespace', () => {
    expect(stripPushPreview('hello\n\nworld', 120)).toBe('hello world')
  })
})

describe('buildPushAlert', () => {
  it('chat title uses conversation title', () => {
    expect(buildChatPushAlert({ title: 'Trip', content: 'Done' }).title).toBe('Trip')
  })
  it('job title uses Job prefix', () => {
    expect(buildJobPushAlert({ title: null, content: 'x', scheduleDisplay: '30 9 * * *' }).title).toBe('Job · 30 9 * * *')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```typescript
export function stripPushPreview(content: string, maxChars: number): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars)}…`
}

export function buildChatPushAlert(input: {
  title: string | null
  content: string
  maxChars?: number
}): { title: string; body: string } {
  const maxChars = input.maxChars ?? 120
  return {
    title: input.title?.trim() || 'New message',
    body: stripPushPreview(input.content, maxChars),
  }
}

export function buildJobPushAlert(input: {
  title: string | null
  content: string
  scheduleDisplay?: string | null
  maxChars?: number
}): { title: string; body: string } {
  const maxChars = input.maxChars ?? 120
  const name = input.title?.trim() || input.scheduleDisplay?.trim() || 'Scheduled job'
  return { title: `Job · ${name}`, body: stripPushPreview(input.content, maxChars) }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

---

## Task 5: StreamHub — `hasSessionListener`

**Files:**
- Modify: `messaging-api/src/streams/hub.ts`
- Modify: `messaging-api/test/streams/hub.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('hasSessionListener reflects active subscription', () => {
  const hub = new StreamHub()
  expect(hub.hasSessionListener('sess-a')).toBe(false)
  hub.subscribeSession('sess-a', () => {})
  expect(hub.hasSessionListener('sess-a')).toBe(true)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add method**

```typescript
hasSessionListener(sessionId: string): boolean {
  return this.sessionListeners.has(sessionId)
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

---

## Task 6: Fake APNs client + dispatcher

**Files:**
- Create: `messaging-api/test/helpers/apns.ts`
- Create: `messaging-api/src/services/apns-client.ts`
- Create: `messaging-api/src/services/push-dispatcher.ts`
- Create: `messaging-api/test/push-dispatcher.test.ts`

- [ ] **Step 1: Define interface in `apns-client.ts`**

```typescript
export interface ApnsSendInput {
  deviceToken: string
  environment: 'development' | 'production'
  payload: Record<string, unknown>
}

export interface ApnsSendResult =
  | { ok: true }
  | { ok: false; status: number; reason?: string; unregistered?: boolean }

export interface ApnsClient {
  send(input: ApnsSendInput): Promise<ApnsSendResult>
}

export function createApnsClient(config: ApnsConfig): ApnsClient {
  if (!config.enabled) {
    return { async send() { return { ok: true } } }
  }
  // HTTP/2 implementation: read .p8, sign ES256 JWT, POST to api.push.apple.com /3/device/{token}
  // Return { ok: false, unregistered: true } when status === 410
}
```

- [ ] **Step 2: Write failing dispatcher tests**

```typescript
describe('push dispatcher', () => {
  it('skips any device whose session_id has active SSE', async () => {
    const sends: ApnsSendInput[] = []
    const hub = new StreamHub()
    hub.subscribeSession('sess-online', () => {})
    // two devices: one online (sess-online), one offline (sess-offline)
    await notifyCommittedAssistantMessage({ apns: fakeApns(sends), hub, /* ... */ })
    expect(sends).toHaveLength(1)
    expect(sends[0].deviceToken).toBe(offlineDeviceToken)
  })

  it('cron payload uses destination jobs and Job title', async () => {
    const sends: ApnsSendInput[] = []
    await notifyCommittedCronMessage({ apns: fakeApns(sends), /* ... */ })
    expect(sends[0].payload.companion).toMatchObject({ destination: 'jobs', kind: 'cron_run' })
    expect(sends[0].payload.aps.alert.title).toMatch(/^Job · /)
  })

  it('no-ops when APNS_ENABLED false', async () => {
    const sends: ApnsSendInput[] = []
    await notifyCommittedAssistantMessage({ apns: fakeApns(sends), config: { enabled: false, ... } })
    expect(sends).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run — FAIL**

- [ ] **Step 4: Implement `push-dispatcher.ts`**

```typescript
export async function notifyCommittedAssistantMessage(input: {
  db: Database.Database
  hub: StreamHub
  apns: ApnsClient
  config: ApnsConfig
  userId: string
  conversationId: string
  messageId: string
  content: string
  conversationTitle: string | null
  originSessionId: string | null
}): Promise<void> {
  if (!input.config.enabled) return
  await dispatchToDevices({
    ...input,
    kind: 'assistant_reply',
    destination: 'conversation',
    buildAlert: () => buildChatPushAlert({ title: input.conversationTitle, content: input.content, maxChars: input.config.previewMaxChars }),
    threadId: input.conversationId,
  })
}

export async function notifyCommittedCronMessage(input: {
  db: Database.Database
  apns: ApnsClient
  config: ApnsConfig
  userId: string
  conversationId: string
  messageId: string
  content: string
  conversationTitle: string | null
  scheduleDisplay?: string | null
}): Promise<void> {
  if (!input.config.enabled) return
  await dispatchToDevices({
    ...input,
    kind: 'cron_run',
    destination: 'jobs',
    buildAlert: () => buildJobPushAlert({ title: input.conversationTitle, content: input.content, scheduleDisplay: input.scheduleDisplay, maxChars: input.config.previewMaxChars }),
    threadId: 'jobs',
  })
}

// dispatchToDevices: skip when device.session_id && hub.hasSessionListener(device.session_id)
```

- [ ] **Step 5: Implement minimal `createApnsClient` (enabled path can stub to throw in tests; real HTTP/2 in Task 7)**

- [ ] **Step 6: Run dispatcher tests — PASS**

- [ ] **Step 7: Commit**

---

## Task 7: APNs HTTP/2 client (production sender)

**Files:**
- Modify: `messaging-api/src/services/apns-client.ts`
- Create: `messaging-api/test/apns-client.test.ts`

- [ ] **Step 1: Unit-test JWT builder and host selection**

```typescript
it('selects sandbox host for development', () => {
  expect(apnsHost('development')).toBe('api.sandbox.push.apple.com')
})
it('buildApnsJwt returns three dot-separated segments', () => {
  const jwt = buildApnsJwt({ teamId: 'T', keyId: 'K', privateKeyPem })
  expect(jwt.split('.')).toHaveLength(3)
})
```

- [ ] **Step 2: Implement ES256 JWT signing with `node:crypto` + `readFileSync` for `.p8`**

- [ ] **Step 3: Implement `send()` using `node:http2.connect`**

Path: `/3/device/{deviceToken}`  
Headers: `authorization: bearer {jwt}`, `apns-topic: {bundleId}`, `apns-push-type: alert`, `apns-priority: 10`

- [ ] **Step 4: Map 410 + `reason: Unregistered` → `{ unregistered: true }`**

- [ ] **Step 5: Dispatcher deletes token on unregistered**

- [ ] **Step 6: Run all push tests — PASS**

- [ ] **Step 7: Commit**

---

## Task 8: REST routes

**Files:**
- Create: `messaging-api/src/routes/push.ts`
- Modify: `messaging-api/src/routes/index.ts` (or `app.ts` registration)
- Create: `messaging-api/test/push-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

```typescript
it('PUT /push/device upserts token', async () => {
  const app = await buildTestApp()
  const token = await login(app, 'alice', 'password')
  const res = await app.inject({
    method: 'PUT',
    url: '/push/device',
    headers: { authorization: `Bearer ${token}` },
    payload: { device_token: 'dd'.repeat(32), environment: 'development' },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})

it('rejects invalid token format', async () => {
  const res = await app.inject({ method: 'PUT', url: '/push/device', payload: { device_token: 'nope', environment: 'development' } })
  expect(res.statusCode).toBe(400)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement validation (zod)**

```typescript
const registerSchema = z.object({
  device_token: z.string().regex(/^[0-9a-f]{64}$/i),
  environment: z.enum(['development', 'production']),
})
```

- [ ] **Step 4: Wire `upsertPushDevice` with `request.userId` + `request.sessionId`**

- [ ] **Step 5: `DELETE /push/device` with same token validation**

- [ ] **Step 6: Run — PASS**

- [ ] **Step 7: Commit**

---

## Task 9: Wire triggers

**Files:**
- Modify: `messaging-api/src/services/run-executor.ts`
- Modify: `messaging-api/src/db/repos/cron-deliver.ts`
- Modify: `messaging-api/src/app.ts` (decorate `apnsClient`, `apnsConfig`)
- Modify: `messaging-api/test/run-executor.test.ts`
- Modify: `messaging-api/test/cron-deliver.test.ts`

- [ ] **Step 1: Extend `ExecuteAssistantRunInput` with optional `push?: { apns, config }` or pass via app context**

Prefer injecting dispatcher deps through `executeAssistantRun` optional field to keep tests simple:

```typescript
onAssistantMessageCommitted?: (ctx: {
  messageId: string
  content: string
}) => Promise<void>
```

- [ ] **Step 2: Call hook after `persistCompletedRun` inside try block, before `publishReplyDone`**

```typescript
await input.onAssistantMessageCommitted?.({
  messageId: assistantMessageId,
  content: assistantText,
})
```

- [ ] **Step 3: In route layer / app bootstrap, set hook to call `notifyCommittedAssistantMessage` (void promise — log errors)**

- [ ] **Step 4: In `deliverCronRun`, after successful deliver, call `notifyCommittedCronMessage`**

- [ ] **Step 5: Add run-executor test with fake apns recording sends**

- [ ] **Step 6: Add cron-deliver test — silent skips push, deliver enqueues**

- [ ] **Step 7: Run full suite**

Run: `cd messaging-api && npm test`  
Expected: PASS

- [ ] **Step 8: Commit**

---

## Task 10: README + operator docs

**Files:**
- Modify: `README.md`

- [ ] Add section: APNs key setup, `data/apns/` mount, env vars, `APNS_ENABLED=true`, matching iOS `environment`
- [ ] Note: push optional; API works with `APNS_ENABLED=false`
- [ ] Commit

---

## Self-review checklist

| Spec requirement | Task |
|------------------|------|
| `push_devices` schema | Task 2 |
| `PUT` / `DELETE /push/device` | Task 0, 8 |
| APNs payload shape | Task 6 |
| SSE suppression | Task 5, 6 |
| run-executor trigger | Task 9 |
| cron-deliver trigger | Task 9 |
| 410 token cleanup | Task 7 |
| `APNS_ENABLED=false` no-op | Task 1, 6 |
| OpenAPI v2.5.0 | Task 0 |

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-06-19-companion-push-backend.md`.

**Execution options:**

1. **Subagent-driven** — fresh subagent per task, review between tasks  
2. **Inline** — execute in this session with checkpoints

Which approach?