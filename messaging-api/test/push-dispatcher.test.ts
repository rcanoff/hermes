import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { upsertPushDevice } from '../src/db/repos/push-devices.js'
import { createUser } from '../src/db/repos/users.js'
import { initSchema } from '../src/db/schema.js'
import {
  notifyCommittedAssistantMessage,
  notifyCommittedCronMessage,
} from '../src/services/push-dispatcher.js'
import { StreamHub } from '../src/streams/hub.js'
import {
  createRecordingApnsClient,
  disabledApnsConfig,
  enabledApnsConfig,
} from './helpers/apns.js'
import type { ApnsSendInput } from '../src/services/apns-client.js'

function openTestDb(): Database.Database {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

function seedUser(db: Database.Database): string {
  return createUser(db, {
    username: 'alice',
    passwordHash: 'hash',
    passwordChangedAt: new Date().toISOString(),
  }).id
}

describe('push dispatcher', () => {
  it('skips any device whose session_id has active SSE', async () => {
    const db = openTestDb()
    const userId = seedUser(db)
    const onlineToken = '11'.repeat(32)
    const offlineToken = '22'.repeat(32)
    upsertPushDevice(db, {
      userId,
      deviceToken: onlineToken,
      environment: 'development',
      sessionId: 'sess-online',
    })
    upsertPushDevice(db, {
      userId,
      deviceToken: offlineToken,
      environment: 'development',
      sessionId: 'sess-offline',
    })

    const sends: ApnsSendInput[] = []
    const hub = new StreamHub()
    hub.subscribeSession('sess-online', () => {})

    await notifyCommittedAssistantMessage({
      db,
      hub,
      apns: createRecordingApnsClient(sends),
      config: enabledApnsConfig(),
      userId,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      content: 'Hello',
      conversationTitle: 'Chat',
    })

    expect(sends).toHaveLength(1)
    expect(sends[0]?.deviceToken).toBe(offlineToken)
  })

  it('cron payload uses destination jobs and Job title', async () => {
    const db = openTestDb()
    const userId = seedUser(db)
    upsertPushDevice(db, {
      userId,
      deviceToken: '33'.repeat(32),
      environment: 'development',
      sessionId: 'sess-1',
    })

    const sends: ApnsSendInput[] = []
    await notifyCommittedCronMessage({
      db,
      hub: new StreamHub(),
      apns: createRecordingApnsClient(sends),
      config: enabledApnsConfig(),
      userId,
      conversationId: 'job-conv',
      messageId: 'msg-2',
      content: 'Gate open',
      conversationTitle: null,
      scheduleDisplay: 'every 30m',
    })

    expect(sends).toHaveLength(1)
    const payload = sends[0]!.payload as {
      aps: { alert: { title: string } }
      companion: { destination: string; kind: string }
    }
    expect(payload.companion).toMatchObject({ destination: 'jobs', kind: 'cron_run' })
    expect(payload.aps.alert.title).toMatch(/^Job · /)
  })

  it('no-ops when APNS_ENABLED false', async () => {
    const db = openTestDb()
    const userId = seedUser(db)
    upsertPushDevice(db, {
      userId,
      deviceToken: '44'.repeat(32),
      environment: 'development',
      sessionId: 'sess-1',
    })

    const sends: ApnsSendInput[] = []
    await notifyCommittedAssistantMessage({
      db,
      hub: new StreamHub(),
      apns: createRecordingApnsClient(sends),
      config: disabledApnsConfig(),
      userId,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      content: 'Hello',
      conversationTitle: 'Chat',
    })

    expect(sends).toHaveLength(0)
  })
})