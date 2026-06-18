---
name: companion-user-health
description: Data skill — fetch and normalize a companion user's daily health summaries from the vault via MCP. Use for steps, rings, sleep, heart, workouts, body, nutrition, mindfulness, or historical health questions. Never Home Assistant.
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [companion, health, mcp, mobile, fitness, data]
    related_skills: [companion-replies, companion-markdown-blocks, companion-account-management]
---

# Companion User Health

## Overview

This is a **data skill**. It fetches daily health summaries from the companion vault in `messaging-api` and normalizes the result into a fixed internal record. It does **not** own reply formatting — delegate presentation to `companion-replies` and `companion-markdown-blocks` on Companion App channels.

The vault is the **only** source for companion user health data. **Never** call Home Assistant or any external fitness API.

iOS owns HealthKit sync and day finalization. The API is passive storage — it upserts rows by `(user_id, date)` when the app syncs.

## When to use

- "how many steps today?", "steps so far", or current-day activity totals
- "how many steps left to my goal?", move/exercise/stand ring progress
- sleep, heart rate, HRV, workouts, weight, nutrition, water, mindfulness, or flights climbed
- "how many steps last Tuesday?", "what was my exercise on …?", or other historical health questions
- Any skill needs the operator's daily health metrics for a specific calendar day

## Username resolution

| Channel | Default `username` for MCP calls |
|---------|----------------------------------|
| Companion App | The authenticated user for this conversation (injected in the Companion App system prompt) |
| Telegram / CLI / dashboard | The companion account the question refers to; ask if unclear |

Rules:

- On Companion App, **always** use the authenticated user's username unless the user explicitly asks about someone else.
- For cross-user questions on non-app channels, call `list_companion_accounts` from `companion-account-management` to discover usernames.
- Never guess a username.

## Tools (companion MCP)

- `get_user_health_today` — latest summary row by `date` (typically today when syncing); **requires `username`**
- `get_user_health_daily` — summary for a specific `YYYY-MM-DD` local calendar day; **requires `username` and `date`**
- `get_user_health_history` — paginated day list with HAL `_links`; **requires `username`** (`limit` default 20, max 100; optional `before` or `after` UUID anchors)

## Internal data format

After every MCP call, normalize into a **HealthDayRecord** before passing data to presentation skills or other workflows.

### Available

```yaml
available: true
username: <string>
date: <YYYY-MM-DD>
timezone: <IANA string>
partial: <boolean>                # true = day still in progress
synced_at: <ISO-8601 string>
finalized_at: <ISO-8601 | null>   # set when partial=false
metrics:
  steps: { value, unit, goal, remaining }
  distance_walking_running: { value, unit, goal, remaining }
  active_energy: { value, unit, goal, remaining }
  exercise_minutes: { value, unit, goal, remaining }
  stand_hours: { value, unit, goal, remaining }
  flights_climbed: { value, unit, goal, remaining }
  sleep_duration: { value, unit, goal, remaining }
  sleep_in_bed: { value, unit, goal, remaining }
  sleep_deep: { value, unit, goal, remaining }
  sleep_rem: { value, unit, goal, remaining }
  sleep_core: { value, unit, goal, remaining }
  resting_heart_rate: { value, unit, goal, remaining }
  heart_rate_avg: { value, unit, goal, remaining }
  hrv_sdnn: { value, unit, goal, remaining }
  workout_count: { value, unit, goal, remaining }
  workout_minutes: { value, unit, goal, remaining }
  weight: { value, unit, goal, remaining }
  bmi: { value, unit, goal, remaining }
  body_fat_percentage: { value, unit, goal, remaining }
  dietary_energy: { value, unit, goal, remaining }
  protein: { value, unit, goal, remaining }
  water: { value, unit, goal, remaining }
  mindfulness_minutes: { value, unit, goal, remaining }
  workout_types: { types: [<lowercase slug>, ...] }
```

Metric keys are optional — only include keys present in the MCP response. Sleep is attributed to the wake-day calendar date iOS sends.

### Unavailable

```yaml
available: false
username: <string>
date: <YYYY-MM-DD>                # only on get_user_health_daily misses
```

Do not emit user-facing prose from raw MCP JSON. Always normalize first.

## Staleness and partial data

- **`partial: true`** — the local calendar day is still in progress; totals will change as the app syncs.
- **`synced_at`** — when the vault last received data for this day. When answering "today" questions, note if `synced_at` is old (e.g. "as of 2 hours ago").
- **`get_user_health_today`** returns the **most recent `date`** row when today has no sync yet — treat as stale and mention the `date` in the answer.
- When `available: false`, hand off to `companion-replies` for a plain-text unavailable message.

## Data workflow — today / current activity

1. Resolve `username` (see table above).
2. Call `get_user_health_today` via companion MCP.
3. Normalize the response into a HealthDayRecord.
4. Hand off to presentation skills (see Consumers).

**Intent examples:**

- "How many steps today?" → report `metrics.steps.value` with unit; note `partial` and `synced_at` staleness.
- "How many steps left to my goal?" → report `metrics.steps.remaining` when `goal` is set; otherwise say goal is unknown.
- If the record has steps but no goal/remaining, do not estimate the target from pace, time of day, or other sensors; answer with the available step total and say the goal is unavailable.
- "How's my exercise ring?" → report `metrics.exercise_minutes` value, goal, and remaining; optional ring-style layout via `companion-markdown-blocks`.

## Data workflow — specific day

For "steps last Tuesday" or a named date:

1. Resolve `username`.
2. Convert the user's date reference to `YYYY-MM-DD` in their timezone when possible.
3. Call `get_user_health_daily` with `username` and `date`.
4. Normalize into a HealthDayRecord and summarize the requested metrics.

## Data workflow — sleep

1. Resolve `username`.
2. Call `get_user_health_today` or `get_user_health_daily`.
3. Report `sleep_duration` (and stages if present). State the record `date` — wake-day attribution may differ from colloquial "last night".

## Data workflow — heart

Report `resting_heart_rate`, `heart_rate_avg`, or `hrv_sdnn` when asked. Include unit in the answer.

## Data workflow — workouts

Report `workout_count`, `workout_minutes`, and humanize `workout_types.types` (e.g. `traditional_strength_training` → "traditional strength training").

## Data workflow — body / nutrition / mindfulness

Report latest-day `weight`, `bmi`, `body_fat_percentage`, or daily sums `dietary_energy`, `protein`, `water`, `mindfulness_minutes`, `flights_climbed`.

## Data workflow — history

For trends or multi-day questions:

1. Resolve `username`.
2. Call `get_user_health_history` with an appropriate `limit`.
3. Normalize each summary to the available HealthDayRecord shape.
4. Summarize matching days by date and requested metrics.
5. To load older days, re-call with `before` from `_links.next.href`. Use `after` for newer pages via `_links.prev`.

## Consumers

- **`companion-replies`** — owns plain-text health answers (steps count, goal remaining, ring status).
- **`companion-markdown-blocks`** — optional tables or progress layouts for ring metrics (move / exercise / stand).

## Channel behavior

| Channel | Writes to vault | Reads health |
|---------|----------------|--------------|
| iOS companion | Yes (HealthKit sync) | this skill → MCP |
| Telegram | No | this skill → MCP |
| CLI / dashboard | No | this skill → MCP |

Telegram does not ingest health data. It reads whatever the app last synced. Report last-known totals with `synced_at` staleness or unavailability.

## Do not use

- Home Assistant or any non-vault fitness integration
- Server-side HealthKit assumptions — the API does not finalize days or compute totals
- Guessing metrics when `goal` or `remaining` is null