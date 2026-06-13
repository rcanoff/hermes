import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface LocationEventInput {
  userId: string
  lat: number
  lon: number
  accuracyM: number
  timestamp: string
  trigger: string
  source: string
  address?: string
}

export interface LocationEventRow {
  id: string
  user_id: string
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
  trigger: string
  source: string
  address: string | null
  address_source: string | null
  address_status: string
  created_at: string
}

export function insertLocationEvent(db: Database.Database, input: LocationEventInput): LocationEventRow {
  const id = randomUUID()
  const hasAddress = typeof input.address === 'string' && input.address.trim().length > 0

  db.prepare(`
    INSERT INTO location_events (
      id, user_id, lat, lon, accuracy_m, timestamp, trigger, source,
      address, address_source, address_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.lat,
    input.lon,
    input.accuracyM,
    input.timestamp,
    input.trigger,
    input.source,
    hasAddress ? input.address!.trim() : null,
    hasAddress ? 'ios' : null,
    hasAddress ? 'resolved' : 'pending',
  )

  return getLocationEventById(db, id)!
}

export function getLocationEventById(db: Database.Database, id: string): LocationEventRow | undefined {
  return db.prepare(`SELECT * FROM location_events WHERE id = ?`).get(id) as LocationEventRow | undefined
}

export function getLatestLocationEvent(db: Database.Database, userId: string): LocationEventRow | undefined {
  return db
    .prepare(`
      SELECT * FROM location_events
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `)
    .get(userId) as LocationEventRow | undefined
}

export function listLocationEvents(
  db: Database.Database,
  userId: string,
  limit: number,
  beforeId?: string,
): LocationEventRow[] {
  if (beforeId) {
    const cursor = getLocationEventById(db, beforeId)
    if (!cursor) return []
    return db
      .prepare(`
        SELECT * FROM location_events
        WHERE user_id = ? AND timestamp < ?
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .all(userId, cursor.timestamp, limit) as LocationEventRow[]
  }

  return db
    .prepare(`
      SELECT * FROM location_events
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    .all(userId, limit) as LocationEventRow[]
}

export function updateLocationEventAddress(
  db: Database.Database,
  id: string,
  address: string,
  addressSource: 'server',
  addressStatus: 'resolved' | 'failed',
): void {
  db.prepare(`
    UPDATE location_events
    SET address = ?, address_source = ?, address_status = ?
    WHERE id = ?
  `).run(address, addressSource, addressStatus, id)
}