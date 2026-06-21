# Companion Photo Sharing — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **HARD RULE — this repo only:** Implement **backend** work in `hermes` (`messaging-api`, tests, OpenAPI, README, `.env.example`). Do **not** implement iOS/Swift changes here. The iOS client (`assistant-companion`) must write its own plan — see `docs/superpowers/specs/2026-06-21-companion-photo-sharing-ios-design.md`.

> **HARD RULE — OpenAPI gate:** Every contract change must update `docs/superpowers/specs/messaging-api.openapi.yaml` in the same change set. Target version **v2.8.0**.

**Goal:** Add staged photo attachments (upload → send with caption) that render in chat, sync across devices, and feed Hermes vision input with full-conversation multimodal history and byte-cap pruning.

**Architecture:** New `message_attachments` table + filesystem under `ATTACHMENTS_DIR`. `POST /attachments` ingests originals and generates thumb/vision JPEG derivatives via `sharp`. `POST /messages` links staged ids. A shared serializer attaches `attachments[]` to `Message` on list/sync/upsert. `buildHermesMessages` emits OpenAI-style `content` arrays with base64 `image_url` parts from `vision.jpg`.

**Tech Stack:** TypeScript, Fastify, `@fastify/multipart`, `sharp`, `better-sqlite3`, Vitest

**Spec:** `docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md`

---

## Client integration summary (for `assistant-companion` agent)

| Topic | Rule |
|-------|------|
| OpenAPI | v2.8.0 — `Message.attachments[]`, `POST /attachments`, `GET /attachments/{id}?variant=` |
| Upload | One file per `POST /attachments`; parallelize up to 10; then `POST /messages` with `attachment_ids` |
| Send body | `{ text?, attachment_ids?: uuid[] }` — at least one of non-empty text or ids |
| Photo-only | `text` omitted or `""`; `content` in response is `""` |
| Download | `GET /attachments/{id}?variant=thumb\|original\|vision` — JWT owner only |
| Sync | Existing `message_upsert` carries attachment metadata; bytes fetched separately |
| Edit | Caption-only `PATCH` on photo messages; no `attachment_ids` in body |
| Deploy | Ship iOS + backend together |

**iOS agent:** write the implementation plan at `docs/superpowers/plans/2026-06-21-companion-photo-sharing-ios.md` in `assistant-companion`.

---

## File structure

```
messaging-api/
  package.json                              — MODIFY: add sharp, @fastify/multipart
  src/
    config.ts                               — MODIFY: attachment env vars
    types.ts                                — MODIFY: AttachmentOptions on AppOptions
    db/schema.ts                            — MODIFY: message_attachments table
    db/repos/message-attachments.ts         — CREATE: CRUD, link, orphan sweep
    lib/attachment-serializer.ts            — CREATE: Message + attachments[] + HAL _links
    lib/attachment-storage.ts             — CREATE: paths, mkdir, delete tree
    services/image-derivatives.ts         — CREATE: sharp thumb + vision JPEG
    services/prompt-builder.ts              — MODIFY: multimodal HermesPromptMessage
    services/hermes-client.ts             — MODIFY: HermesContentPart types
    routes/attachments.ts                   — CREATE: POST/GET
    routes/messages.ts                      — MODIFY: send/list/patch + attachments
    routes/chat-sync.ts                   — MODIFY: attach process + attachments on upsert
    app.ts                                  — MODIFY: register multipart + attachment routes
    lib/push-preview.ts                     — MODIFY: photo-only fallback body
  test/
    helpers/
      app.ts                                — MODIFY: attachmentsDir temp path + options
      attachments.ts                        — CREATE: tiny JPEG fixture + multipart inject
    db.test.ts                              — MODIFY: message_attachments table assertion
    config.test.ts                          — MODIFY: attachment env parsing
    message-attachments.test.ts             — CREATE: repo tests
    image-derivatives.test.ts               — CREATE: derivative generation
    attachments-routes.test.ts                — CREATE: upload/download/auth
    messages-photo.test.ts                  — CREATE: send/list/edit/sync/Hermes
    prompt-builder.test.ts                  — CREATE: multimodal + cap pruning
    messages.test.ts                        — MODIFY: ensure text-only unchanged

docs/superpowers/specs/messaging-api.openapi.yaml     — MODIFY: v2.8.0
docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md — MODIFY: Status → Approved
docs/superpowers/README.md                             — MODIFY: link photo sharing work
.env.example                                           — MODIFY: attachment env vars
README.md                                              — MODIFY: photo sharing section
```

---

## Task 1: OpenAPI v2.8.0 contract

**Files:**
- Modify: `docs/superpowers/specs/messaging-api.openapi.yaml`

- [ ] **Step 1: Bump version and changelog**

Set `info.version: 2.8.0` and add at top of `info.description`:

