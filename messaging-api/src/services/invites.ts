import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  getInviteByTokenHash,
  insertInvite,
  type AccountInviteRow,
  type InviteType,
} from '../db/repos/account-invites.js'

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function buildInviteUrl(host: string, rawToken: string): string {
  return `http://${host}/invite/${rawToken}`
}

export function isUsernameValid(username: string): boolean {
  return USERNAME_PATTERN.test(username)
}

export function validatePassword(password: string, minLength: number): { ok: true } | { ok: false } {
  if (password.length < minLength) {
    return { ok: false }
  }
  return { ok: true }
}

export type InviteLookupResult =
  | { valid: true; invite: AccountInviteRow }
  | { valid: false; reason: 'expired' | 'used' | 'not_found' | 'revoked' }

export function lookupInviteByRawToken(db: Database.Database, rawToken: string): InviteLookupResult {
  const invite = getInviteByTokenHash(db, hashInviteToken(rawToken))
  if (!invite) {
    return { valid: false, reason: 'not_found' }
  }
  if (invite.revoked_at) {
    return { valid: false, reason: 'revoked' }
  }
  if (invite.used_at) {
    return { valid: false, reason: 'used' }
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { valid: false, reason: 'expired' }
  }
  return { valid: true, invite }
}

export function createInviteRecord(
  db: Database.Database,
  input: {
    type: InviteType
    label?: string
    userId?: string
    expiryHours: number
  },
): { invite: AccountInviteRow; rawToken: string; expiresAt: string } {
  const rawToken = generateInviteToken()
  const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000).toISOString()
  const invite = insertInvite(db, {
    tokenHash: hashInviteToken(rawToken),
    type: input.type,
    label: input.label,
    userId: input.userId,
    expiresAt,
  })
  return { invite, rawToken, expiresAt }
}