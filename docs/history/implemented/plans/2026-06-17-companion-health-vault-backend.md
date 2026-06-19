# Companion Health Vault — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, `data/skills/`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. Client impact is in `docs/superpowers/plans/2026-06-17-companion-health-vault-ios.md`.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml`. A task is not done until OpenAPI matches shipped behavior.

**Goal:** Add health daily summary vault (`POST/GET /data/health/daily-summaries`), three MCP health tools, `companion-user-health` skill, and `companion-app` health routing. OpenAPI v2.0.0.

**Architecture:** Mirror location vault patterns — JWT user-scoped routes, repo layer, HAL pagination on list, MCP handlers in `mcp-tools.ts`. Passive vault: iOS owns sync/finalization; API upserts by `(user_id, date)`.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest, Zod (MCP)

**Spec:** `docs/superpowers/specs/2026-06-17-companion-health-vault-backend-design.md`  
**Overview:** `docs/superpowers/specs/2026-06-17-companion-health-vault-design.md`  
**Client plan (reference only):** `docs/superpowers/plans/2026-06-17-companion-health-vault-ios.md`

---

## File Structure

```
messaging-api/
  src/
    lib/health-metrics.ts              — CREATE: validate metrics + date
    db/schema.ts                       — MODIFY: health_daily_summaries table
    db/repos/health-daily-summaries.ts — CREATE: upsert, latest, list page
    routes/data-health.ts              — CREATE: REST routes
    services/mcp-tools.ts              — MODIFY: 3 health tool handlers
    routes/mcp.ts                      — MODIFY: register 3 health tools
    app.ts                             — MODIFY: register data-health routes
  test/
    health-metrics.test.ts             — CREATE
    data-health.test.ts                — CREATE
    mcp.test.ts                        — MODIFY: health MCP tests
    db.test.ts                         — MODIFY: table exists
  scripts/smoke-test.mjs               — MODIFY: optional health MCP check

data/skills/
  companion-user-health/SKILL.md       — CREATE
  companion-app/SKILL.md                 — MODIFY: health intent rows

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v2.0.0
README.md                                          — MODIFY: health vault section
```

---

## Task 1: OpenAPI v2.0.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Bump version and changelog**

Set `info.version` to `2.0.0`. Add changelog entry for:
- `POST /data/health/daily-summaries`
- `GET /data/health/daily-summaries/latest`
- `GET /data/health/daily-summaries` (HAL)
- MCP tools: `get_user_health_today`, `get_user_health_daily`, `get_user_health_history`

- [ ] **Step 2: Add schemas**

```yaml
HealthMetric:
  type: object
  required: [value, unit, goal, remaining]
  properties:
    value: { type: number, minimum: 0 }
    unit: { type: string, enum: [count, m, kcal, min, h] }
    goal: { type: ['number', 'null'], minimum: 0 }
    remaining: { type: ['number', 'null'], minimum: 0 }

HealthMetrics:
  type: object
  properties:
    steps: { $ref: '#/components/schemas/HealthMetric' }
    distance_walking_running: { $ref: '#/components/schemas/HealthMetric' }
    active_energy: { $ref: '#/components/schemas/HealthMetric' }
    exercise_minutes: { $ref: '#/components/schemas/HealthMetric' }
    stand_hours: { $ref: '#/components/schemas/HealthMetric' }

HealthDailySummary:
  type: object
  required: [id, user_id, date, timezone, partial, synced_at, source, metrics]
  properties:
    id: { type: string, format: uuid }
    user_id: { type: string, format: uuid }
    date: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$' }
    timezone: { type: string }
    partial: { type: boolean }
    finalized_at: { type: ['string', 'null'] }
    synced_at: { type: string }
    source: { type: string, enum: [healthkit] }
    metrics: { $ref: '#/components/schemas/HealthMetrics' }

UpsertHealthDailySummaryRequest:
  type: object
  required: [date, timezone, partial, source, metrics]
  properties:
    date: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$' }
    timezone: { type: string, minLength: 1 }
    partial: { type: boolean }
    source: { type: string, enum: [healthkit] }
    metrics: { $ref: '#/components/schemas/HealthMetrics' }

HealthDailySummaryListResponse:
  type: object
  required: [summaries, _links]
  properties:
    summaries:
      type: array
      items: { $ref: '#/components/schemas/HealthDailySummary' }
    _links: { $ref: '#/components/schemas/HalLinks' }
```

