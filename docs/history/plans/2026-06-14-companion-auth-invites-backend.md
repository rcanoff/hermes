# Companion Auth Invites — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bootstrap-operator auth in `messaging-api` with invite-based account provisioning — public activate/reset routes, MCP account tools, and username-scoped location MCP tools.

**Architecture:** One-time invite tokens (SHA-256 hashed in `account_invites`) created exclusively via Hermes MCP. iOS completes onboarding through public REST routes. JWT invalidation after password change uses `users.password_changed_at` vs token `iat`. Bootstrap env vars and startup reconciliation are removed.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, `@fastify/jwt`, `@modelcontextprotocol/sdk`, `zod`, Vitest, Docker Compose

**Spec:** `docs/history/specs/2026-06-14-companion-auth-invites-backend-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v1.6.0)

---

## File Structure

```
messaging-api/
  src/
    config.ts                               — remove bootstrap; add host/expiry/min-password
    types.ts                                — update AppOptions
    db/
      schema.ts                             — account_invites; users.password_changed_at migration
      repos/
        account-invites.ts                  — NEW
        users.ts                            — createUser; password_changed_at
    plugins/
      auth.ts                               — reject JWT if iat < password_changed_at
    routes/
      auth.ts                               — invite metadata, activate, reset-password
      invite-landing.ts                     — NEW: GET /invite/:token
      mcp.ts                                — register account + updated location tools
    services/
      invites.ts                            — NEW: generate, hash, validate, URL builder
      mcp-tools.ts                          — account handlers; username on location tools
    app.ts                                  — remove bootstrap hook; register invite-landing
  test/
    helpers/
      app.ts                                — remove bootstrap defaults; add invite config
      users.ts                              — NEW: seedTestUser helper
    db.test.ts                              — account_invites table; password_changed_at column
    config.test.ts                          — updated env expectations
    auth.test.ts                            — remove bootstrap tests; keep login/logout
    invites.test.ts                         — NEW: full invite lifecycle
    mcp.test.ts                             — account tools; location username param

data/skills/
  companion-account-management/SKILL.md     — NEW
  companion-user-location/SKILL.md          — require username param

docker-compose.yml                        — remove bootstrap env; add invite env
.env.example                              — remove bootstrap; add MESSAGING_API_HOST etc.
messaging-api/.env.example                  — same
README.md                                 — invite auth setup docs
docs/superpowers/README.md                  — link plan
```

---

## Task 1: OpenAPI v1.6.0 baseline

**Files:**
- Verify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Confirm v1.6.0 documents invite auth routes**

Check the file includes:
- Version `1.6.0`
- `GET /invite/{token}`, `GET /auth/invite/{token}`
- `POST /auth/activate`, `POST /auth/reset-password`
- Schemas: `InviteMetadata`, `ActivateRequest`, `ResetPasswordRequest`
- Error codes: `invalid_token`, `weak_password`, `username_taken`

- [ ] **Step 2: Skip commit if already committed**

OpenAPI v1.6.0 was committed in `94d4a83`. Proceed to Task 2.

---

## Task 2: Config — remove bootstrap, add invite settings

**Files:**
- Modify: `messaging-api/src/types.ts`
- Modify: `messaging-api/src/config.ts`
- Modify: `messaging-api/test/helpers/app.ts`
- Modify: `messaging-api/test/config.test.ts`

- [ ] **Step 1: Write failing config test**

Replace `messaging-api/test/config.test.ts` with:

```typescript
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'

