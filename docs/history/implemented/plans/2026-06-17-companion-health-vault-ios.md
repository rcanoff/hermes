# Companion Health Vault — iOS Plan

**Date:** 2026-06-17  
**Status:** Planned  
**Backend:** messaging-api OpenAPI v2.0.0  
**Companion repo:** `assistant-companion` (not in this workspace)  
**Design spec:** `docs/superpowers/specs/2026-06-17-companion-health-vault-ios-design.md`  
**Backend plan:** `docs/superpowers/plans/2026-06-17-companion-health-vault-backend.md`

---

## Context

Add a **Health** tab with live HealthKit metrics, user-editable **step goal**, and vault sync so Hermes answers granular questions ("steps today?", "steps to goal?").

**No midnight job.** Finalize completed days on the **next sync**, catching up **day by day** through any multi-day gap.

---

## Prerequisites

- Backend v2.0.0 deployed (`/data/health/daily-summaries`, MCP health tools)
- OpenAPI client regenerated or extended for v2.0.0
- Location vault sync patterns as reference (JWT POST, sharing toggle)

---

## Milestone 1: HealthKit authorization

- [ ] Add HealthKit capability to app target
- [ ] Request read types: `stepCount`, `distanceWalkingRunning`, `activeEnergyBurned`, `appleExerciseTime`, `appleStandHour`, `activitySummaryType`
- [ ] `HealthKitManager` (or extend existing) with authorization status + `requestAuthorization()`

---

## Milestone 2: Step goal persistence

- [ ] `HealthPreferences.stepGoal` in UserDefaults (default `10_000`)
- [ ] Goal editor in Health tab (Stepper or TextField with validation)
- [ ] Compute `remaining = max(0, goal - value)` before each vault POST

---

## Milestone 3: Health tab UI (v1)

- [ ] Add **Health** root tab in app shell
- [ ] **Today's activity** section — live values from HealthKit (not vault)
- [ ] Ring-style or list layout: steps (with goal progress), distance, move, exercise, stand
- [ ] **Sharing** toggle (mirror location)
- [ ] **Last synced** label from local sync timestamp or vault `synced_at`
- [ ] Permission denied state with Settings deep link
- [ ] Pull-to-refresh → triggers sync

---

## Milestone 4: Sync engine

### Local state

```swift
struct HealthSyncState {
    var lastFinalizedDate: String?   // YYYY-MM-DD
    var lastSyncedAt: Date?
}
```

Persist in UserDefaults. Optional bootstrap from `GET /data/health/daily-summaries/latest` on first launch.

### `performHealthSync()` algorithm

```swift
func performHealthSync() async throws {
    guard sharingEnabled, healthKitAuthorized else { return }

    let today = localCalendarTodayString()
    let timezone = TimeZone.current.identifier
    var start = dayAfter(lastFinalizedDate) ?? firstRunStartDate()

    while start < today {
        let metrics = try await healthKit.completedDayMetrics(date: start, stepGoal: stepGoal)
        try await api.upsertHealthDailySummary(
            date: start, timezone: timezone, partial: false, metrics: metrics
        )
        start = nextDay(start)
    }

    let todayMetrics = try await healthKit.inProgressDayMetrics(date: today, stepGoal: stepGoal)
    try await api.upsertHealthDailySummary(
        date: today, timezone: timezone, partial: true, metrics: todayMetrics
    )

    lastFinalizedDate = previousDay(today)
    lastSyncedAt = Date()
}
```

### Triggers

| Trigger | Sync |
|---------|------|
| Health tab `onAppear` | full |
| Pull-to-refresh | full |
| App foreground (sharing on, stale > 30 min) | full |
| HealthKit background delivery | full |

### Multi-day gap

If `lastFinalizedDate` is Monday and user opens Saturday: loop finalizes Tue, Wed, Thu, Fri (four POSTs), then upserts Saturday `partial: true`.

On network failure mid-loop: **stop**, do not advance `lastFinalizedDate` past last successful day.

### Zero-activity days

POST finalize with zero values — no gaps in vault history.

---

## Milestone 5: HealthKit queries

- [ ] `completedDayMetrics(date:)` — `HKStatisticsQuery` per metric for local startOfDay..endOfDay
- [ ] `inProgressDayMetrics(date:)` — startOfDay..now for today
- [ ] `HKActivitySummaryQuery` for move/exercise/stand goals when Watch data exists
- [ ] Map to API `HealthMetrics` JSON with correct units (`count`, `m`, `kcal`, `min`, `h`)

---

## Milestone 6: API client

Extend client from OpenAPI v2.0.0:

```swift
POST /data/health/daily-summaries   // 204
GET  /data/health/daily-summaries/latest
GET  /data/health/daily-summaries   // HAL pagination
```

Handle `409 day_finalized` — log only; should not occur if iOS never sends `partial: true` for past dates.

---

## Milestone 7: Verification

1. Health tab shows live steps without sync
2. Sharing on → POST creates vault row; Hermes `get_user_health_today` returns steps
3. Change step goal → next sync updates `metrics.steps.goal` and `remaining`
4. Simulate 3-day gap (inject `lastFinalizedDate`) → 3 finalize POSTs + today partial
5. Sharing off → no POSTs
6. Ask Hermes "how many steps to hit my goal?" → uses `remaining`

---

## Deploy order

1. Deploy `hermes` backend v2.0.0 + `companion-user-health` skill
2. Ship iOS Health tab update
3. No hard dependency on companion-app bootstrap changes (health skill loaded by intent)

---

## Out of scope (iOS v1)

- Midnight `BGTask`
- Sleep, heart rate, workouts
- In-tab historical charts
- watchOS / widgets
- Batch upsert API