- [ ] **Step 3: Add routes under `/data/health/`** (tag: `health` or `data`)

Document `409 day_finalized` on POST when reopening a finalized day.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs(openapi): v2.0.0 companion health daily summaries"
```

---

## Task 2: Health metrics validation

**Files:**
- Create: `messaging-api/src/lib/health-metrics.ts`
- Create: `messaging-api/test/health-metrics.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest'
import { parseHealthDate, validateHealthMetrics } from '../src/lib/health-metrics.js'

describe('parseHealthDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(parseHealthDate('2026-06-17')).toBe('2026-06-17')
  })

  it('rejects invalid dates', () => {
    expect(parseHealthDate('06-17-2026')).toBeNull()
    expect(parseHealthDate('')).toBeNull()
  })
})

describe('validateHealthMetrics', () => {
  it('accepts steps with matching remaining', () => {
    const result = validateHealthMetrics({
      steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
    })
    expect(result).toEqual({
      steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
    })
  })

  it('rejects remaining mismatch when goal is set', () => {
    expect(
      validateHealthMetrics({
        steps: { value: 100, unit: 'count', goal: 1000, remaining: 500 },
      }),
    ).toBeNull()
  })

  it('requires remaining null when goal is null', () => {
    expect(
      validateHealthMetrics({
        steps: { value: 100, unit: 'count', goal: null, remaining: 0 },
      }),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd messaging-api && npm test -- test/health-metrics.test.ts`

- [ ] **Step 3: Implement**

```typescript
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const METRIC_KEYS = [
  'steps',
  'distance_walking_running',
  'active_energy',
  'exercise_minutes',
  'stand_hours',
] as const

const UNITS = new Set(['count', 'm', 'kcal', 'min', 'h'])

export interface HealthMetric {
  value: number
  unit: 'count' | 'm' | 'kcal' | 'min' | 'h'
  goal: number | null
  remaining: number | null
}

export type HealthMetrics = Partial<Record<(typeof METRIC_KEYS)[number], HealthMetric>>

export function parseHealthDate(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return null
  }
  return value
}

export function validateHealthMetrics(value: unknown): HealthMetrics | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const metrics: HealthMetrics = {}
  let count = 0

  for (const key of METRIC_KEYS) {
    const raw = (value as Record<string, unknown>)[key]
    if (raw === undefined) {
      continue
    }

    const metric = parseMetric(raw)
    if (!metric) {
      return null
    }

    metrics[key] = metric
    count += 1
  }

  return count > 0 ? metrics : null
}

function parseMetric(value: unknown): HealthMetric | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const raw = value as Record<string, unknown>
  const numValue = raw.value
  const unit = raw.unit
  const goal = raw.goal
  const remaining = raw.remaining

  if (typeof numValue !== 'number' || numValue < 0 || !Number.isFinite(numValue)) {
    return null
  }
  if (typeof unit !== 'string' || !UNITS.has(unit)) {
    return null
  }

  if (goal === null) {
    if (remaining !== null) {
      return null
    }
    return { value: numValue, unit: unit as HealthMetric['unit'], goal: null, remaining: null }
  }

  if (typeof goal !== 'number' || goal < 0 || !Number.isFinite(goal)) {
    return null
  }
  if (typeof remaining !== 'number' || remaining < 0 || !Number.isFinite(remaining)) {
    return null
  }

  const expected = Math.max(0, goal - numValue)
  if (remaining !== expected) {
    return null
  }

  return { value: numValue, unit: unit as HealthMetric['unit'], goal, remaining }
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/lib/health-metrics.ts messaging-api/test/health-metrics.test.ts
git commit -m "feat(messaging-api): add health metrics validation"
```

---

## Task 3: Schema and repository

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Create: `messaging-api/src/db/repos/health-daily-summaries.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Add failing db test**

```typescript
  it('creates health_daily_summaries table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_daily_summaries'")
      .all()
    expect(rows).toHaveLength(1)
  })
```

- [ ] **Step 2: Add table + migration in schema.ts**

Add `CREATE TABLE IF NOT EXISTS health_daily_summaries` in `initSchema` exec block and indexes from backend spec.

- [ ] **Step 3: Implement repo**

Key exports:

```typescript
export interface HealthDailySummaryRow { ... }

export interface UpsertHealthDailySummaryInput {
  userId: string
  date: string
  timezone: string
  partial: boolean
  source: string
  metrics: HealthMetrics
}

export class DayFinalizedError extends Error {
  constructor() {
    super('day_finalized')
  }
}

export function upsertHealthDailySummary(db, input): HealthDailySummaryRow
export function getLatestHealthDailySummary(db, userId): HealthDailySummaryRow | undefined
export function getHealthDailySummaryByDate(db, userId, date): HealthDailySummaryRow | undefined
export function listHealthDailySummariesPage(db, userId, limit, anchors): HealthDailySummaryPage | null
```

**Upsert logic:**
- SELECT existing by `(user_id, date)`
- If exists && `partial=0` && incoming `partial=true` → throw `DayFinalizedError`
- If exists && `partial=0` && incoming `partial=false` → UPDATE metrics, `synced_at`, keep `finalized_at`
- Else INSERT or UPDATE with `finalized_at` set on first `partial=false`

**Pagination:** sort `date DESC, id DESC`; anchor on row `id` (copy `listConversationsPage` cursor pattern using `date` + `rowid`).

Serialize `metrics_json` on write; parse on read.

- [ ] **Step 4: Run db test**

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/src/db/repos/health-daily-summaries.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): health_daily_summaries schema and repo"
```

---

## Task 4: REST routes

**Files:**
- Create: `messaging-api/src/routes/data-health.ts`
- Modify: `messaging-api/src/app.ts`
- Create: `messaging-api/test/data-health.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover from backend spec testing table:

```typescript
function sampleMetrics(overrides = {}) {
  return {
    steps: { value: 6432, unit: 'count', goal: 10000, remaining: 3568 },
    ...overrides,
  }
}

function upsertPayload(overrides = {}) {
  return {
    date: '2026-06-17',
    timezone: 'Europe/Lisbon',
    partial: true,
    source: 'healthkit',
    metrics: sampleMetrics(),
    ...overrides,
  }
}

// Tests:
// - POST upsert insert 204
// - POST upsert update same day
// - POST finalize partial false sets finalized_at
// - POST partial true on finalized day → 409 { error: 'day_finalized' }
// - POST invalid remaining → 400
// - GET latest 404 when empty
// - GET latest returns newest date
// - GET list HAL pagination before/after
// - JWT isolation (other user cannot read)
```

- [ ] **Step 2: Implement `data-health.ts`**

Mirror `data-location.ts` structure:
- `POST /data/health/daily-summaries` — validate body, upsert, map `DayFinalizedError` → 409
- `GET /data/health/daily-summaries/latest`
- `GET /data/health/daily-summaries` — HAL via `buildHalLinks`, collection key `summaries`, `basePath: '/data/health/daily-summaries'`

Register in `app.ts`:

```typescript
import dataHealthRoutes from './routes/data-health.js'
// ...
app.register(dataHealthRoutes)
```

- [ ] **Step 3: Run tests**

Run: `cd messaging-api && npm test -- test/data-health.test.ts`

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/routes/data-health.ts messaging-api/src/app.ts messaging-api/test/data-health.test.ts
git commit -m "feat(messaging-api): health daily summary REST routes"
```

---

## Task 5: MCP tools

**Files:**
- Modify: `messaging-api/src/services/mcp-tools.ts`
- Modify: `messaging-api/src/routes/mcp.ts`
- Modify: `messaging-api/test/mcp.test.ts`

- [ ] **Step 1: Write failing MCP tests**

```typescript
  it('get_user_health_today returns available summary', async () => {
    // POST upsert via REST or direct repo
    // call MCP get_user_health_today { username: 'operator' }
    // expect available true, metrics.steps.value 6432
  })

  it('get_user_health_daily returns unavailable for missing date', async () => {
    // expect available false with date field
  })

  it('get_user_health_history returns HAL summaries', async () => {
    // seed 3 days, expect summaries + _links.self
  })
```

- [ ] **Step 2: Add handlers in mcp-tools.ts**

```typescript
export interface UserHealthSummaryResult {
  available: true
  username: string
  date: string
  timezone: string
  partial: boolean
  synced_at: string
  metrics: HealthMetrics
  finalized_at?: string | null
}

export type UserHealthTodayResult = UserHealthSummaryResult | { available: false; username: string }
export type UserHealthDailyResult =
  | UserHealthSummaryResult
  | { available: false; username: string; date: string }

async get_user_health_today(input) {
  const user = resolveUserByUsername(db, input.username)
  const row = getLatestHealthDailySummary(db, user.id)
  if (!row) return { available: false, username: input.username }
  return serializeHealthSummary(input.username, row)
}

async get_user_health_daily(input) {
  const user = resolveUserByUsername(db, input.username)
  const date = parseHealthDate(input.date)
  if (!date) throw new Error('invalid_request')
  const row = getHealthDailySummaryByDate(db, user.id, date)
  if (!row) return { available: false, username: input.username, date }
  return serializeHealthSummary(input.username, row)
}

async get_user_health_history(input) {
  // mirror get_location_history with summaries collection + buildHalLinks
}
```

- [ ] **Step 3: Register tools in mcp.ts**

```typescript
  server.registerTool('get_user_health_today', { ... zod username }, ...)
  server.registerTool('get_user_health_daily', { ... username, date }, ...)
  server.registerTool('get_user_health_history', { ... username, limit, before, after }, ...)
```

- [ ] **Step 4: Run MCP tests**

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/mcp-tools.ts messaging-api/src/routes/mcp.ts messaging-api/test/mcp.test.ts
git commit -m "feat(messaging-api): companion MCP health tools"
```

---

## Task 6: Hermes skills

**Files:**
- Create: `data/skills/companion-user-health/SKILL.md`
- Modify: `data/skills/companion-app/SKILL.md`
- Modify: `data/skills/companion-user-location/SKILL.md` (related_skills only)

- [ ] **Step 1: Create companion-user-health skill**

Data skill with:
- Tools: `get_user_health_today`, `get_user_health_daily`, `get_user_health_history`
- `HealthDayRecord` normalization schema
- Intent examples: steps today, steps to goal, exercise ring, stand hours
- Username resolution (same as location)
- Consumers: `companion-replies`, `companion-markdown-blocks`
- Note `partial` + `synced_at` when data may be stale

- [ ] **Step 2: Update companion-app routing table**

Add rows:

| User intent | Load (in order) |
|-------------|-----------------|
| Steps / activity today | `companion-user-health` → `companion-replies` |
| Steps to goal / ring progress | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) |
| Health history ("steps last Tuesday") | `companion-user-health` → plain text or `companion-markdown-blocks` |

Add `companion-user-health` to `related_skills` metadata.

- [ ] **Step 3: Commit**

```bash
git add data/skills/companion-user-health/SKILL.md data/skills/companion-app/SKILL.md data/skills/companion-user-location/SKILL.md
git commit -m "feat(skills): add companion-user-health and app routing"
```

---

## Task 7: README and smoke test

**Files:**
- Modify: `README.md`
- Modify: `messaging-api/scripts/smoke-test.mjs` (optional)
- Modify: design spec statuses → Approved

- [ ] **Step 1: README section**

Add after location vault section:

- Health vault routes (`/data/health/daily-summaries`)
- MCP tools list
- `companion-user-health` skill
- iOS owns sync; link to iOS plan
- OpenAPI v2.0.0

- [ ] **Step 2: Smoke test (optional)**

After seeding a summary via POST, call `get_user_health_today` and print steps value.

- [ ] **Step 3: Mark specs Approved**

Update status in:
- `docs/superpowers/specs/2026-06-17-companion-health-vault-design.md`
- `docs/superpowers/specs/2026-06-17-companion-health-vault-backend-design.md`

- [ ] **Step 4: Update `docs/superpowers/README.md`** with backend plan link.

- [ ] **Step 5: Commit**

```bash
git add README.md messaging-api/scripts/smoke-test.mjs docs/superpowers/
git commit -m "docs: companion health vault README and approved specs"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run full test suite**

Run: `cd messaging-api && npm test`  
Expected: all pass

- [ ] **Step 2: OpenAPI parity check**

Confirm live routes match `messaging-api.openapi.yaml` v2.0.0 schemas and paths.

- [ ] **Step 3: Grep AGENTS.md list pagination**

New list endpoint uses HAL — already required by workspace rules.

---

## Spec coverage checklist

| Requirement | Task |
|-------------|------|
| `health_daily_summaries` table | Task 3 |
| Metric validation (goal/remaining) | Task 2 |
| POST upsert + 409 finalized | Task 4 |
| GET latest + HAL history | Task 4 |
| OpenAPI v2.0.0 | Task 1 |
| MCP today/daily/history | Task 5 |
| `companion-user-health` skill | Task 6 |
| `companion-app` health routing | Task 6 |