```yaml
    **v2.8.0 changes:** photo attachments in chat. `POST /attachments` stages image
    uploads (JPEG, PNG, HEIC/HEIF; max 20 MB). `POST /conversations/{id}/messages`
    accepts optional `attachment_ids` (1–10) with optional caption. `Message.attachments[]`
    on list, sync, and create responses. `GET /attachments/{id}?variant=original|thumb|vision`
    serves JWT-scoped bytes. Caption-only `PATCH` on photo messages. Hermes receives
    multimodal history with vision JPEG derivatives. Requires companion app update.
    See `docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md`.
```

- [ ] **Step 2: Add schemas**

```yaml
    AttachmentSummary:
      type: object
      required: [id, content_type, byte_size, position]
      properties:
        id:
          type: string
          format: uuid
        content_type:
          type: string
          description: Original MIME type (e.g. image/heic)
        byte_size:
          type: integer
          minimum: 1
        width:
          type: integer
          nullable: true
        height:
          type: integer
          nullable: true
        position:
          type: integer
          minimum: 0
        _links:
          type: object
          properties:
            self:
              $ref: '#/components/schemas/HalLink'
            thumb:
              $ref: '#/components/schemas/HalLink'

    AttachmentUploadResponse:
      type: object
      required: [attachment]
      properties:
        attachment:
          $ref: '#/components/schemas/AttachmentSummary'

    AttachmentVariant:
      type: string
      enum: [original, thumb, vision]
      default: original
```

- [ ] **Step 3: Extend `Message`**

Add optional property:

```yaml
        attachments:
          type: array
          items:
            $ref: '#/components/schemas/AttachmentSummary'
          description: Present on user messages with photos; omitted on text-only messages
```

- [ ] **Step 4: Extend `CreateMessageRequest`**

```yaml
        attachment_ids:
          type: array
          items:
            type: string
            format: uuid
          minItems: 1
          maxItems: 10
          description: Staged attachment ids from POST /attachments
```

Update description: at least one of non-empty `text`/`content` or `attachment_ids` required.

- [ ] **Step 5: Add paths**

```yaml
  /attachments:
    post:
      operationId: uploadAttachment
      summary: Stage a photo attachment
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file:
                  type: string
                  format: binary
      responses:
        '201':
          description: Attachment staged
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AttachmentUploadResponse'
        '400':
          description: invalid_request | unsupported_media_type | payload_too_large
        '401':
          description: unauthorized

  /attachments/{id}:
    get:
      operationId: getAttachment
      summary: Download attachment bytes
      security: [{ bearerAuth: [] }]
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string, format: uuid }
        - name: variant
          in: query
          schema:
            $ref: '#/components/schemas/AttachmentVariant'
      responses:
        '200':
          description: Image bytes
          content:
            image/jpeg: {}
            image/png: {}
            image/heic: {}
            image/heif: {}
        '404':
          description: not_found
        '401':
          description: unauthorized
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/messaging-api.openapi.yaml
git commit -m "docs(messaging-api): OpenAPI v2.8.0 photo attachments contract"
```

---

## Task 2: Dependencies and config

**Files:**
- Modify: `messaging-api/package.json`
- Modify: `messaging-api/src/config.ts`
- Modify: `messaging-api/src/types.ts`
- Modify: `messaging-api/test/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install packages**

```bash
cd messaging-api && npm install sharp @fastify/multipart
```

- [ ] **Step 2: Write failing config test**

Add to `messaging-api/test/config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'

