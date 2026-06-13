# Hermes messaging-api Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Fastify/TypeScript/SQLite backend that owns Hermes-backed chat persistence, auth, conversation state, durable assistant runs, SSE streaming, and location context for the iOS companion.

**Architecture:** `messaging-api` is a stateful backend, not a thin proxy. SQLite is the source of truth for users, conversations, messages, locations, and internal `message_runs`; Hermes is called with full stored history on every turn. Live SSE is best-effort for the current connection, while the backend continues the Hermes run and persists the final assistant message even if the client disconnects.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, `@fastify/jwt`, `bcryptjs`, Vitest, Docker Compose

---

## File Structure

```
messaging-api/
  package.json                         — scripts and dependencies
  tsconfig.json                        — TypeScript compiler config
  .env.example                         — local env template
  Dockerfile                           — container image for Raspberry Pi deployment
  src/
    index.ts                           — process entrypoint
    app.ts                             — Fastify construction and route registration
    config.ts                          — environment parsing
    types.ts                           — shared route/service types
    db/
      index.ts                         — SQLite bootstrap and singleton access
      schema.ts                        — schema init + startup reconciliation
      repos/
        users.ts                       — user lookup and bootstrap helpers
        sessions.ts                    — logout denylist reads/writes
        conversations.ts               — conversation CRUD + ownership checks
        messages.ts                    — transcript persistence and reads
        locations.ts                   — conversation location upsert/read/delete
        runs.ts                        — durable run lifecycle and conflict checks
    plugins/
      auth.ts                          — JWT verification + denylist enforcement
      sse.ts                           — Fastify helpers for SSE replies
    services/
      password.ts                      — password hash/verify helpers
      hermes-client.ts                 — OpenAI-compatible Hermes streaming client
      prompt-builder.ts                — full-history + silent location prompt assembly
      run-executor.ts                  — one-run orchestration, persistence, hub fanout
    streams/
      hub.ts                           — in-memory live listeners for active runs only
    routes/
      auth.ts                          — /auth/login, /auth/logout, /auth/me
      conversations.ts                 — /conversations routes
      locations.ts                     — /conversations/:id/location routes
      messages.ts                      — POST/GET message routes + GET stream
  test/
    helpers/
      app.ts                           — build test app with temp SQLite and fake Hermes client
      hermes.ts                        — controllable fake streaming Hermes client
    db.test.ts
    auth.test.ts
    conversations.test.ts
    locations.test.ts
    messages.test.ts
    startup.test.ts
```

Workspace integration changes:

```
docker-compose.yml                     — add messaging-api service and volume/port/env
Makefile                               — add operator targets for messaging-api logs/shell/config
README.md                              — document setup, bootstrap user, and verification flow
```

---

## Task 1: Scaffold the service and test harness

**Files:**
- Create: `messaging-api/package.json`
- Create: `messaging-api/tsconfig.json`
- Create: `messaging-api/.env.example`
- Create: `messaging-api/src/config.ts`
- Create: `messaging-api/src/app.ts`
- Create: `messaging-api/src/index.ts`
- Create: `messaging-api/src/types.ts`
- Create: `messaging-api/test/helpers/app.ts`

- [ ] **Step 1: Write the failing test harness import**

Create `messaging-api/test/helpers/app.ts`:

```typescript
import { buildApp } from '../../src/app.js'

export async function createTestApp() {
  return buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    hermesBaseUrl: 'http://hermes.test',
    bootstrapUsername: 'operator',
    bootstrapPassword: 'password123',
  })
}
```

- [ ] **Step 2: Run the test command to verify the scaffold is missing**

Run: `cd messaging-api && npx vitest run`

Expected: FAIL with `Cannot find module '../../src/app.js'`.

- [ ] **Step 3: Create `messaging-api/package.json`**

```json
{
  "name": "messaging-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/jwt": "^9.1.0",
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.7.0",
    "fastify": "^5.6.0",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.3.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 4: Create `messaging-api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Create `messaging-api/.env.example`**

