import type Database from 'better-sqlite3'

export function listConversationMemberIds(db: Database.Database, conversationId: string): string[] {
  const rows = db
    .prepare(`
      SELECT user_id
      FROM conversation_members
      WHERE conversation_id = ?
      ORDER BY joined_at ASC, user_id ASC
    `)
    .all(conversationId) as Array<{ user_id: string }>
  return rows.map((row) => row.user_id)
}

export function addConversationMembers(
  db: Database.Database,
  conversationId: string,
  userIds: string[],
  joinedAt: string,
): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at)
    VALUES (?, ?, ?)
  `)
  for (const userId of userIds) {
    insert.run(conversationId, userId, joinedAt)
  }
}

export function isConversationMember(
  db: Database.Database,
  conversationId: string,
  userId: string,
): boolean {
  const row = db
    .prepare(`
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = ? AND user_id = ?
    `)
    .get(conversationId, userId) as { 1: number } | undefined
  return row !== undefined
}
