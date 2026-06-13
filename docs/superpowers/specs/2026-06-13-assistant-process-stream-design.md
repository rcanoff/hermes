# Assistant Process Stream — Design Spec
**Date:** 2026-06-13  
**Status:** Approved  
**Companion spec:** `2026-06-12-hermes-messaging-api-design.md`  
**API contract:** `messaging-api.openapi.yaml` (same directory)

---

## Goal

Expose Hermes reasoning summaries and tool activity to the companion app in a two-phase stream: one collapsible process block while Hermes works, then a separate assistant reply. Process data is persisted outside the transcript so it never affects Hermes context.

---

## Decisions

| Topic | Choice |
|-------|--------|
| Content | Reasoning summaries + tool activity (Telegram-like) |
| Live UX | One process bubble; lines append inside it (granular SSE) |
| Handoff | `process_complete` → FE collapses/hides process → `token` stream for reply |
| Persistence | Separate `message_process` table; one blob per assistant turn |
| Reload | Optional `process` field on assistant messages in `GET /messages`; FE defaults collapsed |
| Tool lines | Backend-friendly labels (not raw tool names) |
| Hermes integration | Extend `hermes-client` OpenAI-wire parsing (approach A) |
| SSE `tool` event | Replaced by `process` kind=`tool` in v1.4.0 |

---

## Client impact

**Will this break the existing iOS app? No.**

| Area | Impact |
|------|--------|
| `POST /messages`, `GET /messages` | Assistant messages may include optional `process` — additive |
| SSE stream | New `process` and `process_complete` events; `tool` removed |
| Unknown events | Current app ignores unknown SSE events |
| Process UX | Requires app update to show collapse/handoff behavior |

Backend-only deploy is safe. Rich process UI requires a companion app update.

---

## Stream contract (SSE)

OpenAPI **v1.4.0** events for `GET /conversations/:id/stream`:

```
event: process
data: {"kind":"reasoning","text":"Searching for tools…"}

event: process
data: {"kind":"tool","text":"Loading skill: roberto-location-source"}

event: process_complete
data: {}

event: token
data: {"text":"You're in…"}

event: done
data: {"messageId":"…"}
```

### Rules

1. **Process phase** — all reasoning and tool activity emits `process` events only.
2. **Accumulation** — `run-executor` keeps `processLines[]` in memory for the run.
3. **Handoff** — on the first final-answer content token from Hermes, emit `process_complete`, then forward `token` events.
4. **Instant reply** — if Hermes emits no process activity, skip `process` and `process_complete`; stream `token` immediately.
5. **Persistence** — on successful `done`, save non-empty `processLines` to `message_process` in the same transaction as the assistant message.
6. **Failure** — on `error`, do not persist process or assistant message.

### FE contract (companion app)

1. First `process` → show one system/process bubble; append each line.
2. `process_complete` → collapse or hide the process bubble.
3. `token` → show a separate assistant reply bubble.
4. On reload → render optional `process.lines` collapsed under the assistant message.

---

## Persistence

### New table: `message_process`

```sql
CREATE TABLE message_process (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (conversation_id, assistant_message_id)
    REFERENCES messages(conversation_id, id) ON DELETE CASCADE
);
```

- `lines_json`: JSON array of `{ "kind": "reasoning" | "tool", "text": string }`
- One row per assistant message (not a list of system messages in the transcript)
- Never loaded into `buildHermesMessages()` — context isolation unchanged

### `GET /conversations/:id/messages`

Assistant messages gain an optional `process` field:

```json
{
  "id": "…",
  "role": "assistant",
  "content": "You're in Porto…",
  "created_at": "…",
  "process": {
    "lines": [
      { "kind": "reasoning", "text": "Searching for tools…" },
      { "kind": "tool", "text": "Loading skill: roberto-location-source" }
    ]
  }
}
```

Omitted when the turn had no process activity.

### Lifecycle

| Event | Process handling |
|-------|------------------|
| Successful run | Insert `message_process` with accumulated lines |
| Failed run | No row |
| Message edit | Cascade delete with removed assistant message |
| Conversation delete | Cascade via `messages` FK |
| Server restart mid-run | Run → `failed`; no persisted process |

