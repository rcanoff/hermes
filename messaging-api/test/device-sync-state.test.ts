import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../src/db/schema.js'
import {
  ensureDeviceRegistered,
  getDeviceSyncCursor,
  setDeviceSyncCursor,
} from '../src/db/repos/device-sync-state.js'

describe('device-sync-state repo', () => {
  it('ensureDeviceRegistered creates row without cursor', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const deviceId = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)

    ensureDeviceRegistered(db, userId, deviceId)

    expect(getDeviceSyncCursor(db, userId, deviceId)).toBeNull()
  })

  it('ensureDeviceRegistered is idempotent and preserves cursor', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const userId = randomUUID()
    const deviceId = randomUUID()
    const cursor = randomUUID()
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'u', 'h')`).run(userId)

    ensureDeviceRegistered(db, userId, deviceId)
    setDeviceSyncCursor(db, userId, deviceId, cursor)
    ensureDeviceRegistered(db, userId, deviceId)

    expect(getDeviceSyncCursor(db, userId, deviceId)).toBe(cursor)
  })

  it('getDeviceSyncCursor returns undefined for unknown device', () => {
    const db = new Database(':memory:')
    initSchema(db)
    expect(getDeviceSyncCursor(db, randomUUID(), randomUUID())).toBeUndefined()
  })
})