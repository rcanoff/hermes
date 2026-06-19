import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface PushDeviceRow {
  id: string
  user_id: string
  device_token: string
  platform: 'ios'
  environment: 'development' | 'production'
  session_id: string | null
}

export function upsertPushDevice(
  db: Database.Database,
  input: {
    userId: string
    deviceToken: string
    environment: 'development' | 'production'
    sessionId: string | null
  },
): void {
  const existing = db
    .prepare(`SELECT id FROM push_devices WHERE device_token = ?`)
    .get(input.deviceToken) as { id: string } | undefined

  if (existing) {
    db.prepare(`
      UPDATE push_devices
      SET user_id = ?, environment = ?, session_id = ?, updated_at = datetime('now')
      WHERE device_token = ?
    `).run(input.userId, input.environment, input.sessionId, input.deviceToken)
    return
  }

  db.prepare(`
    INSERT INTO push_devices (id, user_id, device_token, environment, session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), input.userId, input.deviceToken, input.environment, input.sessionId)
}

export function deletePushDevice(db: Database.Database, deviceToken: string): void {
  db.prepare(`DELETE FROM push_devices WHERE device_token = ?`).run(deviceToken)
}

export function deletePushDeviceById(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM push_devices WHERE id = ?`).run(id)
}

export function listPushDevicesByUserId(db: Database.Database, userId: string): PushDeviceRow[] {
  return db
    .prepare(`
      SELECT id, user_id, device_token, platform, environment, session_id
      FROM push_devices
      WHERE user_id = ?
    `)
    .all(userId) as PushDeviceRow[]
}