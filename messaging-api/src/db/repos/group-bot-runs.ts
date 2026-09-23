import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface GroupRunClaim {
  messageId: string
  botId: string
  conversationId: string
  runId: string
}

export interface GroupRunKey {
  messageId: string
  botId: string
}

export function enqueueGroupRun(
  db: Database.Database,
  input: { messageId: string; conversationId: string; botId: string },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO group_bot_runs (message_id, bot_id, conversation_id, state, run_id)
    VALUES (?, ?, ?, 'queued', ?)
  `).run(input.messageId, input.botId, input.conversationId, randomUUID())
}

export function cancelQueuedGroupRunsForBot(
  db: Database.Database,
  conversationId: string,
  botId: string,
): void {
  db.prepare(`
    UPDATE group_bot_runs
    SET state = 'cancelled'
    WHERE conversation_id = ? AND bot_id = ? AND state = 'queued'
  `).run(conversationId, botId)
}

export function finishGroupRun(
  db: Database.Database,
  messageId: string,
  botId: string,
  from: 'running' | 'queued',
  to: 'done' | 'failed' | 'stuck' | 'cancelled',
  errorCode?: string,
): boolean {
  const result = db.prepare(`
    UPDATE group_bot_runs
    SET state = ?, error_code = ?
    WHERE message_id = ? AND bot_id = ? AND state = ?
  `).run(to, errorCode ?? null, messageId, botId, from)
  return result.changes === 1
}

export function sweepStuckGroupRuns(db: Database.Database): GroupRunKey[] {
  const rows = db
    .prepare(`
      SELECT message_id, bot_id
      FROM group_bot_runs
      WHERE state = 'running'
      ORDER BY created_at ASC
    `)
    .all() as Array<{ message_id: string; bot_id: string }>
  const matched: GroupRunKey[] = []
  for (const row of rows) {
    if (finishGroupRun(db, row.message_id, row.bot_id, 'running', 'stuck', 'run_unconfirmed')) {
      matched.push({ messageId: row.message_id, botId: row.bot_id })
    }
  }
  return matched
}

export function claimReadyGroupRuns(db: Database.Database): GroupRunClaim[] {
  return claimRows(db)
}

export function claimNextGroupRun(db: Database.Database): GroupRunClaim | undefined {
  return claimRows(db, 1)[0]
}

function claimRows(db: Database.Database, limit?: number): GroupRunClaim[] {
  const claim = db.transaction(() => {
    const rows = db
      .prepare(`
        SELECT group_bot_runs.message_id, group_bot_runs.bot_id,
               group_bot_runs.conversation_id, group_bot_runs.run_id
        FROM group_bot_runs
        JOIN messages ON messages.id = group_bot_runs.message_id
        WHERE group_bot_runs.state = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM group_bot_runs running
            WHERE running.conversation_id = group_bot_runs.conversation_id
              AND running.bot_id = group_bot_runs.bot_id
              AND running.state = 'running'
          )
        ORDER BY messages.sequence ASC, group_bot_runs.created_at ASC
        ${limit === undefined ? '' : 'LIMIT ?'}
      `)
      .all(...(limit === undefined ? [] : [limit])) as Array<{
      message_id: string
      bot_id: string
      conversation_id: string
      run_id: string
    }>
    const update = db.prepare(`
      UPDATE group_bot_runs
      SET state = 'running', claimed_at = datetime('now')
      WHERE message_id = ? AND bot_id = ? AND state = 'queued'
    `)
    const claims: GroupRunClaim[] = []
    const claimedPairs = new Set<string>()
    for (const row of rows) {
      const pair = `${row.conversation_id}:${row.bot_id}`
      if (claimedPairs.has(pair)) {
        continue
      }
      const result = update.run(row.message_id, row.bot_id)
      if (result.changes !== 1) {
        continue
      }
      claimedPairs.add(pair)
      claims.push({
        messageId: row.message_id,
        botId: row.bot_id,
        conversationId: row.conversation_id,
        runId: row.run_id,
      })
    }
    return claims
  })
  return claim()
}
