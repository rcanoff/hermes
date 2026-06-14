import type { FastifyInstance } from 'fastify'
import { createUser } from '../../src/db/repos/users.js'
import { hashPassword } from '../../src/services/password.js'

export async function seedTestUser(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<{ id: string; username: string; token: string }> {
  const passwordHash = await hashPassword(password)
  const passwordChangedAt = new Date().toISOString()
  const user = createUser(app.db, { username, passwordHash, passwordChangedAt })
  const token = await app.jwt.sign({ sub: user.id, username: user.username })
  return { id: user.id, username: user.username, token }
}