```dotenv
PORT=3000
JWT_SECRET=change-me
HERMES_BASE_URL=http://hermes:8642
DB_PATH=/opt/data/messaging-api.sqlite
BOOTSTRAP_USERNAME=operator
BOOTSTRAP_PASSWORD=change-me
```

- [ ] **Step 6: Create the minimal app/config files**

Create `messaging-api/src/types.ts`:

```typescript
export interface AppOptions {
  dbPath: string
  jwtSecret: string
  hermesBaseUrl: string
  bootstrapUsername: string
  bootstrapPassword: string
}
```

Create `messaging-api/src/config.ts`:

```typescript
import type { AppOptions } from './types.js'

export function readConfig(env: NodeJS.ProcessEnv): AppOptions {
  return {
    dbPath: env.DB_PATH ?? '/opt/data/messaging-api.sqlite',
    jwtSecret: env.JWT_SECRET ?? 'dev-secret',
    hermesBaseUrl: env.HERMES_BASE_URL ?? 'http://localhost:8642',
    bootstrapUsername: env.BOOTSTRAP_USERNAME ?? 'operator',
    bootstrapPassword: env.BOOTSTRAP_PASSWORD ?? 'password123',
  }
}
```

Create `messaging-api/src/app.ts`:

```typescript
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import type { AppOptions } from './types.js'

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true })
  app.register(jwt, { secret: options.jwtSecret })
  app.get('/health', async () => ({ ok: true }))
  return app
}
```

Create `messaging-api/src/index.ts`:

```typescript
import { buildApp } from './app.js'
import { readConfig } from './config.js'

const config = readConfig(process.env)
const app = buildApp(config)
const port = Number(process.env.PORT ?? 3000)

await app.listen({ host: '0.0.0.0', port })
```

- [ ] **Step 7: Run tests and start the app**

Run: `cd messaging-api && npm test`

Expected: PASS with zero or one trivial suite once the harness resolves imports.

Run: `cd messaging-api && cp .env.example .env && npm run dev`

Expected: Fastify listens on `http://0.0.0.0:3000`.

- [ ] **Step 8: Commit**

```bash
git add messaging-api/package.json messaging-api/tsconfig.json messaging-api/.env.example messaging-api/src messaging-api/test/helpers/app.ts
git commit -m "feat: scaffold messaging-api service"
```

---

## Task 2: Build the SQLite schema and repository layer

**Files:**
- Create: `messaging-api/src/db/schema.ts`
- Create: `messaging-api/src/db/index.ts`
- Create: `messaging-api/src/db/repos/users.ts`
- Create: `messaging-api/src/db/repos/sessions.ts`
- Create: `messaging-api/src/db/repos/conversations.ts`
- Create: `messaging-api/src/db/repos/messages.ts`
- Create: `messaging-api/src/db/repos/locations.ts`
- Create: `messaging-api/src/db/repos/runs.ts`
- Create: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `messaging-api/test/db.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'

describe('schema', () => {
  it('creates the durable run tables', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>

    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'conversation_locations',
        'conversations',
        'message_runs',
        'messages',
        'sessions',
        'users',
      ]),
    )
  })
})
```

- [ ] **Step 2: Run the schema test to confirm failure**

Run: `cd messaging-api && npx vitest run test/db.test.ts`

Expected: FAIL with `Cannot find module '../src/db/schema.js'`.

- [ ] **Step 3: Create schema bootstrap and reconciliation**

Create `messaging-api/src/db/schema.ts`:

```typescript
import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      hermes_session_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE TABLE IF NOT EXISTS message_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      error_code TEXT,
      error_detail TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (user_message_id) REFERENCES messages(id),
      FOREIGN KEY (assistant_message_id) REFERENCES messages(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS message_runs_one_running_per_conversation
      ON message_runs (conversation_id)
      WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS conversation_locations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy_m REAL NOT NULL,
      timestamp TEXT NOT NULL,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `)
}

