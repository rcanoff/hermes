# Companion Photo Sharing — iOS Client Design Spec (Reference)

**Date:** 2026-06-21  
**Status:** Approved (reference)  
**API version:** v2.8.0  
**Repo:** `assistant-companion` (not this workspace)  
**Backend spec:** `docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md`  
**OpenAPI:** `hermes/docs/superpowers/specs/messaging-api.openapi.yaml`

---

## Instructions for the iOS agent

**Write your own implementation plan** — do not implement in `hermes`.

| Item | Location |
|------|----------|
| iOS plan (you create) | `docs/superpowers/plans/2026-06-21-companion-photo-sharing-ios.md` in `assistant-companion` |
| OpenAPI (source of truth) | `hermes/docs/superpowers/specs/messaging-api.openapi.yaml` v2.8.0 |
| Backend behavior | `hermes/docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md` |

---

## Goal

Composer toolbar control to attach 1–10 photos (camera or library), optional shared caption, send as one message. Render photo bubbles in chat, cache downloads, sync to other devices via existing inbox + thread sync.

---

## Composer UX

Mirror the location toolbar pattern:

```
MessageComposer
  ├─ Text field (caption)
  ├─ Toolbar: [Location] [Photos] [Send]
  └─ Attachment strip (when staging): horizontal thumbnails + remove (×) per item
```

### Attach flow

1. User taps **Photos** → action sheet: **Take Photo** | **Choose from Library**
2. User picks 1–10 images (enforce cap in picker / strip)
3. iOS normalizes to upload-ready format client-side only for **preview**; server stores original + derives thumb/vision
4. For each selection: `POST /attachments` (multipart) in parallel with progress
5. Failed upload: show retry on thumbnail; block send until resolved or removed
6. User enters optional caption, taps **Send**
7. `POST /messages` with `{ text?, attachment_ids }` — same `202` + stream flow as text
8. Clear attachment strip; optimistically show bubble with local images

### Permissions

- `NSCameraUsageDescription`
- `NSPhotoLibraryUsageDescription` (or `PHPicker` — no full library permission required on iOS 14+)

---

## Chat rendering

### User photo message bubble

- Caption text above/below image grid (if non-empty)
- Up to 10 images: 1 = full width; 2 = side-by-side; 3–4 = 2×2 grid; 5+ = scrollable horizontal strip or compact grid
- Thumbnail source priority: local file (sending device) → cached `thumb` download → placeholder shimmer
- Tap image → full-screen viewer; fetch `?variant=original` if not cached

### Assistant messages

Unchanged (text + process tooling).

---

## Upload pipeline

```swift
// Conceptual stages per attachment
enum AttachmentUploadState {
  case staging(localURL: URL)
  case uploading(progress: Double)
  case staged(serverId: UUID, thumbURL: URL)
  case failed(retry: () -> Void)
}
```

| Step | API |
|------|-----|
| Stage | `POST /attachments` — `multipart/form-data`, field `file` |
| Send | `POST /conversations/{id}/messages` — `{ text, attachment_ids: [UUID] }` |
| Order | `attachment_ids` array order matches composer strip left-to-right |

**HEIC:** upload original bytes from picker/camera; server generates derivatives (no client-side conversion required for upload, unlike Approach A).

---

## Local persistence (SwiftData)

Extend message model:

| Field | Type | Notes |
|-------|------|-------|
| `attachmentId` | UUID | Server id |
| `messageId` | UUID | Parent message |
| `position` | Int | Display order |
| `contentType` | String | Original mime |
| `byteSize` | Int | |
| `width` / `height` | Int? | |
| `localThumbPath` | String? | After download |
| `localOriginalPath` | String? | After full fetch |
| `downloadState` | enum | `pending`, `thumbReady`, `complete`, `failed` |

Sending device: populate from local picker files immediately; mark `thumbReady` without download.

Receiving device: on `message_upsert`, insert metadata → background thumb fetch → update `localThumbPath`.

---

## Sync integration

Uses existing v2.6.0+ inbox flow — **no new sync routes**.

1. Foreground / inbox poll → `kind: updated`
2. `GET /conversations/{id}/sync` → `message_upsert` with `attachments[]`
3. Upsert SwiftData message + attachment rows
4. Download thumbs for `downloadState == pending`
5. Rewind/delete events → purge attachment files from disk cache

**Account switch:** attachment cache is user-scoped (same as messages).

---

## Caption-only edit

When user edits the last user message that has attachments:

- `PATCH` with `{ text }` only
- UI: text editor pre-filled; attachment strip read-only (no add/remove)
- On success: apply rewind locally, reopen stream (existing edit flow)

---

## Error UX

| Error | User-facing |
|-------|-------------|
| `unsupported_media_type` | "This file type isn't supported." |
| `payload_too_large` | "Photo is too large (max 20 MB)." |
| `invalid_request` on send | "Couldn't attach photos — try again." |
| Upload network failure | Per-thumbnail retry button |
| Thumb download failure | Grey placeholder, tap to retry |
| `edit_not_allowed` | Existing edit error copy |

---

## Out of scope (iOS v1)

- Implementing backend routes
- In-app image editing (crop, markup)
- Reordering attachments after pick
- Sharing photos outside companion
- Offline send queue (requires connectivity to upload)

---

## iOS plan must include

- [ ] `PhotosPicker` + `UIImagePickerController` (camera) integration
- [ ] Composer attachment strip component
- [ ] `AttachmentUploadService` (parallel POST, retry)
- [ ] SwiftData attachment entity + cache eviction on rewind/delete
- [ ] Chat bubble photo grid + fullscreen viewer
- [ ] Sync hook: thumb prefetch on `message_upsert`
- [ ] Caption-only edit UI
- [ ] Manual test: send on phone A → visible on phone B after inbox poll

---

## Manual test scenarios

1. **Camera + caption** — take photo, ask question, assistant responds with visual context
2. **Library batch (5)** — shared caption, all appear in one bubble
3. **Photo-only** — no caption, Hermes still receives images
4. **Follow-up** — second message without new photos; assistant still references first photo
5. **Cross-device** — phone A sends; phone B foreground → inbox → thumbs appear
6. **Caption edit** — change caption; photos unchanged; assistant re-runs
7. **Max cap** — 11th photo blocked in UI before upload
8. **Logout/login** — same user's photos load from server (not other user's)