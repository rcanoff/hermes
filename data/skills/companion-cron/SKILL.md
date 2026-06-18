---
name: companion-cron
description: Companion App scheduled jobs (Hermes cron). Create job conversations, link Hermes cron jobs, and manage schedules from chat.
version: 1.0.0
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

## Create flow (from a regular conversation)

1. Parse schedule + task into a self-contained Hermes cron `prompt`.
2. MCP `create_job_conversation` with `username`, `name`, optional `schedule_display`.
3. `cronjob` `action='create'` with schedule, prompt, and deliver:
   ```
   webhook:http://messaging-api:3000/internal/cron/deliver?job_id=<JOB_ID_AFTER_CREATE>
   ```
   After create, update deliver URL with the real `job_id` if needed via `cronjob` `update`.
4. MCP `link_job_conversation` with `conversation_id`, `hermes_job_id`, `schedule_display`.
5. Reply in the **regular** conversation with `conversation_id` and `hermes_job_id` only (plus brief confirmation). Do not add navigation UX.
6. Post a short schedule summary as the first message in the **job** conversation (user message + normal reply path).

## Job conversation

- Load `companion-replies` for presentation when needed.
- User edits ("pause", "change to 9am", "remove") → `cronjob` `list` / `update` / `pause` / `resume` / `remove` for this conversation's `hermes_job_id`.
- Scheduled run outputs arrive as assistant messages via webhook — do not `send_message` duplicate deliveries.

## Silent monitoring

For watch jobs with nothing to report, cron prompt must end with: respond with exactly `[SILENT]` when there is nothing new.

## Deliver URL

Internal Docker network example:

```
webhook:http://messaging-api:3000/internal/cron/deliver?job_id=<hermes_job_id>
```

Bearer auth is configured operator-side (`CRON_WEBHOOK_BEARER`); Hermes handles delivery — do not call the webhook from chat.