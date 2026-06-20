# Companion Tooling Lines — iOS Client Design Spec (Reference)

**Date:** 2026-06-21  
**Status:** Approved (reference)  
**API version:** v2.7.0  
**Repo:** `assistant-companion` (not this workspace)  
**Backend spec:** `docs/superpowers/specs/2026-06-21-companion-tooling-lines-design.md`  
**OpenAPI:** `hermes/docs/superpowers/specs/messaging-api.openapi.yaml` v2.7.0

---

## Instructions for the iOS agent

**Write your own implementation plan** — do not implement in `hermes`.

| Item | Location |
|------|----------|
| iOS plan (you create) | `docs/superpowers/plans/2026-06-21-companion-tooling-lines-ios.md` in `assistant-companion` |
| OpenAPI (source of truth) | `hermes/docs/superpowers/specs/messaging-api.openapi.yaml` v2.7.0 |
| Backend behavior | `hermes/docs/superpowers/specs/2026-06-21-companion-tooling-lines-design.md` |

Deploy against messaging-api **v2.7.0+**. v2.6 clients expect `kind` on tooling lines; v2.7 removes it in favor of `phase` / `tool` / `args`.

---

## What the backend changed (v2.7.0)

### Before (v2.6)

Tooling lines were flat:

```json
{ "kind": "reasoning" | "tool", "text": "Loading skill: companion-user-location" }
```

iOS could only distinguish reasoning vs everything else. Tool type was embedded in English `text`.

### After (v2.7)

Structured **Hermes-native** lines:

```json
{
  "phase": "reasoning" | "activity" | "status",
  "text": "companion-user-location",
  "tool": "skill_view",
  "args": { "name": "companion-user-location" }
}
```

| Field | Role |
|-------|------|
| `phase` | Which tooling bucket (thinking / tool run / interim narration) |
| `text` | Display string (prefer showing this in the process UI) |
| `tool` | Hermes tool id — **primary key for client presentation grouping** |
| `args` | Optional structured context from Hermes arguments |

**No icon field.** Map `tool` + `phase` + `args` to SF Symbols locally.

### Lanes (unchanged)

| Lane | SSE `event` | Purpose |
|------|-------------|---------|
| Tooling | `tooling` | All `ToolingLine` phases + `phase: complete` |
| Reply | `reply` | Final assistant answer tokens + `phase: done` |
| Title | `title` | Auto-generated conversation title |

Session stream: `GET /events/stream` (persistent, JWT `jti`).

### New: interim narration on tooling lane

Telegram-style status messages (“Updating user preferences…”) appear as:

```json
{ "phase": "status", "text": "…", "tool": "memory", "args": null }
```

Same process block as tools and reasoning — **not** a separate bubble, **not** reply lane.

---

## Models to implement

### `ToolingLine` (replace / supersede `ProcessLine`)

```swift
enum ToolingPhase: String, Codable {
    case reasoning
    case activity
    case status
}

struct ToolingLine: Codable, Equatable, Identifiable {
    let id: UUID                    // client-generated for SwiftUI
    let phase: ToolingPhase
    let text: String
    let tool: String?               // Hermes tool name; nil when unknown
    let args: [String: JSONValue]?  // or typed subset per tool
}
```

`Message.process.lines` decodes as `[ToolingLine]` (same JSON array in API).

### SSE decoding — session `tooling` event

**Committed line:**

```swift
struct SseToolingLine: Decodable {
    let conversationId: UUID
    let runId: UUID
    let phase: ToolingPhase
    let text: String
    let tool: String?
    let args: [String: JSONValue]?
}
```

**Reasoning draft** (unchanged behavior, new field name):

```swift
struct SseToolingDraft: Decodable {
    let conversationId: UUID
    let runId: UUID
    let phase: ToolingPhase   // always "reasoning"
    let text: String
    let draft: Bool           // true
}
```

**Phase complete** — unchanged: `{ phase: "complete" }` at tooling level (string `"complete"`, not `ToolingPhase`).

Use a small enum wrapper or separate decoders for tooling payload variants (line vs draft vs complete).

---

## Event handler updates (`StreamService` / `ChatViewModel`)

Replace `kind`-based handling with `phase`:

| Event | Action |
|-------|--------|
| `tooling` + `draft: true` | Append to `reasoningDraft`; `isToolingPhaseActive = true` |
| `tooling` committed line | Append `ToolingLine` to `toolingLines`; clear draft if `phase == reasoning` |
| `tooling` + `phase: complete` | Flush draft; end tooling phase; start reply phase |
| `reply` + `text` | Append to streaming reply |
| `reply` + `phase: done` | Commit message (persist `toolingLines` into `message.process`) |

