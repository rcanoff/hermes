# Companion Cron (Job Conversations) — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, `data/skills/`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml`. A task is not done until OpenAPI matches shipped behavior.

**Goal:** Hermes cron parity for companion via job conversations, `GET /jobs`, webhook delivery into job threads, and MCP tools for Hermes to create/link job conversations.

**Architecture:** Hermes `jobs.json` runs schedules; `deliver: webhook:http://messaging-api:3000/internal/cron/deliver?job_id=…` posts run output to `messaging-api`, which commits assistant messages + sync events. Job metadata lives on `conversations` rows with `kind=job`.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest, Hermes skills/MCP

**Spec:** `docs/superpowers/specs/2026-06-18-companion-cron-design.md`  
**iOS reference:** `docs/superpowers/specs/2026-06-18-companion-cron-ios-design.md`

---

## File Structure

```
messaging-api/
  src/
    lib/job-conversation.ts           — CREATE: kind validation, bootstrap text
    db/schema.ts                      — MODIFY: conversation job columns
    db/repos/conversations.ts         — MODIFY: kind, job fields, listJobsPage
    db/repos/cron-deliver.ts          — CREATE: commit webhook run output
    routes/jobs.ts                    — CREATE: GET /jobs
    routes/cron-internal.ts           — CREATE: POST /internal/cron/deliver
    routes/index.ts                   — MODIFY: register routes
    services/mcp-tools.ts             — MODIFY: create/link job conversation tools
    services/mcp-server.ts            — MODIFY: register new tools
    config.ts                         — MODIFY: cronWebhookBearer
  test/
    jobs.test.ts                      — CREATE
    cron-deliver.test.ts              — CREATE
    mcp-job-conversations.test.ts     — CREATE
    conversations.test.ts             — MODIFY: kind fields

data/skills/
  companion-cron/SKILL.md             — CREATE
  companion-app/SKILL.md              — MODIFY: cron routing row

docs/superpowers/specs/messaging-api.openapi.yaml — MODIFY: v2.3.0
README.md                                         — MODIFY: companion cron section
.env.example                                      — MODIFY: CRON_WEBHOOK_BEARER
```

---

## Task 0: OpenAPI v2.3.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] Bump `info.version` to `2.3.0` with changelog entry
- [ ] Add `ConversationKind` enum: `regular`, `job`
- [ ] Extend `Conversation` + `ConversationSyncEntry` with optional job fields
- [ ] Add `GET /jobs` route + `JobListResponse` HAL envelope
- [ ] Document that `POST /internal/cron/deliver` is **not** in OpenAPI (Hermes-only internal)

---

## Task 1: DB migration — job conversation columns

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] Add columns to `conversations`:
  - `kind TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'job'))`
  - `hermes_job_id TEXT UNIQUE`
  - `schedule_display TEXT`
  - `job_enabled INTEGER NOT NULL DEFAULT 1`
  - `job_last_run_at TEXT`
  - `job_last_status TEXT`
- [ ] Index: `conversations_user_kind_updated_idx ON conversations(user_id, kind, updated_at DESC)`
- [ ] Test: schema includes new columns

---

## Task 2: Conversation repo — kind + jobs list

**Files:**
- Modify: `messaging-api/src/db/repos/conversations.ts`
- Create: `messaging-api/src/lib/job-conversation.ts`
- Create: `messaging-api/test/jobs.test.ts` (skeleton)

- [ ] `JOB_CONVERSATION_BOOTSTRAP` constant in `job-conversation.ts`
- [ ] `createJobConversation(db, userId, { name, scheduleDisplay? })` → row with `kind=job`, bootstrap set
- [ ] `linkJobConversation(db, userId, { conversationId, hermesJobId, scheduleDisplay?, jobEnabled? })`
- [ ] `listJobsPage(db, userId, pagination)` — HAL page of `kind=job` only
- [ ] `findConversationByHermesJobId(db, hermesJobId)`
- [ ] Extend conversation row mapper to expose job fields on GET

---

## Task 3: `GET /jobs`

**Files:**
- Create: `messaging-api/src/routes/jobs.ts`
- Modify: `messaging-api/src/routes/index.ts` (or app bootstrap)
- Modify: `messaging-api/test/jobs.test.ts`

