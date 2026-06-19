# Companion Health Vault v2 Metrics — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, `data/skills/`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. Client impact is in `docs/superpowers/plans/2026-06-18-companion-health-vault-v2-metrics-ios.md`.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml`. A task is not done until OpenAPI matches shipped behavior.

**Goal:** Extend the health daily summary `metrics` object with sleep, heart, workout, body, nutrition, mindfulness, and flights-climbed keys (OpenAPI v2.4.0). No new routes or tables.

**Architecture:** Extend `health-metrics.ts` validation (new units, metric keys, `workout_types` sidecar). Repo and routes unchanged except types. Update `companion-user-health` and `companion-app` skills for new intents.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-18-companion-health-vault-v2-metrics-design.md`  
**Parent:** `docs/superpowers/specs/2026-06-17-companion-health-vault-design.md`  
**Client plan (reference only):** `docs/superpowers/plans/2026-06-18-companion-health-vault-v2-metrics-ios.md`

---

## File Structure

```
messaging-api/
  src/lib/health-metrics.ts              — MODIFY: v2 keys, units, workout_types
  test/health-metrics.test.ts            — MODIFY: v2 validation tests
  test/data-health.test.ts               — MODIFY: upsert round-trip for v2 payload

data/skills/
  companion-user-health/SKILL.md         — MODIFY: HealthDayRecord + workflows
  companion-app/SKILL.md                   — MODIFY: intent routing rows

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v2.4.0
docs/superpowers/README.md                          — MODIFY: active work entry
README.md                                           — MODIFY: health vault metric list
```

---

## Task 1: OpenAPI v2.4.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Bump version and changelog**

Set `info.version` to `2.4.0`. Add changelog entry:

```yaml
    **v2.4.0 changes:** extended health daily summary metrics on existing
    `/data/health/daily-summaries` routes. New optional scalar keys: sleep, heart,
    workout, body, nutrition, mindfulness, flights_climbed. New `workout_types`
    object. Extended `HealthMetric.unit` enum. No new routes or MCP tools. See
    `docs/superpowers/specs/2026-06-18-companion-health-vault-v2-metrics-design.md`.
```

- [ ] **Step 2: Extend `HealthMetric.unit` enum**

```yaml
        unit:
          type: string
          enum: [count, m, kcal, min, h, bpm, ms, kg, pct, g, ml]
```

- [ ] **Step 3: Add `HealthWorkoutTypes` schema**

```yaml
    HealthWorkoutTypes:
      type: object
      required: [types]
      properties:
        types:
          type: array
          items:
            type: string
            minLength: 1
            maxLength: 64
            pattern: '^[a-z][a-z0-9_]*$'
          minItems: 1
          maxItems: 20
          uniqueItems: true
```

- [ ] **Step 4: Extend `HealthMetrics` properties**

Add after existing v1 keys:

```yaml
        flights_climbed:
          $ref: '#/components/schemas/HealthMetric'
        sleep_duration:
          $ref: '#/components/schemas/HealthMetric'
        sleep_in_bed:
          $ref: '#/components/schemas/HealthMetric'
        sleep_deep:
          $ref: '#/components/schemas/HealthMetric'
        sleep_rem:
          $ref: '#/components/schemas/HealthMetric'
        sleep_core:
          $ref: '#/components/schemas/HealthMetric'
        resting_heart_rate:
          $ref: '#/components/schemas/HealthMetric'
        heart_rate_avg:
          $ref: '#/components/schemas/HealthMetric'
        hrv_sdnn:
          $ref: '#/components/schemas/HealthMetric'
        workout_count:
          $ref: '#/components/schemas/HealthMetric'
        workout_minutes:
          $ref: '#/components/schemas/HealthMetric'
        weight:
          $ref: '#/components/schemas/HealthMetric'
        bmi:
          $ref: '#/components/schemas/HealthMetric'
        body_fat_percentage:
          $ref: '#/components/schemas/HealthMetric'
        dietary_energy:
          $ref: '#/components/schemas/HealthMetric'
        protein:
          $ref: '#/components/schemas/HealthMetric'
        water:
          $ref: '#/components/schemas/HealthMetric'
        mindfulness_minutes:
          $ref: '#/components/schemas/HealthMetric'
        workout_types:
          $ref: '#/components/schemas/HealthWorkoutTypes'
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs(openapi): v2.4.0 health daily summary v2 metrics"
```

---

## Task 2: Health metrics validation (v2 keys)

**Files:**
- Modify: `messaging-api/src/lib/health-metrics.ts`
- Modify: `messaging-api/test/health-metrics.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest'
import { parseHealthDate, validateHealthMetrics } from '../src/lib/health-metrics.js'

