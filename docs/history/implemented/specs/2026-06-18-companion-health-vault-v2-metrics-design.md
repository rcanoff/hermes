# Companion Health Vault — v2 Daily Metrics Extension

**Date:** 2026-06-18  
**Status:** Approved  
**API version:** v2.4.0 (OpenAPI)  
**Plans:**
- `docs/superpowers/plans/2026-06-18-companion-health-vault-v2-metrics-backend.md` — **this repo**
- `docs/superpowers/plans/2026-06-18-companion-health-vault-v2-metrics-ios.md` — **reference only; `assistant-companion` repo**  
**Parent:** `docs/superpowers/specs/2026-06-17-companion-health-vault-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml`  
**Workspace rules:** `AGENTS.md` — companion- prefix, backend-only implementation, OpenAPI mandatory on contract changes

---

## Goal

Extend the existing **daily summary vault** (`health_daily_summaries`, one row per local calendar day) with additional HealthKit-derived metrics — sleep, heart, workouts, body, nutrition, mindfulness, and flights climbed — without a new table or ingest route.

Hermes continues to answer questions via the same MCP tools and `companion-user-health` skill; iOS sends richer `metrics` objects on the existing `POST /data/health/daily-summaries` upsert.

---

## Repository scope

| Artifact | Where | Implemented here? |
|----------|-------|-------------------|
| Metric key + unit validation | `messaging-api/src/lib/health-metrics.ts` | **Yes** |
| OpenAPI v2.4.0 | `docs/superpowers/specs/messaging-api.openapi.yaml` | **Yes** |
| `companion-user-health` skill | `data/skills/` | **Yes** |
| `companion-app` routing rows | `data/skills/companion-app/SKILL.md` | **Yes** |
| HealthKit queries + Health tab UI | `assistant-companion` | **No** — iOS reference plan only |

**Unchanged:** REST paths, DB schema (`metrics_json` TEXT), MCP tool names, HAL pagination, `partial` / `finalized_at` semantics.

---

## Principles (carry forward from v1)

| Principle | Detail |
|-----------|--------|
| **App owns HealthKit** | iOS computes all aggregates; API validates and stores |
| **Same daily row** | All metrics for day `D` live in one `metrics` object on that row |
| **Optional keys** | iOS may omit categories the user has not authorized or that have no data |
| **Cumulative totals** | Day-to-date totals for activity/nutrition; latest-of-day for body metrics |
| **No new server cron** | Finalization lifecycle unchanged |
| **Backward compatible** | v1 iOS clients sending only activity ring metrics remain valid |

---

## Metric catalog (v2.4.0)

All scalar metrics use the existing `HealthMetric` shape: `{ value, unit, goal, remaining }`.

| Metric key | Unit | Typical goal | HealthKit source (iOS) | Notes |
|------------|------|--------------|------------------------|-------|
| **Activity (v1)** | | | | |
| `steps` | `count` | user step goal | `HKQuantityTypeIdentifierStepCount` | unchanged |
| `distance_walking_running` | `m` | optional | `HKQuantityTypeIdentifierDistanceWalkingRunning` | unchanged |
| `active_energy` | `kcal` | move ring | `HKQuantityTypeIdentifierActiveEnergyBurned` | unchanged |
| `exercise_minutes` | `min` | exercise ring | `HKQuantityTypeIdentifierAppleExerciseTime` | unchanged |
| `stand_hours` | `h` | stand ring | `HKQuantityTypeIdentifierAppleStandHour` (count of hours) | unchanged |
| `flights_climbed` | `count` | null | `HKQuantityTypeIdentifierFlightsClimbed` | daily sum |
| **Sleep** | | | | |
| `sleep_duration` | `min` | null | `HKCategoryTypeIdentifierSleepAnalysis` (asleep*) | total asleep minutes |
| `sleep_in_bed` | `min` | null | sleep inBed | |
| `sleep_deep` | `min` | null | asleepDeep | Watch / iOS 16+ |
| `sleep_rem` | `min` | null | asleepREM | |
| `sleep_core` | `min` | null | asleepCore (or asleepUnspecified) | |
| **Heart** | | | | |
| `resting_heart_rate` | `bpm` | null | `HKQuantityTypeIdentifierRestingHeartRate` | daily average or most recent |
| `heart_rate_avg` | `bpm` | null | `HKQuantityTypeIdentifierHeartRate` | daily average |
| `hrv_sdnn` | `ms` | null | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | daily average |
| **Workouts** | | | | |
| `workout_count` | `count` | null | `HKWorkout` count ending on day | |
| `workout_minutes` | `min` | null | sum of workout durations | |
| `workout_types` | — | — | derived from workouts | **not** a `HealthMetric`; see below |
| **Body** | | | | |
| `weight` | `kg` | null | `HKQuantityTypeIdentifierBodyMass` | latest sample on day |
| `bmi` | `count` | null | `HKQuantityTypeIdentifierBodyMassIndex` | latest on day; dimensionless |
| `body_fat_percentage` | `pct` | null | `HKQuantityTypeIdentifierBodyFatPercentage` | latest on day; value 0–100 |
| **Nutrition** | | | | |
| `dietary_energy` | `kcal` | null | `HKQuantityTypeIdentifierDietaryEnergyConsumed` | daily sum |
| `protein` | `g` | null | `HKQuantityTypeIdentifierDietaryProtein` | daily sum |
| `water` | `ml` | null | `HKQuantityTypeIdentifierDietaryWater` | daily sum |
| **Mindfulness** | | | | |
| `mindfulness_minutes` | `min` | null | `HKCategoryTypeIdentifierMindfulSession` | total minutes |

