import type Database from 'better-sqlite3'

export function ensureDeviceRegistered(
  db: Database.Database,
  userId: string,
  deviceId: string,
): void {
  db.prepare(`
    INSERT INTO device_sync_state (user_id, device_id)
    VALUES (?, ?)
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      updated_at = datetime('now')
  `).run(userId, deviceId)
}

export function getDeviceSyncCursor(
  db: Database.Database,
  userId: string,
  deviceId: string,
): string | null | undefined {
  const row = db
    .prepare(`
      SELECT last_account_event_id
      FROM device_sync_state
      WHERE user_id = ? AND device_id = ?
    `)
    .get(userId, deviceId) as { last_account_event_id: string | null } | undefined

  if (!row) {
    return undefined
  }

  return row.last_account_event_id
}

export function setDeviceSyncCursor(
  db: Database.Database,
  userId: string,
  deviceId: string,
  cursor: string,
): void {
  db.prepare(`
    UPDATE device_sync_state
    SET last_account_event_id = ?, updated_at = datetime('now')
    WHERE user_id = ? AND device_id = ?
  `).run(cursor, userId, deviceId)
}

export function isDeviceRegistered(
  db: Database.Database,
  userId: string,
  deviceId: string,
): boolean {
  const row = db
    .prepare(`SELECT 1 FROM device_sync_state WHERE user_id = ? AND device_id = ?`)
    .get(userId, deviceId) as { 1: number } | undefined

  return row !== undefined
}