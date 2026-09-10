import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type RunStatus = 'running' | 'completed' | 'failed'

export interface RunRow {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  origin_session_id: string
  status: RunStatus
  error_code: string | null
  error_detail: string | null
  started_at: string
  finished_at: string | null
}

export function createRun(
  db: Database.Database,
  conversationId: string,
  userMessageId: string,
  originSessionId: string,
): string {
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, origin_session_id, status)
      VALUES (?, ?, ?, ?, 'running')
    `).run(id, conversationId, userMessageId, originSessionId)
  } catch (error) {
    if (isRunConflictError(error)) {
      throw new Error('run_conflict')
    }

    throw error
  }

  return id
}

const RUN_COLUMNS = `
  id, conversation_id, user_message_id, assistant_message_id, origin_session_id,
  status, error_code, error_detail, started_at, finished_at
`

export function getRunById(db: Database.Database, runId: string): RunRow | undefined {
  return db
    .prepare(`
      SELECT ${RUN_COLUMNS}
      FROM message_runs
      WHERE id = ?
    `)
    .get(runId) as RunRow | undefined
}

export function getLatestRunForConversation(
  db: Database.Database,
  conversationId: string,
): RunRow | undefined {
  return db
    .prepare(`
      SELECT ${RUN_COLUMNS}
      FROM message_runs
      WHERE conversation_id = ?
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `)
    .get(conversationId) as RunRow | undefined
}

export function getActiveRun(db: Database.Database, conversationId: string): RunRow | undefined {
  return db
    .prepare(`
      SELECT ${RUN_COLUMNS}
      FROM message_runs
      WHERE conversation_id = ? AND status = 'running'
    `)
    .get(conversationId) as RunRow | undefined
}

export function getLatestRunningRunForUser(
  db: Database.Database,
  userId: string,
): RunRow | undefined {
  return db
    .prepare(`
      SELECT
        message_runs.id,
        message_runs.conversation_id,
        message_runs.user_message_id,
        message_runs.assistant_message_id,
        message_runs.origin_session_id,
        message_runs.status,
        message_runs.error_code,
        message_runs.error_detail,
        message_runs.started_at,
        message_runs.finished_at
      FROM message_runs
      JOIN conversations ON conversations.id = message_runs.conversation_id
      WHERE conversations.user_id = ?
        AND message_runs.status = 'running'
      ORDER BY message_runs.started_at DESC, message_runs.id DESC
      LIMIT 1
    `)
    .get(userId) as RunRow | undefined
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

export function markRunRecovered(
  db: Database.Database,
  runId: string,
  assistantMessageId: string,
): boolean {
  const result = db.prepare(`
    UPDATE message_runs
    SET status = 'completed',
        assistant_message_id = ?,
        error_code = NULL,
        error_detail = NULL,
        finished_at = datetime('now')
    WHERE id = ?
      AND status = 'failed'
      AND assistant_message_id IS NULL
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