- [ ] `GET /jobs` — JWT auth, HAL `limit`/`before`/`after` (same rules as conversations)
- [ ] Response: `{ jobs: [...], _links }`
- [ ] 401 without token; empty page returns `next_sync_marker` N/A (not a sync route)
- [ ] Tests: pagination, only returns `kind=job`, user scoping

---

## Task 4: Webhook delivery handler

**Files:**
- Create: `messaging-api/src/db/repos/cron-deliver.ts`
- Create: `messaging-api/src/routes/cron-internal.ts`
- Modify: `messaging-api/src/config.ts`
- Create: `messaging-api/test/cron-deliver.test.ts`
- Modify: `.env.example`

- [ ] Config: `CRON_WEBHOOK_BEARER` (required in production; test default in helpers)
- [ ] `POST /internal/cron/deliver`:
  - Auth: `Authorization: Bearer <CRON_WEBHOOK_BEARER>`
  - Resolve job: `hermes_job_id` from JSON body **or** query `job_id`
  - Body fields: `content` (string), optional `run_at`, `status`
  - `[SILENT]` → `204`
  - Else: insert assistant message, `message_upsert` sync event, update `job_last_run_at` / `job_last_status`
  - `200 { message_id }`
  - Unknown job → `404`
- [ ] Tests: auth, silent, commit, sync event emitted, status fields updated

---

## Task 5: MCP tools

**Files:**
- Modify: `messaging-api/src/services/mcp-tools.ts`
- Modify: `messaging-api/src/services/mcp-server.ts` (if tool registration is separate)
- Create: `messaging-api/test/mcp-job-conversations.test.ts`

- [ ] `create_job_conversation({ name, schedule_display? })` — uses authenticated MCP user
- [ ] `link_job_conversation({ conversation_id, hermes_job_id, schedule_display?, job_enabled? })`
- [ ] Validate: target conv is `kind=job`, same user, not already linked
- [ ] Emit `conversation_upsert` sync event on create/link
- [ ] Tests mirror existing MCP patterns (`mcp.test.ts`)

---

## Task 6: Sync + conversation GET extensions

**Files:**
- Modify: `messaging-api/src/db/repos/chat-sync-events.ts` (if conversation mapper needs job fields)
- Modify: `messaging-api/test/chat-sync.test.ts`
- Modify: `messaging-api/test/conversations.test.ts` (or equivalent)

- [ ] `conversation_upsert` payload includes `kind` + job metadata
- [ ] `GET /conversations` and `GET /conversations/{id}` return new fields
- [ ] Tests: job conversation appears in sync feed with correct fields

---

## Task 7: Skills

**Files:**
- Create: `data/skills/companion-cron/SKILL.md`
- Modify: `data/skills/companion-app/SKILL.md`

- [ ] `companion-cron`: create flow (MCP → cronjob → link), edit flow, `[SILENT]`, deliver URL with `job_id` query
- [ ] `companion-app`: route deferred schedules / job management → `companion-cron`
- [ ] Metadata: `companion-` prefix, `related_skills` links

---

## Task 8: Operator docs + Hermes deliver spike

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] README section: companion cron overview, `CRON_WEBHOOK_BEARER`, Hermes deliver format:
  ```
  deliver: webhook:http://messaging-api:3000/internal/cron/deliver?job_id=<HERMES_JOB_ID>
  ```
- [ ] Document spike: verify Hermes webhook POST shape; adapt handler if body is plain text only
- [ ] Note: enable Hermes `webhook` platform in `data/config.yaml` if required for deliver target

---

## Task 9: Integration smoke

- [ ] `cd messaging-api && npm test`
- [ ] Manual: create job via Hermes MCP tools in test harness; simulate webhook POST; confirm message in job conv
- [ ] `GET /jobs` returns linked conversation

---

## Commit strategy

1. `docs: companion cron design + OpenAPI v2.3.0`
2. `feat(messaging-api): job conversation schema and GET /jobs`
3. `feat(messaging-api): cron webhook deliver + MCP tools`
4. `feat(skills): companion-cron skill and routing`
5. `docs: README companion cron operator notes`