export function reconcileRunningRuns(db: Database.Database): number {
  const result = db
    .prepare(`
      UPDATE message_runs
      SET status = 'failed',
          error_code = 'server_restart',
          error_detail = 'Run was interrupted during API restart',
          finished_at = datetime('now')
      WHERE status = 'running'
    `)
    .run()

  return result.changes
}
```

- [ ] **Step 4: Create the DB singleton and one focused repo**

Create `messaging-api/src/db/index.ts`:

```typescript
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { initSchema, reconcileRunningRuns } from './schema.js'

let singleton: Database.Database | null = null

export function getDb(dbPath: string): Database.Database {
  if (dbPath === ':memory:') {
    const db = new Database(':memory:')
    initSchema(db)
    return db
  }

  if (singleton) return singleton
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  singleton = new Database(dbPath)
  initSchema(singleton)
  reconcileRunningRuns(singleton)
  return singleton
}
```

Create `messaging-api/src/db/repos/runs.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export function createRun(db: Database.Database, conversationId: string, userMessageId: string): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO message_runs (id, conversation_id, user_message_id, status)
    VALUES (?, ?, ?, 'running')
  `).run(id, conversationId, userMessageId)
  return id
}

export function getActiveRun(db: Database.Database, conversationId: string) {
  return db.prepare(`
    SELECT id, conversation_id, user_message_id, assistant_message_id, status
    FROM message_runs
    WHERE conversation_id = ? AND status = 'running'
  `).get(conversationId) as
    | { id: string; conversation_id: string; user_message_id: string; assistant_message_id: string | null; status: 'running' }
    | undefined
}
```

- [ ] **Step 5: Add the remaining repository functions**

Create the rest of the repo files with these interfaces:

```typescript
// users.ts
export function findUserByUsername(db: Database.Database, username: string) { /* SELECT id, username, password_hash */ }
export function ensureBootstrapUser(db: Database.Database, username: string, passwordHash: string) { /* INSERT IF MISSING */ }

// sessions.ts
export function denyToken(db: Database.Database, session: { id: string; userId: string; token: string; expiresAt: string }) { /* INSERT */ }
export function isTokenDenied(db: Database.Database, token: string): boolean { /* SELECT 1 */ }

// conversations.ts
export function createConversation(db: Database.Database, userId: string, hermesSessionId: string): string { /* INSERT */ }
export function listConversations(db: Database.Database, userId: string) { /* SELECT by user */ }
export function getConversationForUser(db: Database.Database, userId: string, conversationId: string) { /* SELECT by user + id */ }

// messages.ts
export function insertMessage(db: Database.Database, input: { conversationId: string; role: 'user' | 'assistant'; content: string }): string { /* INSERT */ }
export function listMessages(db: Database.Database, conversationId: string) { /* ordered SELECT */ }

// locations.ts
export function upsertConversationLocation(db: Database.Database, input: { conversationId: string; lat: number; lon: number; accuracyM: number; timestamp: string; mode: string; source: string }) { /* INSERT ... ON CONFLICT */ }
export function getConversationLocation(db: Database.Database, conversationId: string) { /* SELECT */ }
export function deleteConversationLocation(db: Database.Database, conversationId: string) { /* DELETE */ }
```

- [ ] **Step 6: Run repository tests**

Run: `cd messaging-api && npx vitest run test/db.test.ts`

Expected: PASS, including `message_runs` and restart reconciliation setup.

- [ ] **Step 7: Commit**

```bash
git add messaging-api/src/db messaging-api/test/db.test.ts
git commit -m "feat: add messaging-api schema and repositories"
```

---

## Task 3: Add auth, bootstrap user creation, and request authentication

**Files:**
- Create: `messaging-api/src/services/password.ts`
- Create: `messaging-api/src/plugins/auth.ts`
- Create: `messaging-api/src/routes/auth.ts`
- Modify: `messaging-api/src/app.ts`
- Create: `messaging-api/test/auth.test.ts`

- [ ] **Step 1: Write the failing auth test**

Create `messaging-api/test/auth.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>

  beforeAll(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('logs in the bootstrap user and returns a JWT', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('token')
  })
})
```

- [ ] **Step 2: Run the auth test to confirm failure**

Run: `cd messaging-api && npx vitest run test/auth.test.ts`