describe('readConfig', () => {
  it('fails when JWT_SECRET is missing', () => {
    expect(() =>
      readConfig({
        HERMES_BASE_URL: 'http://hermes:8642',
      }),
    ).toThrow('JWT_SECRET is required')
  })

  it('fails when MESSAGING_API_HOST is missing', () => {
    expect(() =>
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
      }),
    ).toThrow('MESSAGING_API_HOST is required')
  })

  it('returns config when required values are present', () => {
    expect(
      readConfig({
        JWT_SECRET: 'test-secret',
        HERMES_BASE_URL: 'http://hermes:8642',
        MESSAGING_API_HOST: '100.64.0.1:3000',
      }),
    ).toEqual({
      dbPath: '/opt/data/messaging-api.sqlite',
      jwtSecret: 'test-secret',
      hermesBaseUrl: 'http://hermes:8642',
      hermesApiKey: '',
      messagingApiHost: '100.64.0.1:3000',
      inviteExpiryHours: 48,
      minPasswordLength: 12,
      companionMcpBearerToken: '',
      addressEnrichmentSessionId: 'companion-address-enrichment',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npx vitest run test/config.test.ts`  
Expected: FAIL — `MESSAGING_API_HOST is required` not thrown; old bootstrap fields still present

- [ ] **Step 3: Update types and config**

In `messaging-api/src/types.ts`, replace bootstrap fields with:

```typescript
export interface AppOptions {
  dbPath: string
  jwtSecret: string
  hermesBaseUrl: string
  hermesApiKey: string
  messagingApiHost: string
  inviteExpiryHours: number
  minPasswordLength: number
  companionMcpBearerToken: string
  addressEnrichmentSessionId: string
  hermesClient?: HermesClient
  streamHub?: StreamHub
  addressEnrichmentQueue?: AddressEnrichmentQueue
  streamWaitMs?: number
}
```

In `messaging-api/src/config.ts`:

```typescript
function requireEnv(env: NodeJS.ProcessEnv, key: 'JWT_SECRET' | 'MESSAGING_API_HOST') {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`${key} is required`)
  }
  return value
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback
  }
  return parsed
}

export function readConfig(env: NodeJS.ProcessEnv): AppOptions {
  return {
    dbPath: env.DB_PATH ?? '/opt/data/messaging-api.sqlite',
    jwtSecret: requireEnv(env, 'JWT_SECRET'),
    hermesBaseUrl: env.HERMES_BASE_URL ?? 'http://localhost:8642',
    hermesApiKey: env.HERMES_API_KEY ?? '',
    messagingApiHost: requireEnv(env, 'MESSAGING_API_HOST'),
    inviteExpiryHours: readPositiveInt(env.INVITE_EXPIRY_HOURS, 48),
    minPasswordLength: readPositiveInt(env.MIN_PASSWORD_LENGTH, 12),
    companionMcpBearerToken: env.COMPANION_MCP_BEARER_TOKEN ?? '',
    addressEnrichmentSessionId: env.ADDRESS_ENRICHMENT_SESSION_ID ?? 'companion-address-enrichment',
  }
}
```

In `messaging-api/test/helpers/app.ts`:

```typescript
export async function createTestApp(overrides: Partial<AppOptions> = {}) {
  return buildApp({
    dbPath: ':memory:',
    jwtSecret: 'test-secret',
    hermesBaseUrl: 'http://hermes.test',
    hermesApiKey: 'test-api-key',
    messagingApiHost: '127.0.0.1:3000',
    inviteExpiryHours: 48,
    minPasswordLength: 12,
    companionMcpBearerToken: 'test-mcp-token',
    addressEnrichmentSessionId: 'companion-address-enrichment',
    ...overrides,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npx vitest run test/config.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/types.ts messaging-api/src/config.ts messaging-api/test/helpers/app.ts messaging-api/test/config.test.ts
git commit -m "refactor: replace bootstrap config with invite settings"
```

---

## Task 3: Schema and repositories

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Create: `messaging-api/src/db/repos/account-invites.ts`
- Modify: `messaging-api/src/db/repos/users.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing db tests**

Add to `messaging-api/test/db.test.ts`:

```typescript
it('creates account_invites table', () => {
  const tables = app.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>
  expect(tables.map((t) => t.name)).toContain('account_invites')
})

it('adds password_changed_at column to users', () => {
  const columns = app.db
    .prepare(`PRAGMA table_info(users)`)
    .all() as Array<{ name: string }>
  expect(columns.map((c) => c.name)).toContain('password_changed_at')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd messaging-api && npx vitest run test/db.test.ts -t "account_invites|password_changed_at"`  
Expected: FAIL

- [ ] **Step 3: Update schema**

Append to `initSchema` in `messaging-api/src/db/schema.ts` after the `users` CREATE:

```typescript
export function initSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_changed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- ... rest of existing DDL unchanged ...
    CREATE TABLE IF NOT EXISTS account_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('activation', 'password_reset')),
      label TEXT,
      user_id TEXT,
      revoked_at TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_account_invites_token_hash
      ON account_invites (token_hash);
    CREATE INDEX IF NOT EXISTS idx_account_invites_active
      ON account_invites (used_at, revoked_at, expires_at);
  `)

  ensureLegacyUserColumns(db)
}

function ensureLegacyUserColumns(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(users)`)
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'password_changed_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN password_changed_at TEXT`)
  }
}
```

Note: include `password_changed_at` in the CREATE for fresh DBs **and** the ALTER for existing DBs.

- [ ] **Step 4: Create account-invites repository**

Create `messaging-api/src/db/repos/account-invites.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type InviteType = 'activation' | 'password_reset'

