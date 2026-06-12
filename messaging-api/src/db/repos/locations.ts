import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface ConversationLocationInput {
  conversationId: string
  lat: number
  lon: number
  accuracyM: number
  timestamp: string
  mode: string
  source: string
}

export interface ConversationLocationRow {
  id: string
  conversation_id: string
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
  mode: string
  source: string
  updated_at: string
}

export function upsertConversationLocation(
  db: Database.Database,
  input: ConversationLocationInput,
): void {
  const existing = db
    .prepare(`
      SELECT id
      FROM conversation_locations
      WHERE conversation_id = ?
    `)
    .get(input.conversationId) as { id: string } | undefined

  db.prepare(`
    INSERT INTO conversation_locations (
      id,
      conversation_id,
      lat,
      lon,
      accuracy_m,
      timestamp,
      mode,
      source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      lat = excluded.lat,
      lon = excluded.lon,
      accuracy_m = excluded.accuracy_m,
      timestamp = excluded.timestamp,
      mode = excluded.mode,
      source = excluded.source,
      updated_at = datetime('now')
  `).run(
    existing?.id ?? randomUUID(),
    input.conversationId,
    input.lat,
    input.lon,
    input.accuracyM,
    input.timestamp,
    input.mode,
    input.source,
  )
}

export function getConversationLocation(
  db: Database.Database,
  conversationId: string,
): ConversationLocationRow | undefined {
  return db
    .prepare(`
      SELECT id, conversation_id, lat, lon, accuracy_m, timestamp, mode, source, updated_at
      FROM conversation_locations
      WHERE conversation_id = ?
    `)
    .get(conversationId) as ConversationLocationRow | undefined
}

export function deleteConversationLocation(db: Database.Database, conversationId: string): void {
  db.prepare(`
    DELETE FROM conversation_locations
    WHERE conversation_id = ?
  `).run(conversationId)
}
