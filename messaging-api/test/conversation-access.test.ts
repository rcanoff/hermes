import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { appendAccountConversationUpsert } from '../src/db/repos/chat-sync-events.js'
import { addConversationMembers } from '../src/db/repos/conversation-members.js'
import { insertStagedAttachment } from '../src/db/repos/message-attachments.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { ensureDir, resolveAttachmentFile } from '../src/lib/attachment-storage.js'
import { SYNC_MARKER_ORIGIN } from '../src/lib/sync-marker.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('conversation membership access', () => {
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lets a member read a group and hides it from a non-member', async () => {
    const owner = await seedTestUser(app!, 'owner', 'password123')
    const member = await seedTestUser(app!, 'member', 'password123')
    const stranger = await seedTestUser(app!, 'stranger', 'password123')
    const groupId = seedGroup(app!, owner.id, member.id)

    const allowed = await app!.inject({
      method: 'GET',
      url: `/conversations/${groupId}`,
      headers: { authorization: `Bearer ${member.token}` },
    })
    const denied = await app!.inject({
      method: 'GET',
      url: `/conversations/${groupId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    })

    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toMatchObject({ id: groupId, kind: 'group' })
    expect(denied.statusCode).toBe(404)
  })

  it('omits a group from the inbox unless include_shared=true', async () => {
    const owner = await seedTestUser(app!, 'owner', 'password123')
    const member = await seedTestUser(app!, 'member', 'password123')
    const groupId = seedGroup(app!, owner.id, member.id)
    const deviceId = randomUUID()

    await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${member.token}` },
      payload: { device_id: deviceId },
    })

    appendAccountConversationUpsert(app!.db, member.id, groupId, {
      id: groupId,
      hermes_session_id: randomUUID(),
      kind: 'group',
      title: 'Group',
      model: 'gpt-5.4',
      provider: 'openai',
      model_display: 'GPT-5.4',
      created_at: '2026-09-22 00:00:00',
      updated_at: '2026-09-22 00:00:00',
      latest_message_id: null,
      latest_message_created_at: null,
      bot_id: null,
    })

    const hidden = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}&since=${SYNC_MARKER_ORIGIN}`,
      headers: { authorization: `Bearer ${member.token}` },
    })
    const shown = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}&since=${SYNC_MARKER_ORIGIN}&include_shared=true`,
      headers: { authorization: `Bearer ${member.token}` },
    })

    expect(hidden.statusCode).toBe(200)
    expect(hidden.json().changes).toEqual([])
    expect(shown.statusCode).toBe(200)
    expect(shown.json().changes).toEqual([{ conversation_id: groupId, kind: 'updated' }])
  })

  it('serves a linked attachment to the other member only, and an unlinked file to the uploader only', async () => {
    const owner = await seedTestUser(app!, 'owner', 'password123')
    const member = await seedTestUser(app!, 'member', 'password123')
    const stranger = await seedTestUser(app!, 'stranger', 'password123')
    const groupId = seedGroup(app!, owner.id, member.id)
    const body = Buffer.from('shared-bytes')
    const linkedId = stageAttachment(app!, owner.id, body)
    const messageId = insertMessage(app!.db, {
      conversationId: groupId,
      role: 'user',
      content: 'photo',
    })
    app!.db
      .prepare(`UPDATE message_attachments SET message_id = ?, expires_at = NULL WHERE id = ?`)
      .run(messageId, linkedId)

    const unlinkedBody = Buffer.from('private-bytes')
    const unlinkedId = stageAttachment(app!, owner.id, unlinkedBody)

    const memberLinked = await app!.inject({
      method: 'GET',
      url: `/attachments/${linkedId}`,
      headers: { authorization: `Bearer ${member.token}` },
    })
    const strangerLinked = await app!.inject({
      method: 'GET',
      url: `/attachments/${linkedId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    })
    const memberUnlinked = await app!.inject({
      method: 'GET',
      url: `/attachments/${unlinkedId}`,
      headers: { authorization: `Bearer ${member.token}` },
    })
    const ownerUnlinked = await app!.inject({
      method: 'GET',
      url: `/attachments/${unlinkedId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    })

    expect(memberLinked.statusCode).toBe(200)
    expect(Buffer.from(memberLinked.rawPayload)).toEqual(body)
    expect(strangerLinked.statusCode).toBe(404)
    expect(memberUnlinked.statusCode).toBe(404)
    expect(ownerUnlinked.statusCode).toBe(200)
    expect(Buffer.from(ownerUnlinked.rawPayload)).toEqual(unlinkedBody)
  })
})

function seedGroup(app: FastifyInstance, ownerId: string, memberId: string): string {
  const id = randomUUID()
  app.db
    .prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, title, updated_at)
      VALUES (?, ?, ?, 'group', 'Group', datetime('now'))
    `)
    .run(id, ownerId, randomUUID())
  addConversationMembers(app.db, id, [memberId], '2026-09-22 00:00:00')
  return id
}

function stageAttachment(app: FastifyInstance, userId: string, body: Buffer): string {
  const id = insertStagedAttachment(app.db, {
    userId,
    contentType: 'text/plain',
    byteSize: body.byteLength,
    width: null,
    height: null,
    originalPath: 'original.txt',
    thumbPath: '',
    visionPath: '',
    orphanTtlHours: 24,
  })
  const dir = resolveAttachmentFile(app.attachmentsDir, userId, id, 'original.txt')
  ensureDir(dir.slice(0, dir.lastIndexOf('/')))
  fs.writeFileSync(dir, body)
  return id
}
