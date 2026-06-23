---
name: companion-cron
description: Companion App scheduled jobs (Hermes cron). Create job conversations, link Hermes cron jobs, and manage schedules from chat.
version: 1.13.0
author: Hermes Agent
metadata:
  hermes:
    tags: [companion, cron, jobs, scheduling]
    related_skills: [companion-app, companion-replies, companion-map-preview, companion-links]
---

# Companion Cron

## When to use

- User asks to be reminded later, run something on a schedule, or manage an existing job
- You are in a **job conversation** (`companion-cron` bootstrap)
- Deferred schedules from the companion app (not Apple Calendar unless explicitly requested)

## Hard rules

- **Never** create companion reminders with `deliver: origin` or by omitting `deliver` — that sends to Telegram, not the companion app.
- **Always** use `deliver: local` for companion jobs. `messaging-api` ingests Hermes cron output files and posts assistant messages into the linked job conversation.
- **Always** set `model: { provider: 'openai-api', model: 'gpt-5.4' }` on `cronjob` `action='create'`. `messaging-api` auto-link backfills this if omitted.
- **Do not** put `companion-cron` in cron job `skills` — that skill is for **job-chat** (bootstrap). Hermes inlines full skill bodies at run time; loading `companion-cron` there drowns the task and causes bad `[SILENT]` runs.
- For scheduled runs, **omit `skills`** on the cron job — use a self-contained `prompt` instead.
- **Always** run the full create flow below before replying "done" — `cronjob` alone is not enough.
- **Never** write cron prompts that say *send*, *deliver*, *notify*, *message the user*, or *current conversation user* — the cron runner only **outputs text** that `messaging-api` delivers via `deliver: local`.

## Useful reminders (core goal)

The fired message must be **actionable without reopening the source chat**. Do the user's homework at create time.

Read recent messages — not just the last one. Resolve `this` / `that` / `it`. Then bake into the cron `prompt` whatever the user will need at fire time:

- Product name + where to buy + **links already discussed** + price if known
- Route / place + ` ```map ` block + Apple Maps link (copy from conversation — never paraphrase as prose)
- Photo / topic + short recap of what to follow up on
- Plain tasks with no prior context ("drink water") can stay short

`messaging-api` classifies each new job (`reminder` vs `ha_digest` vs `monitoring`) and rewrites reminder prompts from the source conversation (gpt-5.4). A one-shot reminder in an HA thread is still a **reminder**, not a digest. Your draft is a hint — still write the most useful prompt you can.

**Bad:** `Reminder: Buy Offley Rosé.`  
**Good:** reminder line + Amazon link + €19.22 price from the chat.

Companion delivery is **output-only**: the cron agent's final response is the message. No `send_message`.

### Monitoring / digest jobs

Recurring checks (HA digest, inbox watch): describe task + sources + output format. End with `[SILENT]` when nothing to report.

**Home Assistant daily digest (companion):** load `home-assistant-mcp` reference `daily-digest-preview.md` while **creating** the job. Self-contained prompt with mandatory `tool_search` → `mcp_ha_*`. `deliver: local`, omit `skills` on the job record.

### Cron job `skills` (scheduled run only)

| Job kind | `skills` on job record |
|----------|------------------------|
| Reminders | omit — self-contained prompt |
| HA digest / monitoring | omit — self-contained digest prompt |

**Never** `companion-cron` or `home-assistant-mcp` on the job record.

## Create flow (from a regular conversation)

1. Parse schedule + task; read recent conversation; draft the most useful self-contained cron `prompt` you can.
2. MCP `create_job_conversation` with `username`, `name`, optional `schedule_display`.
3. `cronjob` `action='create'` with schedule, prompt, **`deliver: local`**, **`model: { provider: 'openai-api', model: 'gpt-5.4' }`**.
4. MCP `link_job_conversation` with `conversation_id`, `hermes_job_id`, `schedule_display`.
5. Would the fired message still help the user without the source chat? If not, `cronjob` `update` the prompt before saying done.
6. Reply in the **regular** conversation with brief confirmation only (include `conversation_id` and `hermes_job_id` for operator debugging).
7. Post a short schedule summary as the first message in the **job** conversation.

## Job conversation

- Load `companion-replies` for presentation when needed.
- The bootstrap names this thread's linked `job_id` — use it for all job actions.
- User edits → `cronjob` `update` / `pause` / `resume` / `remove` with the same `job_id`.
- When updating a reminder prompt, keep it useful and self-contained (links, prices, map blocks from context).
- Scheduled run outputs arrive via the output bridge — do not `send_message` duplicate deliveries.

### Run once / trigger now

1. `cronjob` `action='run'` with the linked `job_id`.
2. `run` only **queues** the job (next tick, up to ~60s).
3. Reply with one short queue ack only — e.g. "Queued — the reminder will appear here shortly."
4. Actual output arrives later as a separate assistant message via the output bridge.

## Silent monitoring

Watch jobs with nothing to report: cron prompt must end with respond exactly `[SILENT]` when there is nothing new.

## Delivery

1. Hermes runs the cron job and writes output under `data/cron/output/<hermes_job_id>/`.
2. `messaging-api` polls that directory and commits assistant messages into the linked `kind=job` conversation.

Optional future webhook: `webhook:http://messaging-api:3000/internal/cron/deliver?job_id=<hermes_job_id>` (operator `CRON_WEBHOOK_BEARER`).