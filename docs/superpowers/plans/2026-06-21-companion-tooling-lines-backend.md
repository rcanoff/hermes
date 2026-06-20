# Companion Tooling Lines — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, tests, OpenAPI, README). Do **not** implement iOS/Swift changes here. The iOS client (`assistant-companion`) writes its own plan — see `docs/superpowers/specs/2026-06-21-companion-tooling-lines-ios-design.md`.

> **HARD RULE — OpenAPI gate:** Contract is **v2.7.0** in `docs/superpowers/specs/messaging-api.openapi.yaml`. Verify it matches implementation before merge.

**Goal:** Emit structured `ToolingLine` rows (`phase`, `text`, `tool`, `args`) on session `tooling` SSE and in persisted `message.process.lines`, including interim `status` lines before Hermes tool calls.

**Architecture:** Keep Hermes `tool` names as the type key. `process-labeler` becomes fallback text + `pickPresentationArgs()` only. `run-executor` tracks pre-tool vs post-tool `answer_token` routing and in-flight tool count. No new tables.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-21-companion-tooling-lines-design.md`

---

## Client integration summary (for `assistant-companion` agent)

| Topic | Rule |
|-------|------|
| OpenAPI | v2.7.0 — `ToolingLine` with `phase` / `tool` / `args`; **`kind` removed** |
| Session SSE | `GET /events/stream` — `tooling` payloads use new shape |
| Lanes | Unchanged: `tooling`, `reply`, `title` |
| Icons | **Not** in API — iOS maps `tool` + `args` locally |
| Interim | `phase: status` in tooling lane (not reply) |
| Reload | `GET /messages` → `process.lines` same JSON shape |
| Deploy | Ship iOS + backend together for tooling UX |

**iOS agent:** plan at `docs/superpowers/plans/2026-06-21-companion-tooling-lines-ios.md` in `assistant-companion`.

---

## File structure

```
messaging-api/
  src/
    db/repos/process.ts                 — MODIFY: ToolingLine types (rename ProcessLineKind → ToolingPhase)
    services/
      tooling-line.ts                   — CREATE: buildActivityLine, buildStatusLine, pickPresentationArgs
      process-labeler.ts                — MODIFY: fallback text; delegate args to tooling-line
      hermes-client.ts                  — MODIFY: ensure tool events carry name/arguments/label (verify)
      run-executor.ts                   — MODIFY: status routing, structured lines, reply handoff
    streams/
      hub.ts                              — MODIFY: ToolingLine on legacy + session event types
      run-event-publisher.ts              — MODIFY: publish phase/tool/args on tooling events

  test/
    tooling-line.test.ts                — CREATE: args picking + line builders
    process-labeler.test.ts             — MODIFY: expectations if text source changes
    run-executor.test.ts                — MODIFY: structured assertions + status/memory test
    process-repo.test.ts                — MODIFY: ToolingLine persistence shape
    messages.test.ts                    — MODIFY: legacy stream JSON uses phase
    hermes-client.test.ts               — unchanged unless gaps found

docs/superpowers/specs/messaging-api.openapi.yaml  — VERIFY v2.7.0 (already drafted)
README.md                                          — MODIFY: brief v2.7 tooling line note
docs/superpowers/README.md                         — MODIFY: link backend plan
```

---

## Task 1: Verify OpenAPI v2.7.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml` (only if drift found)

- [ ] **Step 1: Confirm version and changelog**

`info.version` is `2.7.0` with tooling-lines changelog pointing at `2026-06-21-companion-tooling-lines-design.md`.

- [ ] **Step 2: Confirm schemas**

- `ToolingLine`: `phase` enum `[reasoning, activity, status]`, required `[phase, text]`, optional `tool`, `args`
- `ProcessLine` aliases `ToolingLine`
- `SseToolingEventLine`: `phase` replaces `kind`; includes `tool`, `args`
- `SseProcessEvent`: allOf `ToolingLine`
- `GET /events/stream` description mentions v2.7 tooling shape