Expected: FAIL with `POST /auth/login` returning `404`.

- [ ] **Step 3: Create password and auth helpers**

Create `messaging-api/src/services/password.ts`:

```typescript
import bcrypt from 'bcryptjs'

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash)
}
```

Create `messaging-api/src/plugins/auth.ts`:

```typescript
import fp from 'fastify-plugin'
import type { FastifyRequest } from 'fastify'
import { isTokenDenied } from '../db/repos/sessions.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
    username: string
    bearerToken: string
  }
}

export default fp(async (app) => {
  app.decorate('authenticate', async (request: FastifyRequest) => {
    await request.jwtVerify()
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    if (!token || isTokenDenied(app.db, token)) {
      throw app.httpErrors.unauthorized()
    }

    request.userId = String(request.user.sub)
    request.username = String(request.user.username)
    request.bearerToken = token
  })
})
```

- [ ] **Step 4: Create the auth routes**

Create `messaging-api/src/routes/auth.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { findUserByUsername } from '../db/repos/users.js'
import { denyToken } from '../db/repos/sessions.js'
import { verifyPassword } from '../services/password.js'

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string }
    const user = body.username ? findUserByUsername(app.db, body.username) : undefined
    if (!user || !body.password || !(await verifyPassword(body.password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }

    const token = await reply.jwtSign({ sub: user.id, username: user.username })
    return { token }
  })

  app.post('/auth/logout', { preHandler: app.authenticate }, async (request) => {
    denyToken(app.db, {
      id: randomUUID(),
      userId: request.userId,
      token: request.bearerToken,
      expiresAt: '9999-12-31T23:59:59Z',
    })
    return { ok: true }
  })

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => ({
    id: request.userId,
    username: request.username,
  }))
}

export default authRoutes
```

- [ ] **Step 5: Register DB, bootstrap user, and auth plugin in `src/app.ts`**

```typescript
import authPlugin from './plugins/auth.js'
import authRoutes from './routes/auth.js'
import { getDb } from './db/index.js'
import { ensureBootstrapUser } from './db/repos/users.js'
import { hashPassword } from './services/password.js'

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true })
  app.register(jwt, { secret: options.jwtSecret })

  const db = getDb(options.dbPath)
  app.decorate('db', db)

  app.register(authPlugin)
  app.register(authRoutes)

  app.addHook('onReady', async () => {
    const passwordHash = await hashPassword(options.bootstrapPassword)
    ensureBootstrapUser(app.db, options.bootstrapUsername, passwordHash)
  })

  app.get('/health', async () => ({ ok: true }))
  return app
}
```

- [ ] **Step 6: Run auth tests**

Run: `cd messaging-api && npx vitest run test/auth.test.ts`

Expected: PASS for login, `/auth/me`, and logout denial after adding follow-up assertions.

- [ ] **Step 7: Commit**

```bash
git add messaging-api/src/app.ts messaging-api/src/plugins/auth.ts messaging-api/src/routes/auth.ts messaging-api/src/services/password.ts messaging-api/test/auth.test.ts
git commit -m "feat: add bootstrap auth and JWT protection"
```

---

## Task 4: Implement conversations and location routes with ownership checks

**Files:**
- Create: `messaging-api/src/routes/conversations.ts`
- Create: `messaging-api/src/routes/locations.ts`
- Modify: `messaging-api/src/app.ts`
- Create: `messaging-api/test/conversations.test.ts`
- Create: `messaging-api/test/locations.test.ts`

- [ ] **Step 1: Write the failing conversations test**

Create `messaging-api/test/conversations.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'

describe('conversations', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>
  let token = ''

  beforeAll(async () => {
    app = await createTestApp()
    await app.ready()
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    token = login.json().token
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates and lists user-owned conversations', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(create.statusCode).toBe(201)

    const list = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Add conversation and location routes**

Create `messaging-api/src/routes/conversations.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { createConversation, getConversationForUser, listConversations } from '../db/repos/conversations.js'

