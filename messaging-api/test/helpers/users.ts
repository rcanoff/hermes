import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { ensureDefaultBotRow } from '../../src/db/repos/bots.js'
import { createUser, findUserById, type UserRow } from '../../src/db/repos/users.js'
import { hashPassword } from '../../src/services/password.js'

export function insertDbUser(
  db: Database.Database,
  username = 'operator',
  id?: string,
): UserRow {
  if (id) {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, password_changed_at)
      VALUES (?, ?, 'hash', datetime('now'))
    `).run(id, username)
    return findUserById(db, id)!
  }

  return createUser(db, {
    username,
    passwordHash: 'hash',
    passwordChangedAt: new Date().toISOString(),
  })
}

export async function seedTestUser(
  app: FastifyInstance,
  username: string,
  password: string,
  options: { seedDefaultBot?: boolean } = {},
): Promise<{ id: string; username: string; token: string; sessionId: string }> {
  const passwordHash = await hashPassword(password)
  const passwordChangedAt = new Date().toISOString()
  const user = createUser(app.db, { username, passwordHash, passwordChangedAt })
  if (options.seedDefaultBot !== false) {
    ensureDefaultBotRow(app.db, user.id)
  }
  const sessionId = randomUUID()
  const token = await app.jwt.sign({ sub: user.id, username: user.username, jti: sessionId })
  return { id: user.id, username: user.username, token, sessionId }
}