export interface AccountInviteRow {
  id: string
  token_hash: string
  type: InviteType
  label: string | null
  user_id: string | null
  revoked_at: string | null
  expires_at: string
  used_at: string | null
  created_at: string
}

export interface CreateInviteInput {
  tokenHash: string
  type: InviteType
  label?: string | null
  userId?: string | null
  expiresAt: string
}

export function insertInvite(db: Database.Database, input: CreateInviteInput): AccountInviteRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO account_invites (id, token_hash, type, label, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.tokenHash, input.type, input.label ?? null, input.userId ?? null, input.expiresAt)

  return getInviteById(db, id)!
}

export function getInviteById(db: Database.Database, id: string): AccountInviteRow | undefined {
  return db.prepare(`SELECT * FROM account_invites WHERE id = ?`).get(id) as AccountInviteRow | undefined
}

export function getInviteByTokenHash(db: Database.Database, tokenHash: string): AccountInviteRow | undefined {
  return db
    .prepare(`SELECT * FROM account_invites WHERE token_hash = ?`)
    .get(tokenHash) as AccountInviteRow | undefined
}

export function markInviteUsed(db: Database.Database, id: string): void {
  db.prepare(`
    UPDATE account_invites
    SET used_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

export function revokeInvite(db: Database.Database, id: string): boolean {
  const result = db.prepare(`
    UPDATE account_invites
    SET revoked_at = datetime('now')
    WHERE id = ?
      AND used_at IS NULL
      AND revoked_at IS NULL
  `).run(id)
  return result.changes > 0
}

export function listPendingInvites(db: Database.Database): AccountInviteRow[] {
  return db
    .prepare(`
      SELECT * FROM account_invites
      WHERE used_at IS NULL
        AND revoked_at IS NULL
        AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC
    `)
    .all() as AccountInviteRow[]
}

export function listUsers(db: Database.Database): Array<{ id: string; username: string; created_at: string }> {
  return db
    .prepare(`
      SELECT id, username, created_at
      FROM users
      ORDER BY created_at ASC
    `)
    .all() as Array<{ id: string; username: string; created_at: string }>
}
```

- [ ] **Step 5: Extend users repository**

Add to `messaging-api/src/db/repos/users.ts`:

```typescript
export interface UserRow {
  id: string
  username: string
  password_hash: string
  password_changed_at: string | null
  created_at: string
}

export function createUser(
  db: Database.Database,
  input: { username: string; passwordHash: string; passwordChangedAt: string },
): UserRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO users (id, username, password_hash, password_changed_at)
    VALUES (?, ?, ?, ?)
  `).run(id, input.username, input.passwordHash, input.passwordChangedAt)

  return findUserById(db, id)!
}