const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations', { preHandler: app.authenticate }, async (request) => {
    return listConversations(app.db, request.userId)
  })

  app.post('/conversations', { preHandler: app.authenticate }, async (request, reply) => {
    const id = createConversation(app.db, request.userId, randomUUID())
    const conversation = getConversationForUser(app.db, request.userId, id)
    return reply.code(201).send(conversation)
  })

  app.get('/conversations/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const conversation = getConversationForUser(app.db, request.userId, (request.params as { id: string }).id)
    if (!conversation) return reply.code(404).send({ error: 'not_found' })
    return conversation
  })
}

export default conversationRoutes
```

Create `messaging-api/src/routes/locations.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser } from '../db/repos/conversations.js'
import { deleteConversationLocation, getConversationLocation, upsertConversationLocation } from '../db/repos/locations.js'

const locationRoutes: FastifyPluginAsync = async (app) => {
  app.post('/conversations/:id/location', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const body = request.body as {
      lat: number
      lon: number
      accuracy_m: number
      timestamp: string
      mode: string
      source: string
    }

    upsertConversationLocation(app.db, {
      conversationId,
      lat: body.lat,
      lon: body.lon,
      accuracyM: body.accuracy_m,
      timestamp: body.timestamp,
      mode: body.mode,
      source: body.source,
    })

    return reply.code(204).send()
  })

  app.get('/conversations/:id/location/latest', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const location = getConversationLocation(app.db, conversationId)
    if (!location) return reply.code(404).send({ error: 'not_found' })
    return location
  })

  app.delete('/conversations/:id/location', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    deleteConversationLocation(app.db, conversationId)
    return reply.code(204).send()
  })
}

export default locationRoutes
```

- [ ] **Step 3: Register the new routes**

```typescript
import conversationRoutes from './routes/conversations.js'
import locationRoutes from './routes/locations.js'

app.register(conversationRoutes)
app.register(locationRoutes)
```

- [ ] **Step 4: Add the location test**

Create `messaging-api/test/locations.test.ts` with a create-conversation setup and these assertions:

```typescript
expect(update.statusCode).toBe(204)
expect(fetch.statusCode).toBe(200)
expect(fetch.json()).toMatchObject({
  lat: 38.7223,
  lon: -9.1393,
  accuracy_m: 12,
  mode: 'once',
  source: 'ios',
})
expect(remove.statusCode).toBe(204)
```

- [ ] **Step 5: Run the route tests**

Run: `cd messaging-api && npx vitest run test/conversations.test.ts test/locations.test.ts`

Expected: PASS, including `404` for cross-user or missing conversation access.

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/routes/conversations.ts messaging-api/src/routes/locations.ts messaging-api/src/app.ts messaging-api/test/conversations.test.ts messaging-api/test/locations.test.ts
git commit -m "feat: add conversation and location routes"
```

---

## Task 5: Implement Hermes prompt building, durable run execution, and live stream hub

**Files:**
- Create: `messaging-api/src/streams/hub.ts`
- Create: `messaging-api/src/services/prompt-builder.ts`
- Create: `messaging-api/src/services/hermes-client.ts`
- Create: `messaging-api/src/services/run-executor.ts`
- Create: `messaging-api/test/helpers/hermes.ts`
- Create: `messaging-api/test/startup.test.ts`

- [ ] **Step 1: Write the failing restart reconciliation test**

Create `messaging-api/test/startup.test.ts`:

```typescript
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema, reconcileRunningRuns } from '../src/db/schema.js'

describe('startup reconciliation', () => {
  it('marks orphaned running runs as failed', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)

    expect(reconcileRunningRuns(db)).toBe(1)
    const row = db.prepare('SELECT status, error_code FROM message_runs WHERE id = ?').get('r1') as { status: string; error_code: string }
    expect(row).toEqual({ status: 'failed', error_code: 'server_restart' })
  })
})
```

- [ ] **Step 2: Create the in-memory stream hub**

Create `messaging-api/src/streams/hub.ts`:

