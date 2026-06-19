import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  deletePushDevice,
  listPushDevicesByUserId,
  upsertPushDevice,
} from '../src/db/repos/push-devices.js'
import { createUser } from '../src/db/repos/users.js'
import { initSchema } from '../src/db/schema.js'

function openTestDb(): Database.Database {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

function insertTestUser(db: Database.Database, username = 'alice'): string {
  const user = createUser(db, {
    username,
    passwordHash: 'hash',
    passwordChangedAt: new Date().toISOString(),
  })
  return user.id
}

describe('push devices repo', () => {
  it('upserts by device_token and updates session_id', () => {
    const db = openTestDb()
    const userId = insertTestUser(db)
    const token = 'aa'.repeat(32)
    upsertPushDevice(db, {
      userId,
      deviceToken: token,
      environment: 'development',
      sessionId: 'sess-1',
    })
    upsertPushDevice(db, {
      userId,
      deviceToken: token,
      environment: 'development',
      sessionId: 'sess-2',
    })
    const rows = listPushDevicesByUserId(db, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.session_id).toBe('sess-2')
  })

  it('reassigns token to new user', () => {
    const db = openTestDb()
    const u1 = insertTestUser(db, 'alice')
    const u2 = insertTestUser(db, 'bob')
    const token = 'bb'.repeat(32)
    upsertPushDevice(db, {
      userId: u1,
      deviceToken: token,
      environment: 'development',
      sessionId: 's1',
    })
    upsertPushDevice(db, {
      userId: u2,
      deviceToken: token,
      environment: 'development',
      sessionId: 's2',
    })
    expect(listPushDevicesByUserId(db, u1)).toHaveLength(0)
    expect(listPushDevicesByUserId(db, u2)).toHaveLength(1)
  })

  it('deletes by device_token', () => {
    const db = openTestDb()
    const userId = insertTestUser(db)
    const token = 'cc'.repeat(32)
    upsertPushDevice(db, {
      userId,
      deviceToken: token,
      environment: 'development',
      sessionId: 's',
    })
    deletePushDevice(db, token)
    expect(listPushDevicesByUserId(db, userId)).toHaveLength(0)
  })
})