export function updateUserPassword(
  db: Database.Database,
  id: string,
  passwordHash: string,
  passwordChangedAt: string,
): void {
  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_changed_at = ?
    WHERE id = ?
  `).run(passwordHash, passwordChangedAt, id)
}
```

Update `findUserByUsername` / `findUserById` SELECT lists to include `password_changed_at`.

Remove `ensureBootstrapUser` (or leave unused and delete in Task 8).

- [ ] **Step 6: Run db tests**

Run: `cd messaging-api && npx vitest run test/db.test.ts`  
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/src/db/repos/account-invites.ts messaging-api/src/db/repos/users.ts messaging-api/test/db.test.ts
git commit -m "feat: add account_invites schema and user password_changed_at"
```

---

## Task 4: Invite service

**Files:**
- Create: `messaging-api/src/services/invites.ts`
- Create: `messaging-api/test/invites-service.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `messaging-api/test/invites-service.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  buildInviteUrl,
  generateInviteToken,
  hashInviteToken,
  isUsernameValid,
  validatePassword,
} from '../src/services/invites.js'

describe('invite service', () => {
  it('generates url-safe tokens and stable hashes', () => {
    const raw = generateInviteToken()
    expect(raw.length).toBeGreaterThan(30)
    expect(hashInviteToken(raw)).toHaveLength(64)
  })

  it('builds invite urls from host and token', () => {
    expect(buildInviteUrl('100.64.0.1:3000', 'abc123')).toBe(
      'http://100.64.0.1:3000/invite/abc123',
    )
  })

  it('validates usernames', () => {
    expect(isUsernameValid('roberto')).toBe(true)
    expect(isUsernameValid('ab')).toBe(false)
    expect(isUsernameValid('bad name')).toBe(false)
  })

  it('validates password length', () => {
    expect(validatePassword('short', 12)).toEqual({ ok: false })
    expect(validatePassword('long-enough-pass', 12)).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npx vitest run test/invites-service.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement invite service**

Create `messaging-api/src/services/invites.ts`:

```typescript
import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  getInviteByTokenHash,
  insertInvite,
  type AccountInviteRow,
  type InviteType,
} from '../db/repos/account-invites.js'

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function buildInviteUrl(host: string, rawToken: string): string {
  return `http://${host}/invite/${rawToken}`
}

export function isUsernameValid(username: string): boolean {
  return USERNAME_PATTERN.test(username)
}

export function validatePassword(password: string, minLength: number): { ok: true } | { ok: false } {
  if (password.length < minLength) {
    return { ok: false }
  }
  return { ok: true }
}

export type InviteLookupResult =
  | { valid: true; invite: AccountInviteRow }
  | { valid: false; reason: 'expired' | 'used' | 'not_found' | 'revoked' }

export function lookupInviteByRawToken(db: Database.Database, rawToken: string): InviteLookupResult {
  const invite = getInviteByTokenHash(db, hashInviteToken(rawToken))
  if (!invite) {
    return { valid: false, reason: 'not_found' }
  }
  if (invite.revoked_at) {
    return { valid: false, reason: 'revoked' }
  }
  if (invite.used_at) {
    return { valid: false, reason: 'used' }
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { valid: false, reason: 'expired' }
  }
  return { valid: true, invite }
}

export function createInviteRecord(
  db: Database.Database,
  input: {
    type: InviteType
    label?: string
    userId?: string
    expiryHours: number
  },
): { invite: AccountInviteRow; rawToken: string; expiresAt: string } {
  const rawToken = generateInviteToken()
  const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000).toISOString()
  const invite = insertInvite(db, {
    tokenHash: hashInviteToken(rawToken),
    type: input.type,
    label: input.label,
    userId: input.userId,
    expiresAt,
  })
  return { invite, rawToken, expiresAt }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npx vitest run test/invites-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/invites.ts messaging-api/test/invites-service.test.ts
