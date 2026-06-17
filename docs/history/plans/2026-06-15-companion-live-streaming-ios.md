# Companion Live Streaming — iOS Plan
**Date:** 2026-06-15  
**Status:** Planned  
**Backend:** messaging-api OpenAPI v1.8.0  
**Companion repo:** `assistant-companion` (not in this workspace)

---

## Context

Users expect two live lanes while a message is in flight:

1. **Process block** — reasoning and tool activity as Hermes works
2. **Reply bubble** — assistant answer token-by-token

Backend v1.8.0 adds incremental reasoning (`process_token`) and tool completion lines (`Done: …`). Hermes operator config now has `display.show_reasoning: true`.

Deploying backend-only is safe (additive events). Rich live UX requires a companion app update.

---

## SSE contract (v1.8.0)

| Event | Payload | Client action |
|-------|---------|---------------|
| `process_token` | `{ kind: "reasoning", text: string }` | Append `text` to the in-flight reasoning line inside the process block |
| `process` | `{ kind: "reasoning" \| "tool", text: string }` | Append a **new line** to the process block. Reasoning `process` replaces the in-flight reasoning line with the finalized text |
| `process_complete` | `{}` | Collapse or hide the process block; start/show the reply bubble |
| `token` | `{ text: string }` | Append to the streaming assistant reply bubble |
| `title` | `{ title: string }` | Update conversation title (unchanged) |
| `rewind` | `{ removedMessageIds: string[] }` | Remove messages from local state (unchanged) |
| `done` | `{ messageId: string }` | Commit reply bubble to messages list; clear streaming buffers |
| `error` | `{ code: string }` | Show failure; clear streaming state |

### Ordering rules

- `process_token` events may arrive many times before the matching `process` reasoning line
- Tool runs: `process` (start label) → … silence during execution … → `process` (`Done: …`) → eventually `process_complete` → `token`…
- Instant replies: skip process events; `token` streams immediately

---

## UI state model

Add to `ChatViewModel` (or equivalent):

```swift
@Published var processLines: [ProcessLine] = []      // committed lines
@Published var reasoningDraft: String = ""           // in-flight reasoning from process_token
@Published var streamingReply: String = ""           // in-flight assistant reply
@Published var isProcessPhaseActive: Bool = false
@Published var isReplyPhaseActive: Bool = false
```

`ProcessLine`:

```swift
struct ProcessLine: Identifiable, Equatable {
    let id = UUID()
    let kind: String   // "reasoning" | "tool"
    let text: String
}
```

---

## Event handler (`handleSSEEvent`)

```swift
func handleSSEEvent(_ event: String, data: Data) {
    switch event {
    case "process_token":
        let payload = decode(SseProcessTokenEvent.self, data)
        guard payload.kind == "reasoning" else { return }
        if !isProcessPhaseActive {
            isProcessPhaseActive = true
            processLines = []
            reasoningDraft = ""
        }
        reasoningDraft += payload.text

    case "process":
        let payload = decode(SseProcessEvent.self, data)
        if !isProcessPhaseActive {
            isProcessPhaseActive = true
            processLines = []
            reasoningDraft = ""
        }
        if payload.kind == "reasoning" {
            reasoningDraft = ""
        }
        processLines.append(ProcessLine(kind: payload.kind, text: payload.text))

    case "process_complete":
        if !reasoningDraft.isEmpty {
            processLines.append(ProcessLine(kind: "reasoning", text: reasoningDraft))
            reasoningDraft = ""
        }
        isProcessPhaseActive = false
        isReplyPhaseActive = true
        streamingReply = ""

    case "token":
        if !isReplyPhaseActive {
            isReplyPhaseActive = true
            streamingReply = ""
        }
        let payload = decode(SseTokenEvent.self, data)
        streamingReply += payload.text

    case "done":
        commitStreamingReply(messageId: decode(SseDoneEvent.self, data).messageId)
        resetStreamingState()

    // title, rewind, error: existing handlers

    default:
        break
    }
}
```

### Display

- **Process block:** render `processLines` plus optional trailing `reasoningDraft` (muted style) while `isProcessPhaseActive`
- **Reply bubble:** render `streamingReply` while `isReplyPhaseActive` and before `done`
- On reload, use optional `process.lines` from `GET /messages` (collapsed by default — unchanged)

---

## Stream connection timing

Keep opening `GET /conversations/:id/stream` immediately after `POST /messages` (or in parallel). The backend attaches to the active run; opening early avoids missing `process_token` events.

Do **not** wait for `POST` to finish before opening the stream if the UI already supports parallel requests.

---

## Testing checklist (companion)

| Scenario | Expected UI |
|----------|-------------|
| Plain chat ("essay about Lisbon") | Reply bubble grows token-by-token; no process block |
| Tool query (web search, calculator) | Tool start line appears early; `Done:` line after tool finishes; reply streams after `process_complete` |
| Long reasoning (`show_reasoning: true`) | Reasoning text grows live via `process_token`; finalized line on `process` |
| Message edit rerun | `rewind` removes old messages; process + reply sequence repeats |
| Client disconnect mid-run | On reconnect to history, completed message includes `process` blob |

---

## Rollout

1. Ship messaging-api v1.8.0 + Hermes `show_reasoning: true` (backend repo — this change set)
2. Update companion app SSE handler + process UI
3. Verify on device with a tool-heavy prompt and a plain prompt

Backward compatibility: ignoring unknown events (`process_token`) leaves old behavior (batch on `done`). The live UX fix requires the app update above.