# Companion App Skills & Bootstrap — iOS Plan

**Date:** 2026-06-17  
**Status:** Planned  
**Backend:** messaging-api OpenAPI v1.9.0  
**Companion repo:** `assistant-companion` (not in this workspace)  
**Design spec:** `docs/superpowers/specs/2026-06-17-companion-app-skills-design.md`

---

## Context

Skill routing moves from hardcoded `messaging-api` system prompts to iOS-authored bootstrap text. The app sends `bootstrap` once per new conversation; the API stores and forwards it to Hermes on every turn without exposing it in chat history.

Hermes loads `companion-app` (index) → `companion-replies` / block skills / data skills per intent.

---

## Canonical bootstrap constant

Add a versioned constant (e.g. `CompanionBootstrap.prompt(username:)`):

```swift
static func prompt(username: String) -> String {
    """
    You are replying on the Companion App (assistant-companion iOS), not a generic API client.
    Before composing your reply, you MUST call skill_view(name='companion-app') and follow it.
    The authenticated companion user for this conversation is "\(username)".
    """
}
```

Bump app version note in comment when block capabilities change.

---

## Send bootstrap on first message

In the message-send path (`ChatViewModel` or API client):

```swift
var body: [String: String] = ["text": userText]
if isFirstMessageInConversation {
    body["bootstrap"] = CompanionBootstrap.prompt(username: session.username)
}
```

`isFirstMessageInConversation` — true when local message list is empty before this send (same moment title generation triggers).

**Do not:**
- Show bootstrap in UI
- Send `bootstrap` on edit/resend
- Send `bootstrap` on second+ messages

---

## API client changes

Extend `CreateMessageRequest` encoding with optional `bootstrap: String?`.

No changes to message list decoding — bootstrap is never returned.

---

## Existing conversations

Conversations created before v1.9.0 have no stored bootstrap. No client backfill required. Skill routing on old threads may be degraded until the user starts a new conversation on updated iOS.

---

## Verification

1. New chat — first POST includes `bootstrap`; Hermes process shows `Loading skill: companion-app`
2. Second message — POST has no `bootstrap` field
3. Message history UI — only user/assistant text visible
4. Location reply — map block renders per `companion-map-preview` (no regression)

---

## Deploy order

1. Deploy backend v1.9.0 (accepts `bootstrap`; stops hardcoding skill prompt)
2. Ship iOS update that sends bootstrap on first message

Brief overlap window: old iOS + new API = username-only system line (degraded). Acceptable.