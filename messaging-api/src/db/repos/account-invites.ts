import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type InviteType = 'activation' | 'password_reset'

export interface AccountInviteRow {
  id: string
  token_hash: string
  type: InviteType
  label: string | null
  user_id: string | null
  revoked_at: string | null
  expires_at: string
  used_at: string | null
  created_at: string
}

export interface CreateInviteInput {
  tokenHash: string
  type: InviteType
  label?: string | null
  userId?: string | null
  expiresAt: string
}

export function insertInvite(db: Database.Database, input: CreateInviteInput): AccountInviteRow {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO account_invites (id, token_hash, type, label, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.tokenHash, input.type, input.label ?? null, input.userId ?? null, input.expiresAt)

  return getInviteById(db, id)!
}

export function getInviteById(db: Database.Database, id: string): AccountInviteRow | undefined {
  return db.prepare(`SELECT * FROM account_invites WHERE id = ?`).get(id) as AccountInviteRow | undefined
}

export function getInviteByTokenHash(db: Database.Database, tokenHash: string): AccountInviteRow | undefined {
  return db
    .prepare(`SELECT * FROM account_invites WHERE token_hash = ?`)
    .get(tokenHash) as AccountInviteRow | undefined
}

export function markInviteUsed(db: Database.Database, id: string): void {
  db.prepare(`
    UPDATE account_invites
    SET used_at = datetime('now')
    WHERE id = ?
  `).run(id)
}

export function revokeInvite(db: Database.Database, id: string): boolean {
  const result = db.prepare(`
    UPDATE account_invites
    SET revoked_at = datetime('now')
    WHERE id = ?
      AND used_at IS NULL
      AND revoked_at IS NULL
  `).run(id)
  return result.changes > 0
}

export function listPendingInvites(db: Database.Database): AccountInviteRow[] {
  return db
    .prepare(`
      SELECT * FROM account_invites
      WHERE used_at IS NULL
        AND revoked_at IS NULL
        AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC
    `)
    .all() as AccountInviteRow[]
}

export function listUsers(db: Database.Database): Array<{ id: string; username: string; created_at: string }> {
  return db
    .prepare(`
      SELECT id, username, created_at
      FROM users
      ORDER BY created_at ASC
    `)
    .all() as Array<{ id: string; username: string; created_at: string }>
}