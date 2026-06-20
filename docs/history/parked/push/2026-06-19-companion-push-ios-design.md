# Companion Push Notifications — iOS Client Design Spec (Reference)

**Date:** 2026-06-19  
**Status:** Approved (reference)
**API version:** v2.5.0  
**Repo:** `assistant-companion` (not this workspace)  
**Status:** Parked  
**Backend spec:** `docs/history/parked/push/2026-06-19-companion-push-design.md`  
**Backend plan:** `docs/history/parked/push/2026-06-19-companion-push-backend.md`

> **For the iOS agent:** Read this spec, then write the full implementation plan at  
> `docs/superpowers/plans/2026-06-19-companion-push-ios.md` in the `assistant-companion` repo.  
> Do **not** invent UX flows here — this document only lists platform and API requirements the client must satisfy.

---

## What changed (API v2.5.0)

### New routes

| Method | Path | Purpose |
|--------|------|---------|
| `PUT` | `/push/device` | Register or refresh APNs device token |
| `DELETE` | `/push/device` | Unregister device token |

Both require `Authorization: Bearer <jwt>`.

### `PUT /push/device` request

```json
{
  "device_token": "<hex>",
  "environment": "development"
}
```

| Field | Values |
|-------|--------|
| `environment` | `development` (debug builds) or `production` (TestFlight/App Store) |

**Response:** `200 { "ok": true }`

### `DELETE /push/device` request

```json
{
  "device_token": "<hex>"
}
```

**Response:** `200 { "ok": true }`

---

## APNs notification payload (client must parse)

Standard alert in `aps.alert`. Tap routing via root `companion` object.

### Chat push (`kind: assistant_reply`)

```json
{
  "aps": {
    "alert": { "title": "Morning briefing", "body": "…" },
    "sound": "default",
    "thread-id": "<conversationId>"
  },
  "companion": {
    "destination": "conversation",
    "conversation_id": "<uuid>",
    "message_id": "<uuid>",
    "kind": "assistant_reply"
  }
}
```

**Tap:** open `conversation_id` thread → run thread sync → show message (`message_id` scroll target if feasible).

### Job push (`kind: cron_run`)

```json
{
  "aps": {
    "alert": { "title": "Job · Morning check-in", "body": "…" },
    "sound": "default",
    "thread-id": "jobs"
  },
  "companion": {
    "destination": "jobs",
    "conversation_id": "<jobConversationUuid>",
    "message_id": "<uuid>",
    "kind": "cron_run"
  }
}
```

**Tap:** open **jobs list** surface (`GET /jobs`), **not** the job conversation thread. `conversation_id` is for optional sync context only.

| `companion.destination` | Tap target |
|-------------------------|------------|
| `conversation` | Chat thread for `conversation_id` |
| `jobs` | Jobs index / list screen |

---

## Client responsibilities

### 1. Apple platform setup

- Enable **Push Notifications** capability.
- Register for remote notifications (`UIApplication.shared.registerForRemoteNotifications()`).
- Request user authorization via `UNUserNotificationCenter` (timing and copy: product decision).
- Handle `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` — convert token to hex string for API.
- Map build type → `environment`: Xcode debug → `development`; TestFlight/App Store → `production`.

### 2. Token lifecycle

| Event | Required action |
|-------|-----------------|
| Successful login (or token refresh while logged in) | `PUT /push/device` with current JWT |
| Logout | `DELETE /push/device` then existing logout flow |
| `didRegisterForRemoteNotificationsWithDeviceToken` while authenticated | `PUT /push/device` |
| Token changes (iOS may rotate) | `PUT /push/device` on change |

Register **after** JWT is available so the server stores correct `session_id` (`jti`).

### 3. Notification handling

| Event | Required action |
|-------|-----------------|
| Tap + `destination: conversation` | Navigate to `conversation_id`; thread sync; land on `message_id` if feasible |
| Tap + `destination: jobs` | Navigate to jobs list; refresh via `GET /jobs` + conversation sync as needed |
| Foreground delivery | Product decides banner/in-app toast; SSE remains primary for live runs on connected device |
| Permission denied | App remains functional; no `PUT /push/device` |

### 4. Interaction with existing transports

- **Session SSE** (`GET /events/stream`): unchanged. Server suppresses push to any device whose `session_id` has an active SSE connection.
- **Sync feeds**: push does not carry message body beyond alert preview; **sync is source of truth** after open.
- **Background:** no silent push v1 — committed messages appear after user opens app or taps notification.

### 5. Multi-device

Same user on two phones: both may register tokens. Server pushes all non-live devices. Client does not need cross-device coordination.

### 6. Job vs chat pushes

- `assistant_reply` → chat thread (even if conversation `kind=job` when user chatted there).
- `cron_run` → jobs list only; do **not** deep-link into job thread on tap.

---

## Not in scope (iOS v1)

- Notification settings UI (unless product adds locally)
- Rich notifications, categories, action buttons
- Silent background sync via `content-available`
- Badge management (server omits badge v1)
- Android

---

## Verification checklist (for iOS plan)

1. Debug build registers with `environment: "development"` after login.
2. `PUT /push/device` called again when APNs token rotates.
3. `DELETE /push/device` called on logout.
4. Tap chat push opens conversation; new message visible after sync.
5. Tap cron push opens jobs list (not job thread).
6. Device with active SSE does not receive push for same user's events (server suppression).
7. Second device receives push when first device completes a run.
8. Cron fire (non-silent) triggers job-format push when no device has active SSE.

---

## Dependencies on operator / backend

- `APNS_ENABLED=true` on `messaging-api` with valid `.p8` key and bundle id matching the iOS app.
- `environment` on register must match server `APNS_ENVIRONMENT` and build type.