### `workout_types` (non-scalar)

Optional object on `metrics` (sibling to scalar keys):

```json
"workout_types": {
  "types": ["running", "walking", "traditional_strength_training"]
}
```

| Rule | Value |
|------|-------|
| `types` | non-empty strings, 1–64 chars, lowercase slug |
| max items | 20 |
| uniqueness | required |
| goal / remaining | N/A |

iOS maps `HKWorkoutActivityType` raw values to stable lowercase slugs (e.g. `running`, `cycling`). Hermes presents human-readable labels in replies.

### Unit enum extension

v1: `count`, `m`, `kcal`, `min`, `h`  
v2 adds: `bpm`, `ms`, `kg`, `pct`, `g`, `ml`

---

## Sleep day attribution (iOS-owned)

Sleep rows are attributed to the **local calendar day when the main sleep session ends** (wake day). Example: asleep 23:00 Mon → wake 07:00 Tue → metrics attach to **Tuesday**.

The API does not infer sleep windows from timestamps; it stores whatever day + totals iOS sends.

---

## Goal / remaining rules (unchanged)

- When `goal` is a number, `remaining` must equal `max(0, goal − value)` or upsert returns `400`.
- When `goal` is `null`, `remaining` must be `null`.
- v2 metrics default to `goal: null`, `remaining: null` unless a future iOS setting adds targets (e.g. sleep goal, water goal).

---

## Hermes question coverage (new)

| User question | Field(s) |
|---------------|----------|
| "How did I sleep last night?" | `sleep_duration`, optional stages |
| "How much deep sleep?" | `sleep_deep` |
| "What's my resting heart rate?" | `resting_heart_rate` |
| "What workouts did I do today?" | `workout_count`, `workout_types.types` |
| "How long did I work out?" | `workout_minutes` |
| "What's my weight?" | `weight` (note date) |
| "How many calories did I eat?" | `dietary_energy` |
| "Protein today?" | `protein` |
| "How much water?" | `water` |
| "Did I meditate?" | `mindfulness_minutes` |
| "Flights climbed?" | `flights_climbed` |

---

## API contract delta (v2.4.0)

No new routes. Changes:

1. `HealthMetric.unit` enum extended with `bpm`, `ms`, `kg`, `pct`, `g`, `ml`.
2. `HealthMetrics` properties extended with all v2 keys + `workout_types`.
3. New schema `HealthWorkoutTypes`.
4. `validateHealthMetrics` accepts new keys; rejects unknown keys.

MCP tools (`get_user_health_today`, `get_user_health_daily`, `get_user_health_history`) return the expanded `metrics` object transparently — no MCP signature change.

---

## Skill updates

### `companion-user-health`

- Extend `HealthDayRecord.metrics` documentation with v2 keys.
- Add data workflows for sleep, heart, workouts, body, nutrition, mindfulness.
- Staleness / `partial` rules unchanged.

### `companion-app`

Add routing rows:

| Intent | Load |
|--------|------|
| Sleep / rest questions | `companion-user-health` → `companion-replies` |
| Heart rate / HRV | `companion-user-health` → `companion-replies` |
| Workouts today / this week | `companion-user-health` → `companion-replies` (optional `companion-markdown-blocks`) |
| Weight / body composition | `companion-user-health` → `companion-replies` |
| Nutrition / water / protein | `companion-user-health` → `companion-replies` |
| Mindfulness / meditation | `companion-user-health` → `companion-replies` |

---

## Backward compatibility

| Case | Behavior |
|------|----------|
| v1 iOS sends 5 activity metrics | Accepted; stored as today |
| v2 iOS sends subset (auth denied for nutrition) | Accepted; omitted keys absent in JSON |
| Old Hermes skill without v2 docs | Can still read `metrics.steps`; new keys ignored until skill updated |
| Existing DB rows | `metrics_json` unchanged; new keys appear on next sync |

No migration. No version field on rows.

---

## Out of scope (v2.4.0)

- Per-workout event log (separate vault)
- Intraday HR / step samples
- Sleep goal / water goal user settings (API accepts goals if iOS sends them; no new settings contract)
- Batch upsert endpoint
- Health tab charts (iOS)
- Clinical records, cycle tracking, SpO₂, respiratory rate

---

## Testing (backend)

| Test | Expectation |
|------|-------------|
| Upsert with sleep + heart metrics | 204; keys round-trip on GET |
| Invalid unit for metric key | 400 |
| `workout_types.types` duplicate entries | 400 |
| `workout_types` with scalar metric in same payload | 204 |
| v1-only payload | 204 (regression) |
| MCP today returns v2 metrics | available + expanded metrics |