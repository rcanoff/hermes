---
name: companion-cron
description: Companion App scheduled jobs (Hermes cron). Create job conversations, link Hermes cron jobs, and manage schedules from chat.
version: 1.2.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, cron, jobs, scheduling]
    related_skills: [companion-app, companion-replies]
---

# Companion Cron

## When to use

- User asks to be reminded later, run something on a schedule, or manage an existing job
- You are in a **job conversation** (`companion-cron` bootstrap)
- Deferred schedules from the companion app (not Apple Calendar unless explicitly requested)

## Hard rules

- **Never** create companion reminders with `deliver: origin` or by omitting `deliver` — that sends to Telegram, not the companion app.
- **Always** use `deliver: local` for companion jobs. `messaging-api` ingests Hermes cron output files and posts assistant messages into the linked job conversation.
- **Always** run the full create flow below before replying "done" — `cronjob` alone is not enough.
- **Never** write cron prompts that say *send*, *deliver*, *notify*, *message the user*, or *current conversation user* — the cron runner has no companion send tool; it only **outputs text** that `messaging-api` delivers via `deliver: local`.
- For simple reminders, the cron `prompt` must instruct **literal final output only** (see templates below). Do not ask the cron agent to use tools.

## Cron prompt templates

Companion delivery is **output-only**: Hermes prepends a delivery preamble, runs the job, writes `## Response` to disk, and `messaging-api` posts that text into the linked job conversation. The cron agent must **not** call `send_message`, `tool_search`, `skill_view`, or terminal.

### Simple reminder (default for "remind me to …")

Use this shape — replace the reminder line only:

```
Scheduled reminder only. Your entire response must be exactly one line:

Reminder: <short user-facing reminder text>

No tools. No other text, steps, or narration.
```

**Example** (user: "remind me to get water in 1m"):

```
Scheduled reminder only. Your entire response must be exactly one line:

Reminder: Get water.

No tools. No other text, steps, or narration.
```

### Bad vs good prompt wording

| Bad (causes tool-hunt failures) | Good |
|---------------------------------|------|
| Send a reminder to get water to the current conversation user. | Scheduled reminder only… `Reminder: Get water.` |
| Notify the user to drink water. | … `Reminder: Drink some water.` |
| Use the companion app to remind them. | … `Reminder: <task>.` |

### Monitoring / digest jobs

For recurring checks (HA digest, inbox watch, etc.), end the prompt with: respond with exactly `[SILENT]` when there is nothing new to report. Do not use the one-line reminder template for those jobs.

## Create flow (from a regular conversation)

1. Parse schedule + task; build the Hermes cron `prompt` using the templates above (reminder → one-line template).
2. MCP `create_job_conversation` with `username`, `name`, optional `schedule_display`.
3. `cronjob` `action='create'` with schedule, prompt, and **`deliver: local`**.
4. MCP `link_job_conversation` with `conversation_id`, `hermes_job_id`, `schedule_display`.
5. Reply in the **regular** conversation with brief confirmation only (include `conversation_id` and `hermes_job_id` for operator debugging). Do not add navigation UX.
6. Post a short schedule summary as the first message in the **job** conversation (user message + normal reply path).

## Job conversation

- Load `companion-replies` for presentation when needed.
- User edits ("pause", "change to 9am", "remove") → `cronjob` `list` / `update` / `pause` / `resume` / `remove` for this conversation's `hermes_job_id`.
- Scheduled run outputs arrive as assistant messages via the output bridge — do not `send_message` duplicate deliveries.

## Silent monitoring

For watch jobs with nothing to report, cron prompt must end with: respond with exactly `[SILENT]` when there is nothing new.

## Delivery

Companion delivery path:

1. Hermes runs the cron job and writes output under `data/cron/output/<hermes_job_id>/`.
2. `messaging-api` polls that directory and commits assistant messages into the linked `kind=job` conversation.

Optional future path (when Hermes outbound webhook deliver is enabled):

```
webhook:http://messaging-api:3000/internal/cron/deliver?job_id=<hermes_job_id>
```

Bearer auth for that webhook is operator-side (`CRON_WEBHOOK_BEARER`). Do not call the webhook from chat.