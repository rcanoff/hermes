import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type RunStatus = 'running' | 'completed' | 'failed'

export interface RunRow {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  status: RunStatus
  error_code: string | null
  error_detail: string | null
  started_at: string
  finished_at: string | null
}

export function createRun(db: Database.Database, conversationId: string, userMessageId: string): string {
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, status)
      VALUES (?, ?, ?, 'running')
    `).run(id, conversationId, userMessageId)
  } catch (error) {
    if (isRunConflictError(error)) {
      throw new Error('run_conflict')
    }

    throw error
  }

  return id
}

export function getActiveRun(db: Database.Database, conversationId: string): RunRow | undefined {
  return db
    .prepare(`
      SELECT id, conversation_id, user_message_id, assistant_message_id, status, error_code, error_detail, started_at, finished_at
      FROM message_runs
      WHERE conversation_id = ? AND status = 'running'
    `)
    .get(conversationId) as RunRow | undefined
}

export function markRunCompleted(
  db: Database.Database,
  runId: string,
  assistantMessageId: string,
): boolean {
  const result = db.prepare(`
    UPDATE message_runs
    SET status = 'completed',
        assistant_message_id = ?,
        finished_at = datetime('now')
    WHERE id = ?
      AND status = 'running'
  `).run(assistantMessageId, runId)

  return result.changes === 1
}

export function markRunFailed(
  db: Database.Database,
  runId: string,
  errorCode: string,
  errorDetail: string,
): boolean {
  const result = db.prepare(`
    UPDATE message_runs
    SET status = 'failed',
        error_code = ?,
        error_detail = ?,
        finished_at = datetime('now')
    WHERE id = ?
      AND status = 'running'
  `).run(errorCode, errorDetail, runId)

  return result.changes === 1
}

export function deleteRunsForUserMessage(
  db: Database.Database,
  conversationId: string,
  userMessageId: string,
): void {
  db.prepare(`
    DELETE FROM message_runs
    WHERE conversation_id = ? AND user_message_id = ?
  `).run(conversationId, userMessageId)
}

function isRunConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('message_runs.conversation_id')
}
