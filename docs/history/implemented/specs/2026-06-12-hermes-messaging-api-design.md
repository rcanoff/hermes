# Hermes Mobile Channel — Backend Spec (`messaging-api`)
**Date:** 2026-06-12  
**Status:** Implemented  
**Companion spec:** `2026-06-12-hermes-assistant-companion-design.md`

---

## Goal

A private TypeScript API that bridges native mobile clients to Hermes. Mobile clients never communicate directly with Hermes. The backend owns all persistence and handles auth, conversation management, message history, streaming, and location context.

---

## Out of Scope (MVP)

- File and image uploads
- Push notifications
- Conversation cleanup / auto-delete
- Public internet exposure (Tailscale only)

---

## Architecture

```
iOS App (SwiftUI)
    │  HTTPS over Tailscale
    ▼
messaging-api (Fastify / TypeScript / Docker)
    │  SQLite — users, sessions, conversations, messages, runs, locations
    │  HTTP over internal Docker network
    ▼
hermes-agent (Docker, port 8642)
    └─ /v1/chat/completions (OpenAI-compatible, SSE streaming)
```

Both containers run in the same Docker Compose project on the Raspberry Pi. `messaging-api` reaches Hermes at `http://hermes:8642`. Access is via Tailscale only.

---

## Technology

- TypeScript
- Fastify
- `better-sqlite3`
- `@fastify/jwt`
- Docker + Docker Compose

---

## SQLite Schema

```sql
users
  id, username, password_hash, created_at

sessions
  id, user_id, token, created_at, expires_at
  -- used as a token denylist for explicit logout/invalidation

conversations
  id, user_id, hermes_session_id, title, created_at

messages
  id, conversation_id, role (user|assistant), content, created_at

message_runs
  id, conversation_id, user_message_id, assistant_message_id, status, error_code, error_detail, started_at, finished_at
  -- internal lifecycle state for one assistant generation attempt
  -- status: running|completed|failed
  -- enforces one active run per conversation in MVP

conversation_locations
  id, conversation_id, lat, lon, accuracy_m, timestamp, mode, source, updated_at
  -- one row per conversation, upserted on each update
```

Notes:

- `conversations.title` may be null in MVP
- `messages` stores only real `user` and `assistant` chat content
- location context is never persisted as a transcript message

---

## API Endpoints

**Authentication**
- `POST /auth/login` — validate username + password, return JWT
- `POST /auth/logout` — invalidate session (add token to blocklist)
- `GET /auth/me` — return current user

**Conversations**
- `GET /conversations` — list conversations for authenticated user
- `POST /conversations` — create conversation, generate `hermes_session_id`
- `GET /conversations/:id` — get conversation metadata

**Messages**
- `POST /conversations/:id/messages` — send a message, triggers Hermes call
- `GET /conversations/:id/messages` — load full message history
- `GET /conversations/:id/stream` — SSE stream of the active Hermes response

**Location**
- `POST /conversations/:id/location` — upsert location context for conversation
- `GET /conversations/:id/location/latest` — get current location for conversation
- `DELETE /conversations/:id/location` — clear location context

All routes except `POST /auth/login` require `Authorization: Bearer <token>`.

---

## Message Request Flow

1. Client `POST /conversations/:id/messages` with `{ text }`
2. Backend verifies the conversation belongs to the authenticated user
3. Backend rejects the request if the conversation already has a `running` row in `message_runs`
4. Backend saves the user message to SQLite
5. Backend creates a `message_runs` row with `status: running`
6. Backend loads full message history from SQLite for the conversation
7. If a location row exists for the conversation, prepend a silent system message:  
   `"User's current location: lat X, lon Y, accuracy Zm (as of <timestamp>)"`  
   This is never stored as a message and never visible in the transcript.
8. Call Hermes `POST /v1/chat/completions` with `stream: true` and `X-Session-ID: <hermes_session_id>`
9. If the client is connected to `GET /conversations/:id/stream`, pipe the Hermes SSE stream through as:
   ```
   event: token
   data: {"text":"..."}

   event: tool
   data: {"name":"..."}

   event: done
   data: {"messageId":"..."}
   ```
10. The backend continues consuming the Hermes stream even if the mobile client disconnects
11. On successful completion, save the completed assistant message to SQLite and mark the `message_runs` row `completed`
12. On failure, mark the `message_runs` row `failed` with machine-readable error metadata and do not create a fake assistant message

**Why full history on every request:**  
Standard pattern for stateless LLM APIs. On a local Docker network the overhead is negligible. Summarization can be added post-MVP for very long conversations.

**Why durable run records:**  
The API, not the mobile client, owns long-running Hermes work. A user can close the app and return later to the final saved assistant message. Live SSE is best-effort for the current connection only.

---

## Run Lifecycle Rules

- At most one active assistant run is allowed per conversation in MVP
- A second `POST /conversations/:id/messages` while a run is active returns a conflict response
- `GET /conversations/:id/stream` attaches only to the current active run and does not support replay or reattachment
- If the stream client disconnects, Hermes generation continues in the backend
- On API startup, any `message_runs` rows left in `running` state are marked `failed` with an error such as `server_restart`
- Users retrieve the durable final result through `GET /conversations/:id/messages`, not by resuming an old stream

---

## Multi-User Model

- Each user has isolated conversations and message history
- Users cannot see each other's conversations
- All users share the same Hermes instance
- Each conversation has its own `hermes_session_id` (UUID generated at conversation creation) for per-conversation Hermes context isolation
- Every conversation-scoped route verifies ownership before reading or mutating data
- Missing or unauthorized conversations should return `404` to avoid leaking cross-user existence

---

## Auth Model

- Users are pre-provisioned by the operator in MVP
- No self-service registration is exposed by the API in MVP
- JWTs are long-lived in MVP
- `POST /auth/logout` invalidates the current token by adding it to the denylist in `sessions`

---

## Location Payload (received from iOS)

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

---

## Deployment

- Runs in Docker Compose alongside `hermes-agent` on the Raspberry Pi
- SQLite database file mounted as a Docker volume for persistence
- Reachable from iOS app via Tailscale IP
