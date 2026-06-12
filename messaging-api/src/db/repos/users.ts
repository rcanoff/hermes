import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface UserRow {
  id: string
  username: string
  password_hash: string
  created_at: string
}

export function findUserByUsername(db: Database.Database, username: string): UserRow | undefined {
  return db
    .prepare(`
      SELECT id, username, password_hash, created_at
      FROM users
      WHERE username = ?
    `)
    .get(username) as UserRow | undefined
}

export function findUserById(db: Database.Database, id: string): UserRow | undefined {
  return db
    .prepare(`
      SELECT id, username, password_hash, created_at
      FROM users
      WHERE id = ?
    `)
    .get(id) as UserRow | undefined
}

export function ensureBootstrapUser(db: Database.Database, username: string, passwordHash: string): UserRow {
  const existing = findUserByUsername(db, username)
  if (existing) {
    return existing
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO users (id, username, password_hash)
    VALUES (?, ?, ?)
  `).run(id, username, passwordHash)

  return db
    .prepare(`
      SELECT id, username, password_hash, created_at
      FROM users
      WHERE id = ?
    `)
    .get(id) as UserRow
}

export function updateUserPasswordHash(db: Database.Database, id: string, passwordHash: string): void {
  db.prepare(`
    UPDATE users
    SET password_hash = ?
    WHERE id = ?
  `).run(passwordHash, id)
}