```typescript
type StreamEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool'; data: { name: string } }
  | { event: 'done'; data: { messageId: string } }
  | { event: 'error'; data: { code: string } }

type Listener = (event: StreamEvent) => void

export class StreamHub {
  private listeners = new Map<string, Set<Listener>>()

  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.listeners.get(conversationId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(conversationId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(conversationId)
    }
  }

  publish(conversationId: string, event: StreamEvent): void {
    for (const listener of this.listeners.get(conversationId) ?? []) listener(event)
  }
}
```

- [ ] **Step 3: Create prompt building and Hermes client interfaces**

Create `messaging-api/src/services/prompt-builder.ts`:

```typescript
interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ConversationLocation {
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
}

export function buildHermesMessages(history: TranscriptMessage[], location?: ConversationLocation) {
  const prompt = location
    ? [{
        role: 'system',
        content: `User's current location: lat ${location.lat}, lon ${location.lon}, accuracy ${location.accuracy_m}m (as of ${location.timestamp})`,
      }]
    : []

  return [...prompt, ...history]
}
```

Create `messaging-api/src/services/hermes-client.ts`:

```typescript
export interface HermesStreamEvent {
  type: 'token' | 'tool' | 'done'
  text?: string
  name?: string
}

export interface HermesClient {
  streamChat(input: {
    hermesSessionId: string
    messages: Array<{ role: string; content: string }>
  }): AsyncIterable<HermesStreamEvent>
}
```

- [ ] **Step 4: Implement the run executor**

Create `messaging-api/src/services/run-executor.ts`:

```typescript
import { getConversationLocation } from '../db/repos/locations.js'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { createRun, getActiveRun, markRunCompleted, markRunFailed } from '../db/repos/runs.js'
import { buildHermesMessages } from './prompt-builder.js'

export async function executeAssistantRun(input: {
  db: any
  hermesClient: import('./hermes-client.js').HermesClient
  hub: import('../streams/hub.js').StreamHub
  conversationId: string
  hermesSessionId: string
  userMessageId: string
}) {
  const existing = getActiveRun(input.db, input.conversationId)
  if (existing) throw new Error('run_conflict')

  const runId = createRun(input.db, input.conversationId, input.userMessageId)
  const history = listMessages(input.db, input.conversationId)
  const location = getConversationLocation(input.db, input.conversationId)
  const hermesMessages = buildHermesMessages(history, location)

  let assistantText = ''

  try {
    for await (const event of input.hermesClient.streamChat({
      hermesSessionId: input.hermesSessionId,
      messages: hermesMessages,
    })) {
      if (event.type === 'token' && event.text) {
        assistantText += event.text
        input.hub.publish(input.conversationId, { event: 'token', data: { text: event.text } })
      }
      if (event.type === 'tool' && event.name) {
        input.hub.publish(input.conversationId, { event: 'tool', data: { name: event.name } })
      }
    }

    const assistantMessageId = insertMessage(input.db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: assistantText,
    })
    markRunCompleted(input.db, runId, assistantMessageId)
    input.hub.publish(input.conversationId, { event: 'done', data: { messageId: assistantMessageId } })
    return assistantMessageId
  } catch (error) {
    markRunFailed(input.db, runId, 'hermes_stream_failed', error instanceof Error ? error.message : 'unknown')
    input.hub.publish(input.conversationId, { event: 'error', data: { code: 'hermes_stream_failed' } })
    throw error
  }
}
```

- [ ] **Step 5: Add the fake Hermes helper**

Create `messaging-api/test/helpers/hermes.ts`:

```typescript
import type { HermesClient, HermesStreamEvent } from '../../src/services/hermes-client.js'

export class FakeHermesClient implements HermesClient {
  constructor(private readonly events: HermesStreamEvent[]) {}

  async *streamChat(): AsyncIterable<HermesStreamEvent> {
    for (const event of this.events) yield event
  }
}
```

- [ ] **Step 6: Run the startup and service tests**

Run: `cd messaging-api && npx vitest run test/startup.test.ts test/db.test.ts`

Expected: PASS, including restart failure reconciliation.

- [ ] **Step 7: Commit**

```bash
git add messaging-api/src/streams/hub.ts messaging-api/src/services messaging-api/test/helpers/hermes.ts messaging-api/test/startup.test.ts
git commit -m "feat: add durable run execution and stream hub"
```

---

## Task 6: Implement message posting, message history reads, and SSE streaming

**Files:**
- Create: `messaging-api/src/plugins/sse.ts`
- Create: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/src/app.ts`
- Create: `messaging-api/test/messages.test.ts`