git commit -m "feat: add invite token and validation helpers"
```

---

## Task 5: Auth plugin — password_changed_at gate

**Files:**
- Modify: `messaging-api/src/plugins/auth.ts`
- Modify: `messaging-api/test/auth.test.ts`
- Create: `messaging-api/test/helpers/users.ts`

- [ ] **Step 1: Add test user helper**

Create `messaging-api/test/helpers/users.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { createUser } from '../../src/db/repos/users.js'
import { hashPassword } from '../../src/services/password.js'

export async function seedTestUser(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<{ id: string; username: string; token: string }> {
  const passwordHash = await hashPassword(password)
  const passwordChangedAt = new Date().toISOString()
  const user = createUser(app.db, { username, passwordHash, passwordChangedAt })
  const token = await app.jwt.sign({ sub: user.id, username: user.username })
  return { id: user.id, username: user.username, token }
}
```

- [ ] **Step 2: Update auth tests — remove bootstrap, add password_changed_at rejection**

In `messaging-api/test/auth.test.ts`:

- Remove the `bootstrap user reconciliation` describe block entirely
- Change login test to seed a user first:

```typescript
import { seedTestUser } from './helpers/users.js'

it('logs in a seeded user and returns a JWT', async () => {
  await seedTestUser(app, 'operator', 'password123')
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'operator', password: 'password123' },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toHaveProperty('token')
})
```

Add test:

```typescript
it('rejects JWTs issued before password_changed_at', async () => {
  const { id, token } = await seedTestUser(app, 'operator', 'password123')

  app.db.prepare(`UPDATE users SET password_changed_at = ? WHERE id = ?`).run(
    new Date(Date.now() + 60_000).toISOString(),
    id,
  )

  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${token}` },
  })

  expect(me.statusCode).toBe(401)
})
```

- [ ] **Step 3: Run auth tests to verify new test fails**

Run: `cd messaging-api && npx vitest run test/auth.test.ts -t "password_changed_at"`  
Expected: FAIL — still returns 200

- [ ] **Step 4: Update auth plugin**

In `messaging-api/src/plugins/auth.ts`, after loading user:

```typescript
if (user.password_changed_at) {
  const issuedAt = claims.iat
  const changedAt = Math.floor(new Date(user.password_changed_at).getTime() / 1000)
  if (issuedAt !== undefined && issuedAt < changedAt) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
}
```

Ensure `JwtClaims` includes optional `iat?: number`.

- [ ] **Step 5: Run all auth tests**

Run: `cd messaging-api && npx vitest run test/auth.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/plugins/auth.ts messaging-api/test/auth.test.ts messaging-api/test/helpers/users.ts
git commit -m "feat: invalidate JWTs issued before password change"
```

---

## Task 6: Invite HTTP routes

**Files:**
- Modify: `messaging-api/src/routes/auth.ts`
- Create: `messaging-api/src/routes/invite-landing.ts`
- Create: `messaging-api/test/invites.test.ts`
- Modify: `messaging-api/src/app.ts`

- [ ] **Step 1: Write failing integration tests**

Create `messaging-api/test/invites.test.ts` with:

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'
import { createInviteRecord } from '../src/services/invites.js'

describe('invite routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns invite metadata for a valid activation token', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'GET',
      url: `/auth/invite/${rawToken}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      valid: true,
      type: 'activation',
      expires_at: expect.any(String),
    })
  })

  it('activates a new account and returns a JWT', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: {
        token: rawToken,
        username: 'roberto',
        password: 'secure-password1',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('token')

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'roberto', password: 'secure-password1' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('returns 409 when username is taken', async () => {
    await seedTestUser(app, 'roberto', 'existing-password1')
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'POST',
      url: '/auth/activate',
      payload: {
        token: rawToken,
        username: 'roberto',
        password: 'secure-password1',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'username_taken' })
  })

  it('resets password and invalidates old JWT', async () => {
    const seeded = await seedTestUser(app, 'roberto', 'old-password12')
    const { rawToken } = createInviteRecord(app.db, {
      type: 'password_reset',
      userId: seeded.id,
      expiryHours: 48,
    })

    const reset = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, password: 'new-password123' },
    })
    expect(reset.statusCode).toBe(200)

    const denied = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${seeded.token}` },
    })
    expect(denied.statusCode).toBe(401)
  })

  it('redirects invite landing to app deep link', async () => {
    const { rawToken } = createInviteRecord(app.db, { type: 'activation', expiryHours: 48 })

    const response = await app.inject({
      method: 'GET',
      url: `/invite/${rawToken}`,
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(`hermes-companion://invite/${rawToken}`)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd messaging-api && npx vitest run test/invites.test.ts`  
Expected: FAIL — routes return 404

- [ ] **Step 3: Implement auth invite routes**

Extend `messaging-api/src/routes/auth.ts` with handlers for:
- `GET /auth/invite/:token` — serialize valid/invalid metadata
- `POST /auth/activate` — validate token, username, password; `createUser`; `markInviteUsed`; sign JWT
- `POST /auth/reset-password` — validate token type is `password_reset`; `updateUserPassword`; `markInviteUsed`; sign JWT

Use `lookupInviteByRawToken`, `isUsernameValid`, `validatePassword`, `findUserByUsername`.

JWT sign uses same `ONE_YEAR_IN_SECONDS` as login.

- [ ] **Step 4: Implement invite landing route**

Create `messaging-api/src/routes/invite-landing.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { lookupInviteByRawToken } from '../services/invites.js'

const inviteLandingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/invite/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const lookup = lookupInviteByRawToken(app.db, token)
    if (!lookup.valid) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.redirect(`hermes-companion://invite/${token}`)
  })
}

export default inviteLandingRoutes
```

Register in `app.ts`: `app.register(inviteLandingRoutes)` before auth routes.

- [ ] **Step 5: Run invite tests**

Run: `cd messaging-api && npx vitest run test/invites.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/routes/auth.ts messaging-api/src/routes/invite-landing.ts messaging-api/src/app.ts messaging-api/test/invites.test.ts
git commit -m "feat: add invite metadata, activation, and reset routes"
```

---

## Task 7: Remove bootstrap startup hook

**Files:**
- Modify: `messaging-api/src/app.ts`
- Modify: `messaging-api/src/db/repos/users.ts` — delete `ensureBootstrapUser`, `updateUserPasswordHash` if unused

- [ ] **Step 1: Write cold-start test**

Add to `messaging-api/test/invites.test.ts`:

```typescript
it('does not create users on startup', async () => {
  const count = app.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
  expect(count.count).toBe(0)
})

it('rejects login when no users exist', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'nobody', password: 'secure-password1' },
  })
  expect(response.statusCode).toBe(401)
})
```

- [ ] **Step 2: Remove bootstrap from app.ts**

Delete:
- `onReady` bootstrap reconciliation hook
- `bootstrapUsername` fastify decoration
- imports: `ensureBootstrapUser`, `updateUserPasswordHash`, `findUserByUsername`, `hashPassword`, `verifyPassword` if only used for bootstrap

- [ ] **Step 3: Run tests**

Run: `cd messaging-api && npx vitest run test/invites.test.ts test/auth.test.ts`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/app.ts messaging-api/src/db/repos/users.ts messaging-api/test/invites.test.ts
git commit -m "refactor: remove bootstrap user startup reconciliation"
```