describe('validateHealthMetrics v2', () => {
  it('accepts sleep and heart metrics', () => {
    const result = validateHealthMetrics({
      sleep_duration: { value: 420, unit: 'min', goal: null, remaining: null },
      resting_heart_rate: { value: 58, unit: 'bpm', goal: null, remaining: null },
    })
    expect(result).toEqual({
      sleep_duration: { value: 420, unit: 'min', goal: null, remaining: null },
      resting_heart_rate: { value: 58, unit: 'bpm', goal: null, remaining: null },
    })
  })

  it('accepts workout_types alongside scalar metrics', () => {
    const result = validateHealthMetrics({
      workout_count: { value: 2, unit: 'count', goal: null, remaining: null },
      workout_types: { types: ['running', 'walking'] },
    })
    expect(result?.workout_count?.value).toBe(2)
    expect(result?.workout_types).toEqual({ types: ['running', 'walking'] })
  })

  it('rejects invalid workout_types slug', () => {
    expect(
      validateHealthMetrics({
        workout_types: { types: ['Running'] },
      }),
    ).toBeNull()
  })

  it('rejects unknown metric keys', () => {
    expect(
      validateHealthMetrics({
        steps: { value: 100, unit: 'count', goal: null, remaining: null },
        heart_rate_samples: { value: 1, unit: 'count', goal: null, remaining: null },
      }),
    ).toBeNull()
  })

  it('accepts v1-only payload (regression)', () => {
    const result = validateHealthMetrics({
      steps: { value: 1000, unit: 'count', goal: 10000, remaining: 9000 },
    })
    expect(result?.steps?.value).toBe(1000)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd messaging-api && npm test -- test/health-metrics.test.ts`

- [ ] **Step 3: Implement**

Replace `METRIC_KEYS` and `UNITS` in `health-metrics.ts`:

```typescript
const METRIC_KEYS = [
  'steps',
  'distance_walking_running',
  'active_energy',
  'exercise_minutes',
  'stand_hours',
  'flights_climbed',
  'sleep_duration',
  'sleep_in_bed',
  'sleep_deep',
  'sleep_rem',
  'sleep_core',
  'resting_heart_rate',
  'heart_rate_avg',
  'hrv_sdnn',
  'workout_count',
  'workout_minutes',
  'weight',
  'bmi',
  'body_fat_percentage',
  'dietary_energy',
  'protein',
  'water',
  'mindfulness_minutes',
] as const

const UNITS = new Set(['count', 'm', 'kcal', 'min', 'h', 'bpm', 'ms', 'kg', 'pct', 'g', 'ml'])

const WORKOUT_TYPE_SLUG_RE = /^[a-z][a-z0-9_]*$/

export interface HealthWorkoutTypes {
  types: string[]
}

export type HealthMetricUnit =
  | 'count'
  | 'm'
  | 'kcal'
  | 'min'
  | 'h'
  | 'bpm'
  | 'ms'
  | 'kg'
  | 'pct'
  | 'g'
  | 'ml'

export interface HealthMetric {
  value: number
  unit: HealthMetricUnit
  goal: number | null
  remaining: number | null
}

export type HealthMetrics = Partial<Record<(typeof METRIC_KEYS)[number], HealthMetric>> & {
  workout_types?: HealthWorkoutTypes
}
```

Update `validateHealthMetrics`:

```typescript
export function validateHealthMetrics(value: unknown): HealthMetrics | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const raw = value as Record<string, unknown>
  const metrics: HealthMetrics = {}
  let count = 0

  for (const key of METRIC_KEYS) {
    const entry = raw[key]
    if (entry === undefined) {
      continue
    }
    const metric = parseMetric(entry)
    if (!metric) {
      return null
    }
    metrics[key] = metric
    count += 1
  }

  if (raw.workout_types !== undefined) {
    const workoutTypes = parseWorkoutTypes(raw.workout_types)
    if (!workoutTypes) {
      return null
    }
    metrics.workout_types = workoutTypes
    count += 1
  }

  for (const key of Object.keys(raw)) {
    if (key === 'workout_types') {
      continue
    }
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      return null
    }
  }

  return count > 0 ? metrics : null
}

function parseWorkoutTypes(value: unknown): HealthWorkoutTypes | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const types = (value as Record<string, unknown>).types
  if (!Array.isArray(types) || types.length === 0 || types.length > 20) {
    return null
  }
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of types) {
    if (typeof item !== 'string' || !WORKOUT_TYPE_SLUG_RE.test(item)) {
      return null
    }
    if (seen.has(item)) {
      return null
    }
    seen.add(item)
    normalized.push(item)
  }
  return { types: normalized }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd messaging-api && npm test -- test/health-metrics.test.ts`

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/lib/health-metrics.ts messaging-api/test/health-metrics.test.ts
git commit -m "feat(messaging-api): validate health v2 daily metrics"
```

---

## Task 3: REST round-trip test

**Files:**
- Modify: `messaging-api/test/data-health.test.ts`

- [ ] **Step 1: Add failing integration test**

Append a test that POSTs a v2 payload and GETs latest:

```typescript
  it('upserts and returns v2 health metrics', async () => {
    const token = await loginAs(app, 'healthv2user', 'password')

    const metrics = {
      steps: { value: 5000, unit: 'count', goal: 10000, remaining: 5000 },
      sleep_duration: { value: 390, unit: 'min', goal: null, remaining: null },
      resting_heart_rate: { value: 60, unit: 'bpm', goal: null, remaining: null },
      workout_count: { value: 1, unit: 'count', goal: null, remaining: null },
      workout_minutes: { value: 32, unit: 'min', goal: null, remaining: null },
      workout_types: { types: ['running'] },
      water: { value: 1500, unit: 'ml', goal: null, remaining: null },
    }

    const upsert = await app.inject({
      method: 'POST',
      url: '/data/health/daily-summaries',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        date: '2026-06-18',
        timezone: 'Europe/Lisbon',
        partial: true,
        source: 'healthkit',
        metrics,
      },
    })
    expect(upsert.statusCode).toBe(204)

    const latest = await app.inject({
      method: 'GET',
      url: '/data/health/daily-summaries/latest',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(latest.statusCode).toBe(200)
    const body = latest.json()
    expect(body.metrics.sleep_duration.value).toBe(390)
    expect(body.metrics.workout_types.types).toEqual(['running'])
  })
```

Adapt `loginAs` / app fixture to match existing `data-health.test.ts` patterns.

- [ ] **Step 2: Run test — expect PASS** (validation from Task 2 should make this pass without route changes)

Run: `cd messaging-api && npm test -- test/data-health.test.ts`

- [ ] **Step 3: Commit**

```bash
git add messaging-api/test/data-health.test.ts
git commit -m "test(messaging-api): health v2 metrics REST round-trip"
```

---

## Task 4: MCP smoke (optional regression)

**Files:**
- Modify: `messaging-api/test/mcp.test.ts` (if health MCP tests exist)

- [ ] **Step 1: Extend existing health MCP test** to assert `workout_types` passes through on `get_user_health_today` after upsert with v2 payload.

- [ ] **Step 2: Run** `cd messaging-api && npm test -- test/mcp.test.ts`

- [ ] **Step 3: Commit** if changed.

---

## Task 5: Skill updates

**Files:**
- Modify: `data/skills/companion-user-health/SKILL.md`
- Modify: `data/skills/companion-app/SKILL.md`

- [ ] **Step 1: Update `companion-user-health`**

In `HealthDayRecord.metrics`, document all v2 keys and `workout_types`.

Add workflows:

```markdown
## Data workflow — sleep

1. Resolve `username`.
2. Call `get_user_health_today` or `get_user_health_daily`.
3. Report `sleep_duration` (and stages if present). Note wake-day attribution may differ from "last night" colloquially — state the `date`.

## Data workflow — heart

Report `resting_heart_rate`, `heart_rate_avg`, or `hrv_sdnn` when asked. Include unit in answer.

## Data workflow — workouts

Report `workout_count`, `workout_minutes`, and humanize `workout_types.types` (e.g. `traditional_strength_training` → "traditional strength training").

## Data workflow — body / nutrition / mindfulness

Report latest-day `weight`, `bmi`, `body_fat_percentage`, or daily sums `dietary_energy`, `protein`, `water`, `mindfulness_minutes`, `flights_climbed`.
```

Bump skill `version` to `1.1.0`.

- [ ] **Step 2: Update `companion-app` intent routing**

Add rows per design spec (sleep, heart, workouts, body, nutrition, mindfulness).

Bump `version` to `1.2.0`.

- [ ] **Step 3: Commit**

```bash
git add data/skills/companion-user-health/SKILL.md data/skills/companion-app/SKILL.md
git commit -m "docs(skills): companion health v2 metric intents"
```

---

## Task 6: Operator docs

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/README.md`

- [ ] **Step 1: README** — under health vault section, list v2 metric keys and link to design spec.

- [ ] **Step 2: superpowers README** — add active work entry for health v2 metrics with spec + plan links.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/README.md
git commit -m "docs: health vault v2 metrics operator notes"
```

---

## Verification checklist

| Check | Command |
|-------|---------|
| Unit tests | `cd messaging-api && npm test` |
| OpenAPI matches validation units/keys | manual diff vs `health-metrics.ts` |
| v1 regression | existing `data-health.test.ts` cases still pass |

---

## Deploy order

1. Ship backend + OpenAPI v2.4.0 (this plan)
2. Update Hermes skills (`companion-user-health`, `companion-app`)
3. Ship iOS HealthKit sync for new categories (separate repo plan)

Brief overlap: old iOS sends v1 metrics only — valid indefinitely.