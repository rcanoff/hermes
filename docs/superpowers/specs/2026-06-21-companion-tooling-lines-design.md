# Companion Tooling Lines — Backend Design Spec

**Date:** 2026-06-21  
**Status:** Approved  
**API version:** v2.7.0 (OpenAPI)  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml`  
**iOS reference:** `docs/superpowers/specs/2026-06-21-companion-tooling-lines-ios-design.md`  
**Supersedes (process line shape):** `docs/history/implemented/specs/2026-06-13-assistant-process-stream-design.md` (line schema only; lanes unchanged)

---

## Goal

Expose structured tooling events to the companion app so iOS can style “what happened” lines (skills, web search, commands, memory, interim narration) using **Hermes-native identifiers**, not API-invented category enums or icon fields.

Two UX lanes stay unchanged: **tooling** (everything that happened) and **reply** (final answer), plus **title**.

---

## Decisions

| Topic | Choice |
|-------|--------|
| Top-level lanes | `tooling`, `reply`, `title` — unchanged |
| Line schema | `phase` + `text` + optional `tool` + optional `args` |
| Tool identity | Pass through Hermes `tool` name from `hermes.tool.progress` / tool-call wire |
| Display text | Prefer Hermes `label` (`build_tool_preview`); `process-labeler` is fallback only |
| Structured args | Pass subset of Hermes tool `arguments` JSON (never re-parse friendly `text`) |
| Interim narration | `phase: status`; correlate `tool` from next Hermes tool in the same turn when possible |
| Icons | **Not** in API — iOS maps `phase` / `tool` / `args` to SF Symbols locally |
| API categories | **No** `loading_skill` / `searching_web` enums — clients group on `tool` + `args` |
| Persistence | Same `message_process` table; `lines_json` stores new shape |
| Legacy `kind` | Removed from v2.7.0 responses (`reasoning` \| `tool` flat enum) |
| Hermes upstream | Optional future `hermes.interim` / `toolset` on progress events — not required for v2.7.0 |

---

## `ToolingLine` schema

```yaml
phase: reasoning | activity | status   # required
text: string                            # required — display copy
tool: string | null                     # Hermes tool id when known
args: object | null                     # optional argument subset
```

### `phase` semantics

| `phase` | Meaning | Typical source |
|---------|---------|----------------|
| `reasoning` | Model thinking / reasoning summary | Hermes `reasoning_content` deltas |
| `activity` | Tool execution started | `hermes.tool.progress` `status: running` + tool-call arguments |
| `status` | Interim assistant narration (“Updating your preferences…”) | Pre-tool `delta.content` before first tool in the turn; `tool` filled when correlated |

All three phases render in the **same tooling block** on iOS. Only the final answer uses the `reply` lane.

### `tool` values (examples — not exhaustive)

Hermes tool names are the source of truth. Examples the companion will see often:

| `tool` | Typical `args` keys |
|--------|---------------------|
| `skill_view` | `name` |
| `skills_list` | `category` |
| `skill_manage` | `action`, `name` |
| `memory` | `action`, `target` (`user` \| `memory`) |
| `web_search` | `query` |
| `tool_search` | `query` |
| `terminal`, `execute_code` | `command` or `code` (truncated server-side if huge) |
| `read_file` | `path` |
| `delegate_task` | `goal` |
| `mcp_*` | tool-specific — pass through parsed object as-is |

### `text` rules

1. If Hermes progress provides `label`, use it as `text` (may include emoji in string — iOS may strip for display).
2. Else if `tool` + `args` are known, format minimally server-side (existing `process-labeler` fallback).
3. Else `text` is a short humanized tool name.

Do **not** use `text` as the type key for iOS grouping.

### `args` rules

- Parse Hermes tool-call `arguments` JSON when complete.
- Emit only **presentation-safe** keys (strings, small scalars). Omit secrets and large blobs.
- Truncate long string values (e.g. 120 chars) in persisted lines.
- For `status` lines emitted before args are known: `args` may be `null` until correlation; optional patch not required for v1 — set `tool` when the next `activity` line shares the same narration beat.

---

## Hermes wire mapping

### Already available (v2.7.0 uses these)

**`event: hermes.tool.progress`** (running):

```json
{
  "tool": "skill_view",
  "label": "companion-user-location",
  "toolCallId": "call_1",
  "status": "running",
  "emoji": "📚"
}
```

→ `phase: activity`, `tool: skill_view`, `text: label or formatted`, `args: { name }` from arguments when present.

**Tool-call deltas** (when progress event missing): `function.name` + accumulated `arguments`.

**Reasoning deltas**: `reasoning_content` → `tooling` draft / committed `phase: reasoning`.

### Not on the wire today

| Telegram feature | API server today | v2.7.0 approach |
|------------------|------------------|-----------------|
| `interim_assistant_callback` | Not wired | Buffer pre-tool content tokens → `phase: status`; set `tool` from next running tool |
| `toolset` from registry | Not in SSE | Optional Hermes upstream later; clients use `tool` for now |

### Optional upstream (out of scope v2.7.0)

- `event: hermes.interim` with `{ text, tools: ["memory"] }`
- `toolset` field on `hermes.tool.progress`

---

## Stream contract

### Session SSE `GET /events/stream` (primary)

Unchanged event names. **`tooling` payload shape changes** (v2.7.0).

**Committed line:**

```json
{
  "conversationId": "…",
  "runId": "…",
  "phase": "activity",
  "text": "companion-user-location",
  "tool": "skill_view",
  "args": { "name": "companion-user-location" }
}
```

**Reasoning draft** (unchanged pattern, `phase` replaces `kind`):

```json
{
  "conversationId": "…",
  "runId": "…",
  "phase": "reasoning",
  "text": "Checking…",
  "draft": true
}
```

**Status (interim):**

```json
{
  "conversationId": "…",
  "runId": "…",
  "phase": "status",
  "text": "Updating user preferences…",
  "tool": "memory",
  "args": null
}
```

**Phase complete** (unchanged):

```json
{ "conversationId": "…", "runId": "…", "phase": "complete" }
```

### Legacy per-conversation stream `GET /conversations/{id}/stream`

Deprecated but updated to the same `ToolingLine` shape on `process` events for clients still on the old route.

| Old field | v2.7.0 |
|-----------|--------|
| `kind: reasoning` | `phase: reasoning` |
| `kind: tool` | `phase: activity` or `status` (split by origin) |

---

## `run-executor` behavior

### Phase detection (reply handoff)

Stay in tooling phase until the first **post-tooling** reply token:

1. `reasoning` / `activity` / `status` lines accumulate in `processLines[]`.
2. Pre-tool `answer_token` from Hermes → emit `status` lines (not `reply`).
3. On first `answer_token` after tooling phase ends (no pending tools / after `tool_complete` reconciliation) → emit `tooling { phase: complete }`, then `reply` tokens.

**Instant reply** (no tooling): skip `tooling` entirely; stream `reply` immediately (unchanged).

### Status correlation heuristic

When buffering pre-tool content:

1. Emit `tooling { phase: status, text, tool: null, args: null }`.
2. On next `activity` line for tool `T` in the same run, if the status line immediately precedes it, **optionally** rewrite persisted line to `tool: T` before commit, or emit a correlated pair — implementation may keep `tool: null` on status lines if rewrite is awkward; iOS still renders `status` with generic styling.

Prefer setting `tool` on status when the next event is known before SSE emit.

### `hermes-client` changes

- Preserve `name`, `arguments`, `label` on tool events.
- Do not collapse to friendly string only.

### `process-labeler` changes

- Fallback formatter when `label` missing.
- Export arg extraction helpers (e.g. `pickPresentationArgs(tool, args)`).

---

## Persistence

`message_process.lines_json` stores `ToolingLine[]`.

`GET /conversations/{id}/messages` — assistant `process.lines` uses the same schema.

Failed runs: no `message_process` row (unchanged).

---

## Client impact

| Area | v2.6 app on v2.7 server |
|------|-------------------------|
| Session `tooling` events | **Breaks** if app requires `kind` — needs iOS update |
| `GET /messages` `process.lines` | **Breaks** same way |
| Unknown fields | N/A — `kind` removed |

Backend and iOS should deploy together for tooling UX. Other API surfaces unchanged.

---

## Implementation checklist (backend)

- [ ] OpenAPI v2.7.0 (`ToolingLine`, SSE schemas, changelog)
- [ ] `hermes-client.ts` — pass `arguments` through on tool events
- [ ] `run-executor.ts` — status buffering, structured lines, phase handoff
- [ ] `process-labeler.ts` — fallback + arg picking
- [ ] `run-event-publisher.ts` / `hub.ts` — types use `phase`, `tool`, `args`
- [ ] Tests: memory+status turn, skill_view activity, instant reply, persisted `process.lines`
- [ ] iOS reference spec (this repo)

---

## Verification

1. “Remember this” → `status` (optional `tool: memory`) → `activity` `memory` with `args.target` → `reply`.
2. Skill load → `activity` `skill_view` with `args.name`.
3. Web search → `activity` `web_search` with `args.query`.
4. Instant chat → no `tooling`; `reply` only.
5. Reload thread → `process.lines` matches live stream shape.

---

## Out of scope

- Icons / `toolset` in API
- `hermes.interim` upstream (documented as future)
- iOS SwiftUI implementation (see iOS spec)
- MCP tool payload changes