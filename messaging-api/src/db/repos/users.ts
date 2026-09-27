import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface UserRow {
  id: string
  username: string
  password_hash: string
  password_changed_at: string | null
  created_at: string
}

export type ListedUser = {
  id: string
  username: string
  ble_public_key: string | null
  online: boolean
  last_seen_at: string | null
}

export function listUsersExcept(
  db: Database.Database,
  callerId: string,
  isOnline: (userId: string) => boolean,
): ListedUser[] {
  const rows = db
    .prepare(`
      SELECT id, username, ble_public_key, last_seen_at
      FROM users
      WHERE id != ?
      ORDER BY username ASC
    `)
    .all(callerId) as Array<Omit<ListedUser, 'online'>>
  return rows.map((row) => ({ ...row, online: isOnline(row.id) }))
}

export function touchUserLastSeen(db: Database.Database, id: string, at: string): void {
  db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(at, id)
}

export function findUserByUsername(db: Database.Database, username: string): UserRow | undefined {
  return db
    .prepare(`
      SELECT id, username, password_hash, password_changed_at, created_at
      FROM users
      WHERE username = ?
    `)
    .get(username) as UserRow | undefined
}

export function findUserById(db: Database.Database, id: string): UserRow | undefined {
  return db
    .prepare(`
      SELECT id, username, password_hash, password_changed_at, created_at
      FROM users
      WHERE id = ?
    `)
    .get(id) as UserRow | undefined
}

export function createUser(
  db: Database.Database,
  input: { username: string; passwordHash: string; passwordChangedAt: string },
): UserRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO users (id, username, password_hash, password_changed_at)
    VALUES (?, ?, ?, ?)
  `).run(id, input.username, input.passwordHash, input.passwordChangedAt)

  return findUserById(db, id)!
}

export function updateUserPassword(
  db: Database.Database,
  id: string,
  passwordHash: string,
  passwordChangedAt: string,
): void {
  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_changed_at = ?
    WHERE id = ?
  `).run(passwordHash, passwordChangedAt, id)
}

