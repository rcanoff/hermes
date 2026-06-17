# Companion Health Vault — iOS Design

**Date:** 2026-06-17  
**Status:** Approved  
**Plan:** `docs/superpowers/plans/2026-06-17-companion-health-vault-ios.md`  
**Parent:** `docs/superpowers/specs/2026-06-17-companion-health-vault-design.md`  
**Backend spec:** `docs/superpowers/specs/2026-06-17-companion-health-vault-backend-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v2.0.0)  
**Companion repo:** `assistant-companion` (not in this workspace)

**Prerequisite:** Base app with auth, location vault sync patterns, and OpenAPI client from prior companion work.

---

## Goal

Add a **Health** tab that shows live activity metrics from HealthKit, lets the user set a **step goal**, and syncs daily summaries to the vault so Hermes can answer granular health questions.

---

## Health tab (v1)

### Sections

| Section | Purpose |
|---------|---------|
| **Today's activity** | Steps, distance, move/exercise/stand progress (live from HealthKit) |
| **Step goal** | Editable target; persisted locally; shown as progress (value / goal / remaining) |
| **Sharing** | Toggle vault sync (same UX pattern as location sharing) |
| **Permissions** | HealthKit authorization status + request flow |
| **Last synced** | `synced_at` from vault or local sync state |

### Local vs vault

- **UI reads HealthKit directly** for instant live numbers while the tab is visible.
- **Vault sync** runs on the schedule below so Hermes has data when the user is not in the app.

---

## HealthKit authorization

Request read access for v1 quantity types:

| Metric | HKQuantityTypeIdentifier |
|--------|--------------------------|
| Steps | `stepCount` |
| Distance | `distanceWalkingRunning` |
| Active energy | `activeEnergyBurned` |
| Exercise time | `appleExerciseTime` |
| Stand hour | `appleStandHour` |

Also request **`activitySummaryType`** when available for move/exercise/stand **goals** (Apple Watch).

Do **not** request write types in v1.

Show degraded UI when authorization is denied or partial.

---

## Step goal (user setting)

- Stored in `UserDefaults` or app preferences (key e.g. `healthStepGoal`).
- Default on first launch: **10,000** (configurable constant; user can change immediately).
- Included in every vault upsert as `metrics.steps.goal`.
- iOS computes `metrics.steps.remaining = max(0, goal - value)` before POST.

Ring goals come from `HKActivitySummary` — not user-editable in v1.

---

## Local state: `lastFinalizedDate`

Persist `lastFinalizedDate` (`YYYY-MM-DD` or null) on device.

| Event | Update |
|-------|--------|
| Fresh install, never synced | `null` — first sync finalizes from `(epoch or vault seed)` through yesterday |
| After successful catch-up + today upsert | `today - 1 calendar day` in local timezone |

Optional bootstrap: on login, `GET /data/health/daily-summaries/latest` and set `lastFinalizedDate` from newest `partial: false` row if local state is empty.

---

## Sync engine

### Triggers

| Trigger | Action |
|---------|--------|
| Health tab appears | Full sync |
| App foreground (if sharing on) | Sync if last sync > N minutes (e.g. 30) |
| HealthKit background delivery | Sync when system delivers updates |
| Pull-to-refresh on Health tab | Full sync |

**No midnight `BGTask`.** No alarm at 00:00.

### Algorithm (`performHealthSync`)

Requires: JWT valid, sharing enabled, HealthKit authorized.

```
today ← Calendar.current startOfDay in user timezone (as YYYY-MM-DD)
start ← lastFinalizedDate + 1 day, or first-run start date if null

for date in start ..< today:   // each completed local day
    metrics ← queryHealthKitCompletedDay(date)
    POST /data/health/daily-summaries
      { date, timezone, partial: false, metrics, source: "healthkit" }
    on failure: stop catch-up; retry next sync (do not advance lastFinalizedDate)

metricsToday ← queryHealthKitInProgress(today)
POST /data/health/daily-summaries
  { date: today, timezone, partial: true, metrics, source: "healthkit" }

lastFinalizedDate ← yesterday(today)
persist lastFinalizedDate
```

### Multi-day gap

If `lastFinalizedDate` is Monday and user opens Saturday, the loop runs **Tue → Fri** (four finalize POSTs), then today's partial POST. Order is chronological (oldest gap day first).

### Zero-activity days

Still POST finalize with zeros so vault history is continuous.

### HealthKit queries

- **Completed day:** `HKStatisticsQuery` or `HKStatisticsCollectionQuery` for each metric, scoped to that local calendar day (startOfDay..endOfDay in user timezone).
- **Today in progress:** same query from startOfDay to now.
- **Activity summary:** `HKActivitySummaryQuery` for goals on completed days and today when Watch data exists.

---

## Sharing toggle

When **off:**

- Stop vault POSTs
- Health tab still shows local HealthKit data
- Hermes receives `available: false` from MCP

When **on:**

- Run sync algorithm on triggers above

Mirror location sharing UX (wording, settings placement).

---

## API client

Extend generated / hand-written client from OpenAPI v2.0.0:

```swift
POST /data/health/daily-summaries
GET  /data/health/daily-summaries/latest
GET  /data/health/daily-summaries?limit=&before=&after=
```

Handle **409 `day_finalized`** — should not occur if iOS never sends `partial: true` for past dates; log and treat as success if re-sending finalize.

---

## Tab navigation

Add **Health** as a top-level tab (or equivalent root destination) alongside existing chat/conversations pattern in the app shell.

v1 does not require historical charts in the tab — today + goal + sync status is enough. Hermes covers historical questions via vault.

---

## Error handling

| Condition | UX |
|-----------|-----|
| HealthKit denied | Explain + link to Settings |
| Network failure mid catch-up | Show last synced; retry later; do not advance `lastFinalizedDate` past last successful finalize |
| 401 | Re-auth flow |
| Partial Watch data | Show metrics with `goal: null` where summary missing |

---

## Testing (manual / XCTest)

1. First sync — today row appears in vault with `partial: true`
2. Change step goal — next sync updates `metrics.steps.goal`
3. Simulate day advance (unit test with injected calendar) — gap days finalize in order
4. Sharing off — no POSTs; Hermes unavailable
5. Re-open after 3-day gap — three finalize POSTs + today partial in one session
6. Hermes: "steps today?" and "steps to goal?" return correct values after sync

---

## Out of scope (iOS v1)

- Midnight scheduled tasks
- Sleep, heart rate, workouts UI
- Week/month charts in Health tab
- Widgets / watchOS
- Batch upsert API (sequential POSTs only)

---

## Deploy order

1. Deploy backend v2.0.0 (health routes + MCP)
2. Ship iOS with Health tab + sync
3. Add `companion-user-health` skill + `companion-app` routing in Hermes workspace

Brief overlap: old iOS without Health tab is fine; new backend routes unused until app update.