- [ ] **Step 3: Commit (if fixes only)**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs(messaging-api): verify OpenAPI v2.7.0 tooling line contract"
```

---

## Task 2: ToolingLine types

**Files:**
- Modify: `messaging-api/src/db/repos/process.ts`
- Modify: `messaging-api/src/streams/hub.ts`

- [ ] **Step 1: Write failing type usage test**

In `messaging-api/test/tooling-line.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { ToolingLine } from '../src/db/repos/process.js'

describe('ToolingLine', () => {
  it('accepts structured activity line', () => {
    const line: ToolingLine = {
      phase: 'activity',
      text: 'companion-user-location',
      tool: 'skill_view',
      args: { name: 'companion-user-location' },
    }
    expect(line.phase).toBe('activity')
  })
})
```

- [ ] **Step 2: Run test to verify setup**

Run: `cd messaging-api && npm test -- tooling-line.test.ts`
Expected: PASS (type-only) or FAIL if import missing

- [ ] **Step 3: Replace ProcessLine types**

In `process.ts`:

```typescript
export type ToolingPhase = 'reasoning' | 'activity' | 'status'

export interface ToolingLine {
  phase: ToolingPhase
  text: string
  tool?: string | null
  args?: Record<string, unknown> | null
}

/** @deprecated alias — same shape as ToolingLine */
export type ProcessLine = ToolingLine
```

Update `MessageProcess.lines` to `ToolingLine[]`.

In `hub.ts`, replace `ProcessLineKind` / `kind` with `ToolingPhase` / `phase` on legacy and session tooling payloads.

- [ ] **Step 4: Run messaging-api tests**

Run: `cd messaging-api && npm test`
Expected: compile failures in run-executor / publisher — fixed in later tasks

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/repos/process.ts messaging-api/src/streams/hub.ts messaging-api/test/tooling-line.test.ts
git commit -m "refactor(messaging-api): add ToolingLine types for v2.7.0"
```

---

## Task 3: tooling-line builders + presentation args

**Files:**
- Create: `messaging-api/src/services/tooling-line.ts`
- Modify: `messaging-api/src/services/process-labeler.ts`
- Test: `messaging-api/test/tooling-line.test.ts`

- [ ] **Step 1: Write failing tests for pickPresentationArgs**

```typescript
import { buildActivityLine, pickPresentationArgs } from '../src/services/tooling-line.js'

it('picks memory presentation args', () => {
  expect(pickPresentationArgs('memory', { action: 'add', target: 'user', content: 'x' })).toEqual({
    action: 'add',
    target: 'user',
  })
})

it('builds activity line preferring Hermes label', () => {
  expect(
    buildActivityLine({
      tool: 'skill_view',
      label: 'companion-user-location',
      argumentsJson: '{"name":"companion-user-location"}',
    }),
  ).toEqual({
    phase: 'activity',
    text: 'companion-user-location',
    tool: 'skill_view',
    args: { name: 'companion-user-location' },
  })
})

it('builds status line', () => {
  expect(buildStatusLine({ text: 'Updating user preferences…', tool: 'memory' })).toEqual({
    phase: 'status',
    text: 'Updating user preferences…',
    tool: 'memory',
    args: null,
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd messaging-api && npm test -- tooling-line.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement tooling-line.ts**

Responsibilities:

- `parseToolArgs(argumentsJson?: string): Record<string, unknown> | null`
- `pickPresentationArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> | null`
  - Allowlist per tool (`memory`: action/target; `skill_view`: name; `web_search`: query; etc.)
  - Truncate string values > 120 chars
  - Omit `content`, `code`, secrets
- `resolveActivityText(tool, label?, args): string` — label first, else `formatToolProcessLine` fallback
- `buildActivityLine({ tool, label?, argumentsJson? }): ToolingLine`
- `buildStatusLine({ text, tool? }): ToolingLine`
- `buildReasoningLine(text): ToolingLine`

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- tooling-line.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/tooling-line.ts messaging-api/src/services/process-labeler.ts messaging-api/test/tooling-line.test.ts
git commit -m "feat(messaging-api): add ToolingLine builders and presentation args"
```

---

## Task 4: Stream publisher emits structured tooling

**Files:**
- Modify: `messaging-api/src/streams/run-event-publisher.ts`
- Test: `messaging-api/test/run-executor.test.ts` (updated in Task 5)