describe('attachment config', () => {
  it('reads attachment defaults', () => {
    const config = readConfig({
      JWT_SECRET: 'secret',
      MESSAGING_API_HOST: '127.0.0.1:3000',
    })
    expect(config.attachmentsDir).toBe('/opt/data/attachments')
    expect(config.attachmentMaxBytes).toBe(20_971_520)
    expect(config.attachmentOrphanTtlHours).toBe(24)
    expect(config.visionMaxEdgePx).toBe(1536)
    expect(config.thumbMaxEdgePx).toBe(200)
    expect(config.visionHistoryMaxBytes).toBe(8_388_608)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd messaging-api && npm test -- config.test.ts -t "attachment config"`
Expected: FAIL — `attachmentsDir` undefined

- [ ] **Step 4: Implement config**

In `messaging-api/src/types.ts`, add to `AppOptions`:

```typescript
  attachmentsDir: string
  attachmentMaxBytes: number
  attachmentOrphanTtlHours: number
  visionMaxEdgePx: number
  thumbMaxEdgePx: number
  visionHistoryMaxBytes: number
```

In `messaging-api/src/config.ts`, inside `readConfig`:

```typescript
    attachmentsDir: env.ATTACHMENTS_DIR?.trim() || '/opt/data/attachments',
    attachmentMaxBytes: readPositiveInt(env.ATTACHMENT_MAX_BYTES, 20_971_520),
    attachmentOrphanTtlHours: readPositiveInt(env.ATTACHMENT_ORPHAN_TTL_HOURS, 24),
    visionMaxEdgePx: readPositiveInt(env.VISION_MAX_EDGE_PX, 1536),
    thumbMaxEdgePx: readPositiveInt(env.THUMB_MAX_EDGE_PX, 200),
    visionHistoryMaxBytes: readPositiveInt(env.VISION_HISTORY_MAX_BYTES, 8_388_608),
```

Add to `.env.example`:

```bash
# Photo attachments (v2.8.0)
ATTACHMENTS_DIR=/opt/data/attachments
ATTACHMENT_MAX_BYTES=20971520
ATTACHMENT_ORPHAN_TTL_HOURS=24
VISION_MAX_EDGE_PX=1536
THUMB_MAX_EDGE_PX=200
VISION_HISTORY_MAX_BYTES=8388608
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd messaging-api && npm test -- config.test.ts -t "attachment config"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/package.json messaging-api/package-lock.json \
  messaging-api/src/config.ts messaging-api/src/types.ts \
  messaging-api/test/config.test.ts .env.example
git commit -m "feat(messaging-api): attachment config env vars"
```

---

## Task 3: SQLite schema

**Files:**
- Modify: `messaging-api/src/db/schema.ts`
- Modify: `messaging-api/test/db.test.ts`

- [ ] **Step 1: Write failing schema test**

Add to `messaging-api/test/db.test.ts`:

```typescript
  it('includes message_attachments table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'message_attachments'`)
      .get()
    expect(row).toBeTruthy()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- db.test.ts -t "message_attachments"`
Expected: FAIL

- [ ] **Step 3: Add table to initSchema**

Append to the `db.exec` block in `messaging-api/src/db/schema.ts`:

```sql
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      original_path TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      vision_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS message_attachments_user_unattached_idx
      ON message_attachments (user_id, expires_at)
      WHERE message_id IS NULL;

    CREATE INDEX IF NOT EXISTS message_attachments_message_idx
      ON message_attachments (message_id, position);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- db.test.ts -t "message_attachments"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/schema.ts messaging-api/test/db.test.ts
git commit -m "feat(messaging-api): message_attachments schema"
```

---

## Task 4: Attachment repository

**Files:**
- Create: `messaging-api/src/db/repos/message-attachments.ts`
- Create: `messaging-api/test/message-attachments.test.ts`

- [ ] **Step 1: Write failing repo test**

Create `messaging-api/test/message-attachments.test.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import {
  getAttachmentForUser,
  insertStagedAttachment,
  linkAttachmentsToMessage,
  listAttachmentsForMessage,
} from '../src/db/repos/message-attachments.js'

describe('message-attachments repo', () => {
  let db: Database.Database
  let userId: string

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    userId = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`).run(
      userId,
      'u',
      'hash',
    )
  })

  afterEach(() => {
    db.close()
  })

  it('stages and links attachments to a message', () => {
    const messageId = randomUUID()
    const conversationId = randomUUID()
    db.prepare(`INSERT INTO conversations (id, user_id, hermes_session_id) VALUES (?, ?, ?)`).run(
      conversationId,
      userId,
      randomUUID(),
    )
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', '')`).run(
      messageId,
      conversationId,
    )

    const a1 = insertStagedAttachment(db, {
      userId,
      contentType: 'image/jpeg',
      byteSize: 1000,
      width: 100,
      height: 80,
      originalPath: 'orig.jpg',
      thumbPath: 'thumb.jpg',
      visionPath: 'vision.jpg',
      orphanTtlHours: 24,
    })
    const a2 = insertStagedAttachment(db, {
      userId,
      contentType: 'image/jpeg',
      byteSize: 1000,
      width: 100,
      height: 80,
      originalPath: 'orig2.jpg',
      thumbPath: 'thumb2.jpg',
      visionPath: 'vision2.jpg',
      orphanTtlHours: 24,
    })

    linkAttachmentsToMessage(db, userId, messageId, [a1, a2])

    const rows = listAttachmentsForMessage(db, messageId)
    expect(rows.map((r) => r.id)).toEqual([a1, a2])
    expect(rows[0].position).toBe(0)
    expect(rows[1].position).toBe(1)
    expect(getAttachmentForUser(db, userId, a1)?.message_id).toBe(messageId)
  })
})
```

Add missing `beforeEach` import from vitest.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- message-attachments.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement repo**

Create `messaging-api/src/db/repos/message-attachments.ts` with:

```typescript
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface AttachmentRow {
  id: string
  user_id: string
  message_id: string | null
  position: number
  content_type: string
  byte_size: number
  width: number | null
  height: number | null
  original_path: string
  thumb_path: string
  vision_path: string
  created_at: string
  expires_at: string | null
}

export interface InsertStagedAttachmentInput {
  userId: string
  contentType: string
  byteSize: number
  width: number | null
  height: number | null
  originalPath: string
  thumbPath: string
  visionPath: string
  orphanTtlHours: number
}

export function insertStagedAttachment(
  db: Database.Database,
  input: InsertStagedAttachmentInput,
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO message_attachments (
      id, user_id, message_id, position, content_type, byte_size, width, height,
      original_path, thumb_path, vision_path, expires_at
    ) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?,
      datetime('now', '+' || ? || ' hours'))
  `).run(
    id,
    input.userId,
    input.contentType,
    input.byteSize,
    input.width,
    input.height,
    input.originalPath,
    input.thumbPath,
    input.visionPath,
    input.orphanTtlHours,
  )
  return id
}

export function getAttachmentForUser(
  db: Database.Database,
  userId: string,
  attachmentId: string,
): AttachmentRow | undefined {
  return db
    .prepare(`SELECT * FROM message_attachments WHERE id = ? AND user_id = ?`)
    .get(attachmentId, userId) as AttachmentRow | undefined
}

export function listAttachmentsForMessage(
  db: Database.Database,
  messageId: string,
): AttachmentRow[] {
  return db
    .prepare(`
      SELECT * FROM message_attachments
      WHERE message_id = ?
      ORDER BY position ASC, created_at ASC, id ASC
    `)
    .all(messageId) as AttachmentRow[]
}

export function listAttachmentsForMessages(
  db: Database.Database,
  messageIds: string[],
): Map<string, AttachmentRow[]> {
  const map = new Map<string, AttachmentRow[]>()
  if (messageIds.length === 0) {
    return map
  }
  const placeholders = messageIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT * FROM message_attachments
      WHERE message_id IN (${placeholders})
      ORDER BY message_id, position ASC, created_at ASC, id ASC
    `)
    .all(...messageIds) as AttachmentRow[]

  for (const row of rows) {
    if (!row.message_id) continue
    const bucket = map.get(row.message_id) ?? []
    bucket.push(row)
    map.set(row.message_id, bucket)
  }
  return map
}