- [ ] **Step 1: Write the failing message route test**

Create `messaging-api/test/messages.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'

describe('messages', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>
  let token = ''
  let conversationId = ''

  beforeAll(async () => {
    app = await createTestApp()
    await app.ready()
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'operator', password: 'password123' },
    })
    token = login.json().token

    const created = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })
    conversationId = created.json().id
  })

  afterAll(async () => {
    await app.close()
  })

  it('stores the user message and later stores the assistant reply', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'What should I visit today?' },
    })

    expect(response.statusCode).toBe(202)

    const messages = await app.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(messages.statusCode).toBe(200)
    expect(messages.json().map((message: { role: string }) => message.role)).toEqual(['user', 'assistant'])
  })
})
```

- [ ] **Step 2: Add SSE reply helper**

Create `messaging-api/src/plugins/sse.ts`:

```typescript
import fp from 'fastify-plugin'

export default fp(async (app) => {
  app.decorateReply('sse', function sse(event: string, payload: unknown) {
    this.raw.write(`event: ${event}\n`)
    this.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
  })
})
```

- [ ] **Step 3: Create message routes**

Create `messaging-api/src/routes/messages.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { getConversationForUser } from '../db/repos/conversations.js'
import { getActiveRun } from '../db/repos/runs.js'
import { insertMessage, listMessages } from '../db/repos/messages.js'
import { executeAssistantRun } from '../services/run-executor.js'

const messageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    return listMessages(app.db, conversationId)
  })

  app.post('/conversations/:id/messages', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    const conversation = getConversationForUser(app.db, request.userId, conversationId)
    if (!conversation) return reply.code(404).send({ error: 'not_found' })
    if (getActiveRun(app.db, conversationId)) return reply.code(409).send({ error: 'run_in_progress' })

    const body = request.body as { text?: string }
    if (!body.text?.trim()) return reply.code(400).send({ error: 'text_required' })

    const userMessageId = insertMessage(app.db, {
      conversationId,
      role: 'user',
      content: body.text.trim(),
    })

    void executeAssistantRun({
      db: app.db,
      hermesClient: app.hermesClient,
      hub: app.streamHub,
      conversationId,
      hermesSessionId: conversation.hermes_session_id,
      userMessageId,
    })

    return reply.code(202).send({ accepted: true, userMessageId })
  })

  app.get('/conversations/:id/stream', { preHandler: app.authenticate }, async (request, reply) => {
    const conversationId = (request.params as { id: string }).id
    if (!getConversationForUser(app.db, request.userId, conversationId)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (!getActiveRun(app.db, conversationId)) return reply.code(404).send({ error: 'no_active_run' })

    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')

    const unsubscribe = app.streamHub.subscribe(conversationId, (event) => {
      reply.sse(event.event, event.data)
      if (event.event === 'done' || event.event === 'error') {
        unsubscribe()
        reply.raw.end()
      }
    })

    request.raw.on('close', unsubscribe)
    return reply
  })
}

export default messageRoutes
```

- [ ] **Step 4: Register the message route dependencies**

In `messaging-api/src/app.ts`, decorate and register:

```typescript
import ssePlugin from './plugins/sse.js'
import messageRoutes from './routes/messages.js'
import { StreamHub } from './streams/hub.js'
import { buildHermesHttpClient } from './services/hermes-client.js'

const db = getDb(options.dbPath)
const streamHub = new StreamHub()
app.decorate('db', db)
app.decorate('streamHub', streamHub)
app.decorate('hermesClient', buildHermesHttpClient(options.hermesBaseUrl))

app.register(ssePlugin)
app.register(messageRoutes)
```

- [ ] **Step 5: Run message route tests**