- [ ] **Step 1: Update publishToolingLine**

Accept `ToolingLine` instead of `{ kind, text }`:

```typescript
export function publishToolingLine(ctx: RunEventContext, line: ToolingLine): void {
  const payload = {
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    phase: line.phase,
    text: line.text,
    ...(line.tool != null ? { tool: line.tool } : {}),
    ...(line.args != null ? { args: line.args } : {}),
  }
  // session + legacy process event
}
```

- [ ] **Step 2: Update publishToolingDraft**

Use `phase: 'reasoning'` instead of `kind: 'reasoning'` on session + legacy `process_token`.

- [ ] **Step 3: Compile check**

Run: `cd messaging-api && npm run build` (or `npx tsc --noEmit` if configured)

- [ ] **Step 4: Commit**

```bash
git add messaging-api/src/streams/run-event-publisher.ts
git commit -m "feat(messaging-api): publish ToolingLine fields on tooling SSE"
```

---

## Task 5: run-executor routing (status + reply handoff)

**Files:**
- Modify: `messaging-api/src/services/run-executor.ts`
- Modify: `messaging-api/test/run-executor.test.ts`
- Modify: `messaging-api/test/helpers/hermes.ts` (optional `pushAnswerTokenBeforeTools` helper comment)

- [ ] **Step 1: Write failing test — status before memory tool**

Add to `run-executor.test.ts`:

```typescript
it('emits status line for pre-tool answer tokens then activity for memory', async () => {
  // seed + subscribe as existing tests
  hermes.pushAnswerToken('Updating user preferences…')
  hermes.pushToolCall('memory', '{"action":"add","target":"user","content":"likes tea"}')
  hermes.pushAnswerToken('Got it.')
  hermes.pushDone()
  // ...
  expect(events).toContainEqual({
    event: 'tooling',
    data: expect.objectContaining({
      phase: 'status',
      text: 'Updating user preferences…',
      tool: 'memory',
    }),
  })
  expect(process?.lines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: 'status', tool: 'memory' }),
      expect.objectContaining({
        phase: 'activity',
        tool: 'memory',
        args: { action: 'add', target: 'user' },
      }),
    ]),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- run-executor.test.ts`
Expected: FAIL — pre-tool token goes to reply lane today

- [ ] **Step 3: Implement run-executor state machine**

Add state:

```typescript
let inReplyPhase = false
let sawFirstTool = false
let outstandingTools = 0
let sawToolingActivity = false
```

**`reasoning` event:** unchanged draft + `buildReasoningLine` on flush.

**`tool` event (start):**

```typescript
sawFirstTool = true
outstandingTools++
const line = buildActivityLine({ tool: event.name, label: event.label, argumentsJson: event.arguments })
publishProcessLine(line)
// Optional: if last line was status with tool null, patch tool to event.name before push (or set on emit)
```

**`tool_complete`:** `outstandingTools = max(0, outstandingTools - 1)` — no SSE line (unchanged v2.2.1).

**`answer_token` event:**

```typescript
if (inReplyPhase) {
  publishReplyToken(...)
  continue
}

if (!sawToolingActivity && !sawFirstTool) {
  // instant reply — no tooling phase
  beginReplyPhase()
  publishReplyToken(...)
  continue
}

if (!sawFirstTool) {
  // pre-tool interim narration
  publishProcessLine(buildStatusLine({ text: event.text, tool: null }))
  continue
}

if (outstandingTools === 0) {
  beginReplyPhase()
  publishReplyToken(...)
  continue
}

// Rare: content during in-flight tools — treat as status
publishProcessLine(buildStatusLine({ text: event.text, tool: null }))
```

**`beginReplyPhase`:** flush reasoning buffer; if `sawToolingActivity`, `publishToolingComplete`; set `inReplyPhase = true`.

**Status/tool correlation (optional v1):** when emitting first `activity` after a `status` with `tool: null`, re-emit is not needed if test expects `tool: 'memory'` on status — set `tool` on `buildStatusLine` when the activity line is built (look back at last status line in `processLines` and patch before publish, or defer correlation to activity emit).