export function validateStagedAttachments(
  db: Database.Database,
  userId: string,
  attachmentIds: string[],
): AttachmentRow[] | null {
  if (attachmentIds.length === 0 || attachmentIds.length > 10) {
    return null
  }
  const rows: AttachmentRow[] = []
  for (const id of attachmentIds) {
    const row = getAttachmentForUser(db, userId, id)
    if (!row || row.message_id !== null) {
      return null
    }
    if (row.expires_at && row.expires_at <= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      return null
    }
    rows.push(row)
  }
  return rows
}

export function linkAttachmentsToMessage(
  db: Database.Database,
  userId: string,
  messageId: string,
  attachmentIds: string[],
): void {
  attachmentIds.forEach((id, position) => {
    const result = db
      .prepare(`
        UPDATE message_attachments
        SET message_id = ?, position = ?, expires_at = NULL
        WHERE id = ? AND user_id = ? AND message_id IS NULL
      `)
      .run(messageId, position, id, userId)
    if (result.changes !== 1) {
      throw new Error('attachment_link_failed')
    }
  })
}

export function deleteExpiredOrphanAttachments(db: Database.Database): string[] {
  const rows = db
    .prepare(`
      SELECT id, original_path, thumb_path, vision_path
      FROM message_attachments
      WHERE message_id IS NULL AND expires_at IS NOT NULL AND expires_at < datetime('now')
    `)
    .all() as Array<Pick<AttachmentRow, 'id' | 'original_path' | 'thumb_path' | 'vision_path'>>

  if (rows.length === 0) {
    return []
  }

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(', ')
  db.prepare(`DELETE FROM message_attachments WHERE id IN (${placeholders})`).run(...ids)
  return ids
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- message-attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/db/repos/message-attachments.ts messaging-api/test/message-attachments.test.ts
git commit -m "feat(messaging-api): message attachments repository"
```

---

## Task 5: Image derivatives service

**Files:**
- Create: `messaging-api/src/services/image-derivatives.ts`
- Create: `messaging-api/src/lib/attachment-storage.ts`
- Create: `messaging-api/test/image-derivatives.test.ts`

- [ ] **Step 1: Write failing derivative test**

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { generateAttachmentDerivatives } from '../src/services/image-derivatives.js'

describe('generateAttachmentDerivatives', () => {
  let dir: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'))
    const src = path.join(dir, 'input.png')
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toFile(src)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes thumb and vision JPEG files', async () => {
    const result = await generateAttachmentDerivatives({
      inputPath: path.join(dir, 'input.png'),
      outputDir: dir,
      thumbMaxEdgePx: 200,
      visionMaxEdgePx: 400,
    })
    expect(fs.existsSync(result.thumbPath)).toBe(true)
    expect(fs.existsSync(result.visionPath)).toBe(true)
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- image-derivatives.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement services**

`attachment-storage.ts`:

```typescript
import fs from 'node:fs'
import path from 'node:path'

export function attachmentRoot(attachmentsDir: string, userId: string, attachmentId: string): string {
  return path.join(attachmentsDir, userId, attachmentId)
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function removeAttachmentTree(attachmentsDir: string, userId: string, attachmentId: string): void {
  fs.rmSync(attachmentRoot(attachmentsDir, userId, attachmentId), { recursive: true, force: true })
}
```

`image-derivatives.ts`:

```typescript
import path from 'node:path'
import sharp from 'sharp'

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif'])

export function isAcceptedImageMime(mime: string): boolean {
  return ACCEPTED_MIME.has(mime.toLowerCase())
}

export async function generateAttachmentDerivatives(input: {
  inputPath: string
  outputDir: string
  thumbMaxEdgePx: number
  visionMaxEdgePx: number
}): Promise<{ thumbPath: string; visionPath: string; width: number; height: number }> {
  const image = sharp(input.inputPath, { failOn: 'none' })
  const meta = await image.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  const thumbPath = path.join(input.outputDir, 'thumb.jpg')
  const visionPath = path.join(input.outputDir, 'vision.jpg')

  await sharp(input.inputPath).resize(input.thumbMaxEdgePx, input.thumbMaxEdgePx, {
    fit: 'inside',
    withoutEnlargement: true,
  }).jpeg({ quality: 80 }).toFile(thumbPath)

  await sharp(input.inputPath).resize(input.visionMaxEdgePx, input.visionMaxEdgePx, {
    fit: 'inside',
    withoutEnlargement: true,
  }).jpeg({ quality: 80 }).toFile(visionPath)

  return { thumbPath, visionPath, width, height }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd messaging-api && npm test -- image-derivatives.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/image-derivatives.ts messaging-api/src/lib/attachment-storage.ts \
  messaging-api/test/image-derivatives.test.ts
git commit -m "feat(messaging-api): image derivative generation with sharp"
```

---

## Task 6: Attachment serializer

**Files:**
- Create: `messaging-api/src/lib/attachment-serializer.ts`

- [ ] **Step 1: Implement serializer**

```typescript
import type { AttachmentRow } from '../db/repos/message-attachments.js'
import type { MessageRow } from '../db/repos/messages.js'

export interface AttachmentSummary {
  id: string
  content_type: string
  byte_size: number
  width: number | null
  height: number | null
  position: number
  _links: {
    self: { href: string }
    thumb: { href: string }
  }
}

export type MessageWithAttachments = MessageRow & {
  attachments?: AttachmentSummary[]
}

export function serializeAttachment(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    content_type: row.content_type,
    byte_size: row.byte_size,
    width: row.width,
    height: row.height,
    position: row.position,
    _links: {
      self: { href: `/attachments/${row.id}` },
      thumb: { href: `/attachments/${row.id}?variant=thumb` },
    },
  }
}

export function enrichMessagesWithAttachments(
  messages: MessageRow[],
  attachmentMap: Map<string, AttachmentRow[]>,
): MessageWithAttachments[] {
  return messages.map((message) => {
    const rows = attachmentMap.get(message.id)
    if (!rows || rows.length === 0) {
      return message
    }
    return {
      ...message,
      attachments: rows.map(serializeAttachment),
    }
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add messaging-api/src/lib/attachment-serializer.ts
git commit -m "feat(messaging-api): attachment summary serializer"
```

---

## Task 7: Attachment routes

**Files:**
- Create: `messaging-api/src/routes/attachments.ts`
- Modify: `messaging-api/src/app.ts`
- Modify: `messaging-api/test/helpers/app.ts`
- Create: `messaging-api/test/helpers/attachments.ts`
- Create: `messaging-api/test/attachments-routes.test.ts`

- [ ] **Step 1: Extend test app helper**

In `messaging-api/test/helpers/app.ts`, add defaults:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const defaultAttachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-attachments-'))

export async function createTestApp(overrides: Partial<AppOptions> = {}) {
  return buildApp({
    // ...existing fields...
    attachmentsDir: defaultAttachmentsDir,
    attachmentMaxBytes: 20_971_520,
    attachmentOrphanTtlHours: 24,
    visionMaxEdgePx: 1536,
    thumbMaxEdgePx: 200,
    visionHistoryMaxBytes: 8_388_608,
    ...overrides,
  })
}
```

Decorate these on `FastifyInstance` in `app.ts` (mirror `syncInboxMaxGap`).

- [ ] **Step 2: Write failing route test**

Create `messaging-api/test/helpers/attachments.ts` with `buildMultipartImagePayload(buffer, boundary)` and `createTinyJpegBuffer()` using sharp.

Create `messaging-api/test/attachments-routes.test.ts`:

```typescript
it('uploads and downloads an attachment for the owner', async () => {
  const jpeg = await createTinyJpegBuffer()
  const boundary = 'testboundary'
  const upload = await app.inject({
    method: 'POST',
    url: '/attachments',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: buildMultipartImagePayload(jpeg, boundary, 'photo.jpg', 'image/jpeg'),
  })
  expect(upload.statusCode).toBe(201)
  const { attachment } = upload.json() as { attachment: { id: string } }

  const thumb = await app.inject({
    method: 'GET',
    url: `/attachments/${attachment.id}?variant=thumb`,
    headers: { authorization: `Bearer ${token}` },
  })
  expect(thumb.statusCode).toBe(200)
  expect(thumb.headers['content-type']).toMatch(/image\/jpeg/)
})

it('returns 404 when another user downloads the attachment', async () => {
  // upload as operator, download as otherUserToken → 404
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd messaging-api && npm test -- attachments-routes.test.ts`
Expected: FAIL — 404 route

- [ ] **Step 4: Register multipart and implement routes**

In `app.ts`:

```typescript
import multipart from '@fastify/multipart'
import attachmentRoutes from './routes/attachments.js'

// inside buildApp, before routes:
app.register(multipart, { limits: { fileSize: options.attachmentMaxBytes } })
app.decorate('attachmentsDir', options.attachmentsDir)
// ... other attachment options

app.register(attachmentRoutes)
```

`routes/attachments.ts` — implement:

- `POST /attachments`: `request.file()`, validate mime via `isAcceptedImageMime`, write `original.*` ext from mime, call `generateAttachmentDerivatives`, `insertStagedAttachment`, return `201` with serializer
- `GET /attachments/:id`: resolve variant path from row, `createReadStream`, set content-type, `404` if wrong user
- On each `POST /attachments`, call `deleteExpiredOrphanAttachments` and remove trees for deleted ids
- Map errors: oversize → `payload_too_large`, bad mime → `unsupported_media_type`

- [ ] **Step 5: Run tests**

Run: `cd messaging-api && npm test -- attachments-routes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/routes/attachments.ts messaging-api/src/app.ts \
  messaging-api/test/helpers/app.ts messaging-api/test/helpers/attachments.ts \
  messaging-api/test/attachments-routes.test.ts
git commit -m "feat(messaging-api): attachment upload and download routes"
```

---

## Task 8: Extend message send with attachments

**Files:**
- Modify: `messaging-api/src/routes/messages.ts`
- Create: `messaging-api/test/messages-photo.test.ts`

- [ ] **Step 1: Write failing integration test**

```typescript
it('sends a photo message with caption and returns attachments', async () => {
  const attachmentId = await uploadStagedAttachment(app, operatorToken)
  hermesClient.pushAnswerToken('looks like a label')
  hermesClient.pushDone()

  const response = await app.inject({
    method: 'POST',
    url: `/conversations/${conversationId}/messages`,
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: { text: 'what is this?', attachment_ids: [attachmentId] },
  })

  expect(response.statusCode).toBe(202)
  const body = response.json() as { message: { content: string; attachments: Array<{ id: string }> } }
  expect(body.message.content).toBe('what is this?')
  expect(body.message.attachments).toHaveLength(1)
  expect(body.message.attachments[0].id).toBe(attachmentId)

  await waitForRun(app, conversationId)
  expect(hermesClient.requests[0].messages.at(-1)?.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'what is this?' }),
      expect.objectContaining({ type: 'image_url' }),
    ]),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd messaging-api && npm test -- messages-photo.test.ts -t "sends a photo"`
Expected: FAIL

- [ ] **Step 3: Extend messages route**

Update `MessageBody`:

```typescript
interface MessageBody {
  text?: string
  content?: string
  bootstrap?: string
  attachment_ids?: string[]
}
```

Update `isMessageBody` to accept optional `attachment_ids: string[]`.

Replace send validation:

```typescript
const content = extractMessageText(body)
const attachmentIds = normalizeAttachmentIds(body.attachment_ids)
if (!content && attachmentIds.length === 0) {
  return reply.code(400).send({ error: 'invalid_request' })
}
if (attachmentIds.length > 10) {
  return reply.code(400).send({ error: 'invalid_request' })
}
```

Inside transaction after `insertMessage`:

```typescript
if (attachmentIds.length > 0) {
  const staged = validateStagedAttachments(app.db, request.userId, attachmentIds)
  if (!staged) {
    throw new Error('invalid_attachments')
  }
  linkAttachmentsToMessage(app.db, request.userId, messageId, attachmentIds)
}
```

Skip duplicate-message short-circuit when `attachmentIds.length > 0`.

Map `invalid_attachments` → `400 invalid_request`.

After insert, load attachments and return enriched message via `enrichMessagesWithAttachments`.

- [ ] **Step 4: Run test**

Run: `cd messaging-api && npm test -- messages-photo.test.ts -t "sends a photo"`
Expected: FAIL on Hermes multimodal (prompt builder not done) — proceed to Task 9

- [ ] **Step 5: Commit partial**

```bash
git add messaging-api/src/routes/messages.ts messaging-api/test/messages-photo.test.ts
git commit -m "feat(messaging-api): send messages with staged attachment ids"
```

---

## Task 9: Multimodal prompt builder

**Files:**
- Modify: `messaging-api/src/services/prompt-builder.ts`
- Modify: `messaging-api/src/services/hermes-client.ts`
- Modify: `messaging-api/src/services/run-executor.ts`
- Create: `messaging-api/test/prompt-builder.test.ts`

- [ ] **Step 1: Write failing prompt test**

```typescript
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildHermesMessages } from '../src/services/prompt-builder.js'

it('builds multimodal user content from caption and vision files', async () => {
  const visionPath = '/tmp/vision-test.jpg'
  fs.writeFileSync(visionPath, Buffer.from('fake-jpeg'))
  const messages = await buildHermesMessages(
    [{ role: 'user', content: 'hi', id: 'm1', attachments: [{ vision_path: visionPath }] } as any],
    { readVisionBytes: async () => Buffer.from('abc') },
  )
  const user = messages.find((m) => m.role === 'user')
  expect(user?.content).toEqual([
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } },
  ])
})
```

Refine types properly in implementation — use a `HistoryMessage` type with optional attachments from repo.

- [ ] **Step 2: Extend Hermes types**

In `hermes-client.ts`:

```typescript
export interface HermesTextPart {
  type: 'text'
  text: string
}

export interface HermesImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

export type HermesContentPart = HermesTextPart | HermesImageUrlPart

export interface HermesPromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | HermesContentPart[]
}
```

- [ ] **Step 3: Implement prompt builder**

Change `buildHermesMessages` to `async` and accept:

```typescript
export interface BuildHermesMessagesOptions {
  bootstrapPrompt?: string | null
  companionUsername?: string
  loadVisionJpeg?: (visionPath: string) => Promise<Buffer>
  visionHistoryMaxBytes?: number
}
```

Algorithm:

1. Walk history chronologically; collect photo user messages with vision paths
2. Compute total bytes; while over `visionHistoryMaxBytes`, drop images from oldest photo messages first
3. For each user message with surviving images: build `[text?] + image_url parts`
4. Photo-only: omit text part
5. Text-only messages: keep string content

In `run-executor.ts`, pass `loadVisionJpeg` reading from `attachmentsDir` + stored relative paths, and `visionHistoryMaxBytes` from app options.

- [ ] **Step 4: Run tests**

Run: `cd messaging-api && npm test -- prompt-builder.test.ts messages-photo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messaging-api/src/services/prompt-builder.ts messaging-api/src/services/hermes-client.ts \
  messaging-api/src/services/run-executor.ts messaging-api/test/prompt-builder.test.ts
git commit -m "feat(messaging-api): multimodal Hermes prompt with vision history cap"
```

---

## Task 10: List, sync, and caption-only edit

**Files:**
- Modify: `messaging-api/src/routes/messages.ts`
- Modify: `messaging-api/src/routes/chat-sync.ts`
- Modify: `messaging-api/test/messages-photo.test.ts`

- [ ] **Step 1: Write failing list/sync/edit tests**

```typescript
it('lists photo messages with attachments', async () => { /* GET /messages */ })
it('includes attachments on message_upsert via thread sync', async () => { /* GET /conversations/:id/sync */ })
it('allows caption-only PATCH on photo messages', async () => {
  // send photo message, PATCH text, attachments unchanged
})
it('rejects PATCH with attachment_ids', async () => {
  // 400 edit_not_allowed or invalid_request
})
```

- [ ] **Step 2: Enrich GET list route**

In `messages.ts` GET handler, after loading messages:

```typescript
const attachmentMap = listAttachmentsForMessages(app.db, messages.map((m) => m.id))
const enriched = enrichMessagesWithAttachments(messages, attachmentMap)
```

Return `enriched` instead of raw messages (with process enrichment unchanged).

- [ ] **Step 3: Enrich sync upserts**

In `chat-sync.ts` `attachProcessToMessageUpserts`, also attach `attachments` from `listAttachmentsForMessages` for `message_upsert` payloads.

- [ ] **Step 4: Caption-only PATCH**

Extend `isMessageBody` for PATCH to reject bodies containing `attachment_ids`:

```typescript
if ('attachment_ids' in (request.body as object)) {
  return reply.code(400).send({ error: 'edit_not_allowed' })
}
```

Allow empty `text` only when message already has attachments (caption can be cleared to `""`).

- [ ] **Step 5: Run tests**

Run: `cd messaging-api && npm test -- messages-photo.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add messaging-api/src/routes/messages.ts messaging-api/src/routes/chat-sync.ts \
  messaging-api/test/messages-photo.test.ts
git commit -m "feat(messaging-api): attachment serialization on list/sync and caption edit"
```

---

## Task 11: Push preview and duplicate-message guard

**Files:**
- Modify: `messaging-api/src/lib/push-preview.ts`
- Modify: `messaging-api/src/routes/messages.ts`

- [ ] **Step 1: Write failing push preview test**

```typescript
import { describe, expect, it } from 'vitest'
import { buildChatPushAlert } from '../src/lib/push-preview.js'

it('uses Photo fallback when content is empty', () => {
  expect(buildChatPushAlert({ title: 'Chat', content: '', hasPhotos: true }).body).toBe('Photo')
})
```

- [ ] **Step 2: Implement**

Add optional `hasPhotos?: boolean` to `buildChatPushAlert`; when `content` empty and `hasPhotos`, body = `'Photo'`.

In `onAssistantMessageCommitted` path, user message push is N/A; for user-sent photo messages no push change needed. For assistant reply after photo message, unchanged.

Pass `hasPhotos` only if needed for future user-message push — skip if unused. **YAGNI:** only add if push code paths send user content previews.

- [ ] **Step 3: Commit if changed**

```bash
git add messaging-api/src/lib/push-preview.ts
git commit -m "fix(messaging-api): push preview fallback for photo-only messages"
```

Skip this task entirely if no push code path uses empty user content.

---

## Task 12: Orphan cleanup on startup

**Files:**
- Modify: `messaging-api/src/index.ts` or `app.ts`
- Modify: `messaging-api/test/message-attachments.test.ts`

- [ ] **Step 1: Write failing orphan test**

```typescript
it('deletes expired staged attachments', () => {
  const id = insertStagedAttachment(db, { /* ... */, orphanTtlHours: -1 })
  db.prepare(`UPDATE message_attachments SET expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(id)
  const deleted = deleteExpiredOrphanAttachments(db)
  expect(deleted).toContain(id)
})
```

- [ ] **Step 2: Run orphan sweep on app ready**

In `buildApp` after DB init:

```typescript
const deletedIds = deleteExpiredOrphanAttachments(app.db)
for (const id of deletedIds) {
  const row = /* fetch before delete or return paths from repo */
  removeAttachmentTree(app.attachmentsDir, row.user_id, id)
}
```

Refactor `deleteExpiredOrphanAttachments` to return `{ id, user_id }[]` for filesystem cleanup.

- [ ] **Step 3: Run tests and commit**

```bash
git add messaging-api/src/db/repos/message-attachments.ts messaging-api/src/app.ts \
  messaging-api/test/message-attachments.test.ts
git commit -m "feat(messaging-api): orphan attachment cleanup on startup"
```

---

## Task 13: Regression and docs

**Files:**
- Modify: `messaging-api/test/messages.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/README.md`
- Modify: `docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md`

- [ ] **Step 1: Run full test suite**

Run: `cd messaging-api && npm test`
Expected: all PASS

- [ ] **Step 2: Add README section**

Under messaging-api / companion features, document:

- v2.8.0 photo attachments
- env vars
- storage path `data/attachments/`
- staged upload flow
- requirement for vision-capable Hermes model

- [ ] **Step 3: Update superpowers README**

Add photo sharing entry linking spec + plan.

- [ ] **Step 4: Mark design spec approved**

Set `Status: Approved` in `2026-06-21-companion-photo-sharing-design.md`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/README.md \
  docs/superpowers/specs/2026-06-21-companion-photo-sharing-design.md
git commit -m "docs: photo sharing operator notes and approved spec"
```

---

## Verification checklist (manual)

- [ ] Upload HEIC from iOS → original on disk, thumb/vision JPEG served
- [ ] Send 10 photos + caption → all linked, Hermes request has 10 `image_url` parts
- [ ] Follow-up text message → prior images still in Hermes history
- [ ] Phone B: inbox → thread sync → thumbs download
- [ ] User A cannot download user B attachment (`404`)
- [ ] Caption PATCH → attachments unchanged, assistant reruns
- [ ] Abandoned staged upload → removed after 24h
- [ ] `npm test` green in `messaging-api`

---

## Spec coverage map

| Spec requirement | Task |
|------------------|------|
| OpenAPI v2.8.0 | Task 1 |
| `message_attachments` schema | Task 3 |
| Staged upload | Tasks 4, 5, 7 |
| Original + derivatives | Task 5 |
| User-scoped auth | Task 7 |
| Send with `attachment_ids` | Task 8 |
| Sync metadata on `message_upsert` | Task 10 |
| Multimodal Hermes history + cap | Task 9 |
| Caption-only edit | Task 10 |
| Orphan TTL | Task 12 |
| Operator docs | Task 13 |