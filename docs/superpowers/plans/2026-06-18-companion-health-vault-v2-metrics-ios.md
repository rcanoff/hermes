# Companion Health Vault v2 Metrics — iOS Handoff (Stub)

> **Repo boundary:** Implement in `assistant-companion` (Swift). This document is a reference stub for the iOS agent. Backend contract: OpenAPI v2.4.0, design `docs/superpowers/specs/2026-06-18-companion-health-vault-v2-metrics-design.md`.

**Goal:** Extend HealthKit sync to populate v2 metric keys on the existing `POST /data/health/daily-summaries` upsert. No new API routes.

**Prerequisites:** Health v1 tab + sync shipped; OpenAPI client updated to v2.4.0.

---

## iOS agent: write full plan here

The iOS agent should expand this stub into a full implementation plan covering:

1. **HealthKit authorization** — request read types per category (sleep, heart, workouts, body, nutrition, mindfulness, flights).
2. **Query helpers** — daily statistics / category aggregates per metric key in the design spec table.
3. **Sleep attribution** — attribute sleep to wake-day per design spec.
4. **Workout slug map** — `HKWorkoutActivityType` → lowercase slug for `workout_types.types`.
5. **Sync engine** — include new keys in partial/finalized upserts; omit keys when auth denied or no data.
6. **Health tab UI** — optional v2 sections (can ship sync-first, UI later).
7. **Tests** — unit tests for aggregation helpers with injected `HKHealthStore` mocks.

**Unchanged:** `lastFinalizedDate` lifecycle, sharing toggle, step goal, sync schedule.