---

## Task 8: MCP account tools

**Files:**
- Modify: `messaging-api/src/services/mcp-tools.ts`
- Modify: `messaging-api/src/routes/mcp.ts`
- Modify: `messaging-api/test/mcp.test.ts`

- [ ] **Step 1: Write failing MCP account tests**

Add to `messaging-api/test/mcp.test.ts`:

```typescript
it('creates an activation invite via MCP', async () => {
  const { client, transport } = await createMcpClient(app!)
  const result = await client.callTool({
    name: 'create_companion_invite',
    arguments: { label: 'Roberto' },
  })
  const payload = parseToolResult(result) as { invite_id: string; url: string; expires_at: string }
  expect(payload.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/invite\//)
  await transport.close()
  await client.close()
})

it('lists users and pending invites', async () => {
  const { rawToken } = createInviteRecord(app!.db, { type: 'activation', expiryHours: 48 })
  void rawToken
  const { client, transport } = await createMcpClient(app!)
  const result = await client.callTool({ name: 'list_companion_accounts', arguments: {} })
  const payload = parseToolResult(result) as { pending_invites: unknown[]; users: unknown[] }
  expect(payload.pending_invites.length).toBe(1)
  await transport.close()
  await client.close()
})
```

Update existing location MCP tests to pass `username` and seed user first via `seedTestUser`.

