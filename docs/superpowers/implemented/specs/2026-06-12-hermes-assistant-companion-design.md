# Hermes Mobile Channel — iOS App Spec (`assistant-companion`)
**Date:** 2026-06-12  
**Status:** Implemented  
**Companion spec:** `2026-06-12-hermes-messaging-api-design.md`

---

## Goal

A native SwiftUI iOS app that serves as a dedicated Hermes client. Replaces Telegram as the primary Hermes interface. Provides a modern chat experience with optional location sharing. The app talks only to `messaging-api` — it has no knowledge of Hermes directly.

---

## Out of Scope (MVP)

- File and image uploads
- Push notifications
- Maps or navigation
- Voice chat
- Multi-device sync

---

## Technology

- SwiftUI + Swift Concurrency (`async`/`await`)
- `URLSession` for HTTP and SSE streaming
- `CoreLocation` for device location
- Keychain for JWT token storage

---

## Screen Flow

```
LoginView
    └─ ConversationListView
            └─ ChatView
                    ├─ MessageList (bubbles + streaming assistant response)
                    └─ MessageComposer (text input + location control + send button)
```

---

## State Management

- `AuthViewModel` — login state, token, logout
- `ConversationListViewModel` — fetch and create conversations
- `ChatViewModel` — messages, send, stream, location mode

---

## Authentication

- `LoginView` accepts username + password
- On success, JWT token stored in Keychain via `KeychainService` wrapper
- On app launch, token is read from Keychain — if valid, skip login and go directly to `ConversationListView`
- On logout, token is cleared from Keychain and session is invalidated via `POST /auth/logout`

---

## Conversations

- `ConversationListView` loads all conversations for the current user from `GET /conversations`
- Tapping a conversation opens `ChatView` and loads history from `GET /conversations/:id/messages`
- A "New conversation" button calls `POST /conversations`

---

## Messaging

- User types in `MessageComposer` and taps send
- App calls `POST /conversations/:id/messages`
- App opens `GET /conversations/:id/stream` to receive the SSE response
- `ChatView` holds `@State var streamingMessage: String` that appends tokens as they arrive
- On `done` event, the streaming message is committed to the local messages array and the buffer is cleared
- Assistant messages display as streaming bubbles in real time

---

## SSE Streaming

Consumed via `URLSession.bytes(for:)` — an async byte stream. Events:

```
event: token   → append data.text to streamingMessage
event: tool    → optionally show a subtle "thinking" indicator
event: done    → commit streamingMessage to messages, clear buffer
```

---

## Location Sharing

### Modes

| Mode | Behavior |
|------|----------|
| Off | No location data sent |
| Once | Location sent before next message, then resets to Off |
| Live | Continuous updates while conversation is open |

### Once Mode Flow

1. User sets mode to Once in `MessageComposer` toolbar
2. User taps send
3. App requests current position from `CoreLocation`
4. App calls `POST /conversations/:id/location` with `mode: "once"`
5. App calls `POST /conversations/:id/messages`
6. App resets mode to Off

### Live Mode Flow

1. User sets mode to Live — `CLLocationManager` starts significant-change updates
2. Each location update calls `POST /conversations/:id/location` with `mode: "live"`
3. Every subsequent message automatically includes the latest location (already stored in backend)
4. A visible pill indicator in the chat toolbar shows "Sharing location" with a stop button
5. On leaving the conversation or tapping stop:
   - App calls `DELETE /conversations/:id/location`
   - `CLLocationManager` stops updates
   - Indicator is dismissed

### Location Payload (sent to backend)

```json
{
  "lat": 38.7223,
  "lon": -9.1393,
  "accuracy_m": 12,
  "timestamp": "2026-06-12T18:45:00Z",
  "mode": "once|live",
  "source": "ios"
}
```

Location context is invisible — it never appears as a chat bubble in the transcript.

---

## Keychain

JWT token stored under a fixed service/account key. `KeychainService` wraps `SecItemAdd`, `SecItemCopyMatching`, and `SecItemDelete` for save, read, and clear operations.
