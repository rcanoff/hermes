import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('sync inbox routes', () => {
  let app: FastifyInstance | undefined
  let token: string
  let deviceId: string
  let conversationId: string

  beforeEach(async () => {
    app = await createTestApp({ syncInboxMaxGap: 500 })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    token = seeded.token
    deviceId = randomUUID()

    const created = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${token}` },
    })
    conversationId = (created.json() as { id: string }).id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('PUT /devices/me registers device', async () => {
    const response = await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: deviceId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('GET /sync/inbox rejects unregistered device', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid_request' })
  })

  it('GET /sync/inbox returns reset_required on first poll', async () => {
    await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: deviceId },
    })

    const response = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      changes: [],
      reset_required: true,
      has_more: false,
    })
  })

  it('GET /sync/inbox returns deleted after conversation delete on other cursor', async () => {
    await app!.inject({
      method: 'PUT',
      url: '/devices/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { device_id: deviceId },
    })

    const accountSync = await app!.inject({
      method: 'GET',
      url: '/conversations/sync',
      headers: { authorization: `Bearer ${token}` },
    })
    const marker = (accountSync.json() as { next_sync_marker: string }).next_sync_marker

    await app!.db
      .prepare(`UPDATE device_sync_state SET last_account_event_id = ? WHERE device_id = ?`)
      .run(marker, deviceId)

    await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    const inbox = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(inbox.statusCode).toBe(200)
    expect(inbox.json()).toMatchObject({
      reset_required: false,
      changes: [{ conversation_id: conversationId, kind: 'deleted' }],
    })
  })

  it('isolates cursors per device for same user', async () => {
    const deviceB = randomUUID()

    for (const id of [deviceId, deviceB]) {
      await app!.inject({
        method: 'PUT',
        url: '/devices/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { device_id: id },
      })
    }

    const tip = (
      await app!.inject({
        method: 'GET',
        url: '/conversations/sync',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json() as { next_sync_marker: string }

    await app!.db
      .prepare(`UPDATE device_sync_state SET last_account_event_id = ? WHERE device_id = ?`)
      .run(tip.next_sync_marker, deviceId)

    await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    const inboxA = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const inboxB = await app!.inject({
      method: 'GET',
      url: `/sync/inbox?device_id=${deviceB}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(inboxA.json().changes).toEqual([{ conversation_id: conversationId, kind: 'deleted' }])
    expect(inboxB.json()).toMatchObject({ reset_required: true, changes: [] })
  })
})