- [ ] **Step 2: Run MCP tests to verify failures**

Run: `cd messaging-api && npx vitest run test/mcp.test.ts`  
Expected: FAIL — unknown tools / missing username arg

- [ ] **Step 3: Refactor mcp-tools.ts**

Change `buildMcpToolHandlers` signature:

```typescript
export function buildMcpToolHandlers(db: Database.Database, options: {
  messagingApiHost: string
  inviteExpiryHours: number
}): McpToolHandlers
```

Add handlers:
- `create_companion_invite`
- `create_password_reset_invite` — requires existing user
- `list_companion_accounts`
- `revoke_companion_invite`

Update location handlers to accept `username: string` and resolve via `findUserByUsername`.

- [ ] **Step 4: Register tools in mcp.ts**

Add `server.registerTool(...)` entries with zod schemas. Update handler construction:

```typescript
const toolHandlers = buildMcpToolHandlers(app.db, {
  messagingApiHost: app.messagingApiHost,
  inviteExpiryHours: app.inviteExpiryHours,
})
```

Decorate `messagingApiHost` and `inviteExpiryHours` on fastify in `app.ts`.

- [ ] **Step 5: Run MCP tests**

Run: `cd messaging-api && npx vitest run test/mcp.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/services/mcp-tools.ts messaging-api/src/routes/mcp.ts messaging-api/src/app.ts messaging-api/test/mcp.test.ts
git commit -m "feat: add MCP account invite tools and username-scoped location"
```

---

## Task 9: Fix remaining tests that assumed bootstrap user

**Files:**
- Modify: tests that login as `operator` without seeding — add `seedTestUser` in `beforeEach`

Likely files:
- `messaging-api/test/data-location.test.ts`
- `messaging-api/test/messages.test.ts`
- `messaging-api/test/address-enrichment.test.ts`
- `messaging-api/test/mcp.test.ts` (if not fully fixed in Task 8)
- any other file importing bootstrap login

- [ ] **Step 1: Add seedTestUser to beforeEach blocks**

Pattern:

```typescript
beforeEach(async () => {
  app = await createTestApp()
  await app.ready()
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'operator', password: 'password123' },
  })
```

Replace with:

```typescript
beforeEach(async () => {
  app = await createTestApp()
  await app.ready()
  const seeded = await seedTestUser(app, 'operator', 'password123')
  operatorToken = seeded.token
  operatorUserId = seeded.id
})
```

- [ ] **Step 2: Run full test suite**

Run: `cd messaging-api && npx vitest run`  
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add messaging-api/test/
git commit -m "test: seed users explicitly after bootstrap removal"
```

---

## Task 10: Hermes skills

**Files:**
- Create: `data/skills/companion-account-management/SKILL.md`
- Modify: `data/skills/companion-user-location/SKILL.md`

- [ ] **Step 1: Create companion-account-management skill**

```markdown
---
name: companion-account-management
description: Use when the operator asks to create a companion app account, reset a companion password, list companion users, or revoke a pending invite. Calls companion MCP account tools only.
version: 1.0.0
author: Hermes Agent
---

# Companion Account Management

## Tools (companion MCP)