- [ ] **Step 4: Update existing run-executor tests**

Replace `kind: 'reasoning' | 'tool'` expectations with `phase` + `tool` + `args`:

```typescript
expect(process?.lines).toEqual([
  { phase: 'reasoning', text: 'Searching for tools…' },
  {
    phase: 'activity',
    text: 'companion-user-location', // or label from progress
    tool: 'skill_view',
    args: { name: 'demo' },
  },
])
```

- [ ] **Step 5: Run full messaging-api tests**

Run: `cd messaging-api && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/services/run-executor.ts messaging-api/test/run-executor.test.ts
git commit -m "feat(messaging-api): route pre-tool tokens as status ToolingLines"
```

---

## Task 6: Legacy per-conversation stream + messages API

**Files:**
- Modify: `messaging-api/test/messages.test.ts`
- Modify: `messaging-api/test/process-repo.test.ts`
- Modify: `messaging-api/src/db/repos/chat-sync-events.ts` (process line type in comments only if needed)

- [ ] **Step 1: Update messages SSE integration test**

Change expected `process` payload from `{"kind":"reasoning",...}` to `{"phase":"reasoning",...}` and tool lines to `phase: 'activity'` with `tool` / `args`.

- [ ] **Step 2: Update process-repo test fixtures**

Use `ToolingLine` shape in insert/get round-trip.

- [ ] **Step 3: Run tests**

Run: `cd messaging-api && npm test -- messages.test.ts process-repo.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add messaging-api/test/messages.test.ts messaging-api/test/process-repo.test.ts
git commit -m "test(messaging-api): align legacy stream and process repo with ToolingLine"
```

---

## Task 7: hermes-client verification

**Files:**
- Modify: `messaging-api/src/services/hermes-client.ts` (only if gaps)
- Test: `messaging-api/test/hermes-client.test.ts`

- [ ] **Step 1: Confirm tool events retain arguments**

`ToolCallAccumulator` already yields `{ type: 'tool', name, arguments }`.
`HermesToolProgressTracker` yields `{ type: 'tool', name, label }`.

Add test if missing: progress + tool_call both preserve `name` and `label`/`arguments`.

- [ ] **Step 2: Run hermes-client tests**

Run: `cd messaging-api && npm test -- hermes-client.test.ts`
Expected: PASS

- [ ] **Step 3: Commit (if changed)**

```bash
git add messaging-api/src/services/hermes-client.ts messaging-api/test/hermes-client.test.ts
git commit -m "test(messaging-api): verify Hermes tool metadata preserved for ToolingLine"
```

---

## Task 8: Operator docs

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/README.md`

- [ ] **Step 1: README — short v2.7 note**

Under messaging-api / companion streaming section, add:

- Tooling SSE uses `phase` / `tool` / `args` (v2.7.0)
- Link to `docs/superpowers/specs/2026-06-21-companion-tooling-lines-design.md`
- Requires companion app update; deploy together

- [ ] **Step 2: superpowers README — link plan**

Add backend plan path under tooling lines active work.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/README.md
git commit -m "docs: note messaging-api v2.7.0 structured tooling lines"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: Full test suite**

Run: `cd messaging-api && npm test`
Expected: all pass

- [ ] **Step 2: Manual Hermes smoke (optional)**

With stack up, send companion message that triggers `skill_view` and one that triggers `memory`. Inspect session SSE JSON for `phase` / `tool` / `args`.

- [ ] **Step 3: OpenAPI diff review**

Confirm no `kind` left on `SseToolingEventLine` required fields.

---

## Verification checklist (from spec)

- [ ] “Remember this” → `status` (+ `tool: memory` when correlated) → `activity` memory with `args.target` → `reply`
- [ ] Skill load → `activity` `skill_view` + `args.name`
- [ ] Instant reply → `reply` only, no tooling
- [ ] Reload → `GET /messages` `process.lines` matches live stream shape
- [ ] v2.6 iOS on v2.7 server breaks on missing `kind` (expected — coordinate deploy)

---

## Out of scope

- iOS implementation
- Icons / `toolset` in API
- `hermes.interim` upstream event
- MCP contract changes