**Instant reply:** first event is `reply` with no prior `tooling` — skip process block (unchanged).

**Do not** route `phase: status` or `activity` to the reply bubble.

---

## Presentation grouping (client-side only)

The API does **not** send categories like `loading_skill`. Derive a **local** presentation bucket from Hermes `tool` + `args` + `phase` for styling (icon, tint, optional subtitle). Example mapping:

| Condition | Suggested bucket | SF Symbol (example) |
|-----------|------------------|---------------------|
| `phase == reasoning` | thinking | `brain` |
| `phase == status` + `tool == memory` | user preference update | `person.crop.circle` |
| `phase == status` + `tool == skill_manage` | skill update | `square.and.pencil` |
| `phase == status` + `tool == nil` | generic status | `ellipsis.message` |
| `tool == skill_view` | loading skill | `book` |
| `tool == skills_list` | listing skills | `books.vertical` |
| `tool == skill_manage` | managing skill | `square.and.pencil` |
| `tool == memory` + `args.target == user` | user profile memory | `person.crop.circle` |
| `tool == memory` + `args.target == memory` | agent memory | `brain.head.profile` |
| `tool == web_search` | web search | `globe` |
| `tool == tool_search` | tool search | `magnifyingglass` |
| `tool == terminal` or `execute_code` | command | `terminal` |
| `tool == read_file` | read file | `doc.text` |
| `tool == delegate_task` | delegation | `person.2` |
| `tool?.hasPrefix("mcp_")` | integration | `puzzlepiece.extension` |
| default `activity` | generic tool | `gearshape` |

Show **`text`** as the primary line label in the process block. Use bucket only for icon/accent; do not re-parse English `text` for typing.

### `ProcessBubble` / collapsed history

- Live: one tooling block listing lines in order (reasoning, status, activity interleaved as received).
- Collapsed: keep “Worked in background” or similar; expanded history uses same `ToolingLine` renderer.
- On reload: `GET /messages` → `message.process?.lines` decodes as `[ToolingLine]`.

---

## Migration from v2.6

If you must tolerate old servers during development:

```swift
// Temporary shim — remove after backend v2.7 deploy
if let kind = legacyKind {
    phase = kind == "reasoning" ? .reasoning : .activity
}
```

Production target: **v2.7 only** — no `kind` in API responses.

---

## iOS plan must include

- [ ] `ToolingLine` model + `Message.process` decode update
- [ ] Session SSE `tooling` decoder (`phase`, `tool`, `args`, `draft`, `complete`)
- [ ] ViewModel state: `toolingLines`, `reasoningDraft`, phase flags
- [ ] `PresentationBucket` (or similar) mapping `tool`/`args`/`phase` → SF Symbol
- [ ] `ProcessBubble` line renderer using bucket + `text`
- [ ] Historical `DisclosureGroup` process section on assistant messages
- [ ] Tests: decode fixtures from backend spec examples
- [ ] Manual scenarios (checklist below)

### Out of scope (iOS v1)

- Implementing messaging-api backend
- Requesting icons from API
- Showing tool progress “Done:” lines (backend stopped emitting these in v2.2.1)

---

## Verification checklist

1. **Remember preference** — tooling shows `status` then `activity` (`memory`, `target: user`); reply is separate confirmation.
2. **Skill question** — `activity` with `tool: skill_view` and skill name in `args` / `text`.
3. **Web search turn** — `activity` `web_search` with `args.query`.
4. **Instant reply** — no tooling block; reply streams immediately.
5. **Reload chat** — collapsed process on assistant message matches live stream lines.
6. **Message edit rerun** — `rewind` then fresh tooling sequence with new `runId`.

---

## Example sequences

### Memory / “remember this”

```
tooling → { phase: "status", text: "Updating user preferences…", tool: "memory" }
tooling → { phase: "activity", tool: "memory", text: "+user: \"…\"", args: { action: "add", target: "user" } }
tooling → { phase: "complete" }
reply   → { text: "Got it — I'll remember that." }
reply   → { phase: "done", messageId: "…" }
```

### Skill load

```
tooling → { phase: "activity", tool: "skill_view", text: "companion-user-location", args: { name: "companion-user-location" } }
tooling → { phase: "complete" }
reply   → …
```