Run: `cd messaging-api && npx vitest run test/messages.test.ts`

Expected: PASS for accepted message creation, conflict on concurrent run, persisted assistant reply, and `404` for `GET /stream` when no run is active.

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/plugins/sse.ts messaging-api/src/routes/messages.ts messaging-api/src/app.ts messaging-api/test/messages.test.ts
git commit -m "feat: add message posting and SSE streaming"
```

---

## Task 7: Integrate with the workspace Docker deployment and document operation

**Files:**
- Create: `messaging-api/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `Makefile`
- Modify: `README.md`

- [ ] **Step 1: Write the failing operational check**

Run: `docker compose --env-file .env config`

Expected: No `messaging-api` service yet, so the backend is not deployable from this workspace.

- [ ] **Step 2: Create the container image**

Create `messaging-api/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

CMD ["npm", "start"]
```

- [ ] **Step 3: Add the Compose service**

Modify `docker-compose.yml` to add:

```yaml
  messaging-api:
    build:
      context: ./messaging-api
    restart: unless-stopped
    depends_on:
      - hermes-gateway
    environment:
      PORT: 3000
      JWT_SECRET: ${MESSAGING_API_JWT_SECRET:-change-me}
      HERMES_BASE_URL: http://hermes:8642
      DB_PATH: /opt/data/messaging-api.sqlite
      BOOTSTRAP_USERNAME: ${MESSAGING_API_BOOTSTRAP_USERNAME:-operator}
      BOOTSTRAP_PASSWORD: ${MESSAGING_API_BOOTSTRAP_PASSWORD:-change-me}
    volumes:
      - ${HERMES_DATA_DIR}:/opt/data
    ports:
      - ${MESSAGING_API_PORT:-3000}:3000
```

- [ ] **Step 4: Add operator targets**

Modify `Makefile` help text and add:

```make
		'make messaging-api-logs   Show messaging-api logs' \
		'make messaging-api-shell  Open a shell inside the messaging-api container' \

messaging-api-logs:
	@$(COMPOSE) logs --tail=150 messaging-api

messaging-api-shell:
	@docker exec -it messaging-api sh
```

- [ ] **Step 5: Update the README**

Add a `Messaging API setup` section to `README.md` with:

```md
## Messaging API setup

The iOS companion talks to a private `messaging-api` service running alongside Hermes on the Raspberry Pi.

Add these variables to `.env`:

```dotenv
MESSAGING_API_PORT=3000
MESSAGING_API_JWT_SECRET=replace-this
MESSAGING_API_BOOTSTRAP_USERNAME=operator
MESSAGING_API_BOOTSTRAP_PASSWORD=replace-this
```

Start or update the stack:

```bash
make up
```

Verify the service:

```bash
curl http://<tailscale-ip>:3000/health
make messaging-api-logs
```
```

- [ ] **Step 6: Run verification**

Run: `cd /home/rcanoff/hermes && docker compose --env-file .env config`

Expected: Rendered config includes `messaging-api` with the shared `/opt/data` mount and `HERMES_BASE_URL=http://hermes:8642`.

Run: `cd /home/rcanoff/hermes/messaging-api && npm test`

Expected: PASS for all service tests.

- [ ] **Step 7: Commit**

```bash
git add messaging-api/Dockerfile docker-compose.yml Makefile README.md
git commit -m "feat: deploy messaging-api with Hermes workspace"
```

---

## Spec Coverage Check

- Auth model: covered by Task 3, including pre-provisioned bootstrap user, long-lived JWT, and logout denylist
- Conversations and ownership checks: covered by Task 4
- Location context and invisible prompt injection: covered by Tasks 4 and 5
- Durable `message_runs`, one active run, and restart failure reconciliation: covered by Tasks 2 and 5
- Message history as source of truth and Hermes full-history calls: covered by Task 5
- `POST /messages`, `GET /messages`, and `GET /stream`: covered by Task 6
- Docker Compose deployment and operator docs: covered by Task 7

No spec gaps found. The old in-memory-only stream-registry design is intentionally replaced by a durable-run design with an in-memory listener hub for live connections only.
