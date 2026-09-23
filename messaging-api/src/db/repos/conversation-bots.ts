import type Database from 'better-sqlite3'

const MAX_GROUP_BOTS = 6

export function listConversationBotIds(db: Database.Database, conversationId: string): string[] {
  const rows = db
    .prepare(`
      SELECT bot_id
      FROM conversation_bots
      WHERE conversation_id = ?
      ORDER BY bot_id ASC
    `)
    .all(conversationId) as Array<{ bot_id: string }>
  return rows.map((row) => row.bot_id)
}

export function replaceConversationBots(
  db: Database.Database,
  conversationId: string,
  botIds: string[],
): void {
  if (botIds.length > MAX_GROUP_BOTS) {
    throw new Error('bot_cap')
  }

  const replace = db.transaction(() => {
    if (botIds.length === 0) {
      db.prepare(`DELETE FROM conversation_bots WHERE conversation_id = ?`).run(conversationId)
    } else {
      const placeholders = botIds.map(() => '?').join(', ')
      db.prepare(`
        DELETE FROM conversation_bots
        WHERE conversation_id = ? AND bot_id NOT IN (${placeholders})
      `).run(conversationId, ...botIds)
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO conversation_bots (conversation_id, bot_id)
      VALUES (?, ?)
    `)
    for (const botId of botIds) {
      insert.run(conversationId, botId)
    }
  })
  replace()
}
