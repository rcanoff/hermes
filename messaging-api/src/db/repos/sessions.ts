import type Database from 'better-sqlite3'

export interface DeniedSessionInput {
  id: string
  userId: string
  token: string
  expiresAt: string
}

export function denyToken(db: Database.Database, session: DeniedSessionInput): void {
  db.prepare(`
    INSERT INTO sessions (id, user_id, token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(session.id, session.userId, session.token, session.expiresAt)
}

export function isTokenDenied(db: Database.Database, token: string): boolean {
  const row = db
    .prepare(`
      SELECT 1
      FROM sessions
      WHERE token = ?
        AND datetime(expires_at) > datetime('now')
      LIMIT 1
    `)
    .get(token)

  return Boolean(row)
}