---

## Hermes parsing

### Internal events (`hermes-client`)

| Event | Source | Notes |
|-------|--------|-------|
| `reasoning` | Reasoning/summary deltas from stream | Emit `process` when a summary segment completes |
| `tool` | `tool_calls[].function` name + accumulated `arguments` | Format via `process-labeler` before SSE |
| `answer_token` | Final-answer `content` text | Triggers handoff |
| `done` | `[DONE]` | Unchanged |

### Phase detection

Stay in process phase until the first `answer_token`. Multi-round agent loops (reasoning → tools → more reasoning → tools → answer) all accumulate in one process block.

### Operator config

Session dumps show reasoning summaries exist internally. If the live `/v1/chat/completions` stream does not emit reasoning deltas, enable `show_reasoning: true` in `data/config.yaml` and document in `README.md`. v1 ships with tool-only process lines if reasoning is unavailable after spike.

### Spike (first implementation task)

Capture one real Hermes SSE response from the running deployment and confirm delta field names before finalizing parser branches.

---

## Friendly labels (`process-labeler.ts`)

Backend formats readable `text` for `kind: "tool"` lines.

| Tool pattern | Label |
|--------------|-------|
| `skill_view` | `Loading skill: {name}` |
| `tool_search` | `Searching tools: {query}` |
| `mcp_ha_ha_get_state`, `ha_get_state` | `Getting Home Assistant state` (+ entity if parseable) |
| `mcp_ha_ha_search_entities` | `Searching Home Assistant` |
| `read_file` | `Reading file: {path}` |
| `web_search` | `Searching the web: {query}` |
| `terminal`, `execute_code` | `Running command` |
| `delegate_task` | `Delegating task` |
| *default* | `Running {humanized_name}` |

If JSON args are incomplete, fall back to the default template.

---

## Architecture

### New units

- `src/services/process-labeler.ts` — tool name + args → friendly string
- `src/db/repos/process.ts` — insert/load process by assistant message id

### Changed units

- `src/db/schema.ts` — `message_process` table
- `src/services/hermes-client.ts` — reasoning/tool/answer_token parsing
- `src/services/run-executor.ts` — accumulate, `process_complete` handoff, persist
- `src/db/repos/messages.ts` or list handler — join `process` onto assistant rows
- `src/streams/hub.ts` — `process`, `process_complete` in `StreamEvent`; remove `tool`
- `src/routes/messages.ts` — history response shape
- `docs/superpowers/specs/messaging-api.openapi.yaml` — v1.4.0

### Out of scope (this spec)

- iOS SwiftUI implementation (companion spec addendum later)
- Persisting raw tool outputs or encrypted reasoning blobs
- Replaying process SSE to late stream subscribers (reload uses full blob)

---

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Instant reply | No `process` events; tokens only; no `process` on reload |
| Client disconnect | Backend continues; persist on `done` |
| Late stream attach | Remaining events only; no replay of earlier process lines |
| Parallel tool calls | One label per tool, stream order |
| Empty reasoning segment | Skip (no zero-length lines) |
| Parser gets name, no args | Default friendly fallback |

---

## Testing

**Unit**

- `process-labeler` templates and malformed JSON fallbacks
- `hermes-client` fixtures: reasoning, tool deltas, answer handoff ordering
- `run-executor`: `process_complete` before first `token`, persist on `done`

**Integration**

- SSE sequence: `process` × N → `process_complete` → `token` → `done`
- `GET /messages` includes `process.lines` on assistant message
- Message edit removes old process; new run produces fresh process
- Instant-reply turn omits `process`
- Conversation delete cascades process rows

**Manual**

- One tool-heavy Hermes turn on Pi deployment
- Confirm reasoning lines after `show_reasoning` if needed

---

## OpenAPI

Bump to **v1.4.0**:

- Add `ProcessLine`, `MessageProcess`, `SseProcessEvent`, `SseProcessCompleteEvent`
- Extend `Message` with optional `process`
- SSE: add `process`, `process_complete`; remove `tool`
- Document two-phase stream ordering in `/stream` description