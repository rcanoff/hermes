import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface GroupRunClaim {
  messageId: string
  conversationId: string
  runId: string
}

export function enqueueGroupRun(
  db: Database.Database,
  input: { messageId: string; conversationId: string },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO group_bot_runs (message_id, conversation_id, state, run_id)
    VALUES (?, ?, 'queued', ?)
  `).run(input.messageId, input.conversationId, randomUUID())
}

export function finishGroupRun(
  db: Database.Database,
  messageId: string,
  from: 'running' | 'queued',
  to: 'done' | 'failed' | 'stuck' | 'cancelled',
  errorCode?: string,
): boolean {
  const result = db.prepare(`
    UPDATE group_bot_runs
    SET state = ?, error_code = ?
    WHERE message_id = ? AND state = ?
  `).run(to, errorCode ?? null, messageId, from)
  return result.changes === 1
}

export function sweepStuckGroupRuns(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT message_id FROM group_bot_runs WHERE state = 'running' ORDER BY created_at ASC`)
    .all() as Array<{ message_id: string }>
  const matched: string[] = []
  for (const row of rows) {
    if (finishGroupRun(db, row.message_id, 'running', 'stuck', 'run_unconfirmed')) {
      matched.push(row.message_id)
    }
  }
  return matched
}

export function claimNextGroupRun(db: Database.Database): GroupRunClaim | undefined {
  const claim = db.transaction(() => {
    const row = db
      .prepare(`
        SELECT group_bot_runs.message_id, group_bot_runs.conversation_id, group_bot_runs.run_id
        FROM group_bot_runs
        JOIN messages ON messages.id = group_bot_runs.message_id
        WHERE group_bot_runs.state = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM group_bot_runs running
            WHERE running.conversation_id = group_bot_runs.conversation_id
              AND running.state = 'running'
          )
        ORDER BY messages.sequence ASC, group_bot_runs.created_at ASC
        LIMIT 1
      `)
      .get() as
      | { message_id: string; conversation_id: string; run_id: string }
      | undefined
    if (!row) {
      return undefined
    }
    const result = db.prepare(`
      UPDATE group_bot_runs
      SET state = 'running', claimed_at = datetime('now')
      WHERE message_id = ? AND state = 'queued'
    `).run(row.message_id)
    if (result.changes !== 1) {
      return undefined
    }
    return {
      messageId: row.message_id,
      conversationId: row.conversation_id,
      runId: row.run_id,
    }
  })
  return claim()
}