- `create_companion_invite` — optional `label`; returns magic link URL
- `create_password_reset_invite` — requires `username`
- `list_companion_accounts`
- `revoke_companion_invite` — requires `invite_id`

## Rules

- Present the **full** magic link URL verbatim for manual sharing
- Never truncate the token
- Accounts cannot be created except through these MCP tools
```

- [ ] **Step 2: Update companion-user-location skill**

Add `username` as required argument on `get_user_location` and `get_location_history`. Document that for a single-operator household the username is whichever companion account the question refers to; default to asking or using context from `list_companion_accounts`.

- [ ] **Step 3: Commit**

```bash
git add data/skills/companion-account-management/SKILL.md data/skills/companion-user-location/SKILL.md
git commit -m "feat: add account management skill; require username for location"
```

---

## Task 11: Workspace config and docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `messaging-api/.env.example`
- Modify: `README.md`
- Modify: `docs/superpowers/README.md`

- [ ] **Step 1: Update docker-compose.yml**

Remove:
```yaml
BOOTSTRAP_USERNAME: ${MESSAGING_API_BOOTSTRAP_USERNAME:-operator}
BOOTSTRAP_PASSWORD: ${MESSAGING_API_BOOTSTRAP_PASSWORD:-change-me}
```

Add:
```yaml
MESSAGING_API_HOST: ${MESSAGING_API_HOST:-}
INVITE_EXPIRY_HOURS: ${INVITE_EXPIRY_HOURS:-48}
MIN_PASSWORD_LENGTH: ${MIN_PASSWORD_LENGTH:-12}
```

Map env vars in messaging-api service (`MESSAGING_API_HOST` → `MESSAGING_API_HOST`, etc.).

- [ ] **Step 2: Update .env.example files**

Remove bootstrap lines. Add:

```dotenv
MESSAGING_API_HOST=100.x.x.x:3000
INVITE_EXPIRY_HOURS=48
MIN_PASSWORD_LENGTH=12
```

- [ ] **Step 3: Update README.md Messaging API section**

Replace bootstrap user docs with:
- Cold start: no accounts until Hermes creates first invite
- `MESSAGING_API_HOST` must be Tailscale-reachable IP
- Account creation via `companion-account-management` skill
- Note existing `operator` user persists on upgrade

- [ ] **Step 4: Link plan in docs/superpowers/README.md**

Add under companion auth:
- Backend plan: `plans/2026-06-14-companion-auth-invites-backend.md`

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example messaging-api/.env.example README.md docs/superpowers/README.md
git commit -m "docs: update workspace config for invite-based auth"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run full messaging-api test suite**

Run: `cd messaging-api && npx vitest run`  
Expected: ALL PASS

- [ ] **Step 2: Build container**

Run: `docker compose build messaging-api`  
Expected: successful build

- [ ] **Step 3: Smoke test against running stack**

After `make up` with updated `.env`:

```bash
# No users — login fails
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"x","password":"y"}'
# Expected: 401

# Health still works
curl -s http://127.0.0.1:3000/health
# Expected: {"ok":true}
```

Create invite via MCP script (reuse pattern from location check) and complete activation with curl.

- [ ] **Step 4: Move spec to implemented when done**

After shipping, move design spec to `docs/history/implemented/specs/` and set **Status: Implemented**.

---

## Spec Coverage Checklist

| Spec requirement | Task |
|------------------|------|
| Cold start, no bootstrap | Task 7, 11 |
| `account_invites` table | Task 3 |
| `password_changed_at` + JWT gate | Task 3, 5 |
| Invite metadata route | Task 6 |
| Activate route | Task 6 |
| Reset-password route | Task 6 |
| Invite landing redirect | Task 6 |
| MCP account tools | Task 8 |
| Location MCP `username` | Task 8 |
| Hermes skills | Task 10 |
| Config env vars | Task 2, 11 |
| OpenAPI v1.6.0 | Task 1 (already committed) |
| Tests per spec | Tasks 3–9, 12 |