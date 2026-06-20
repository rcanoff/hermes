import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type ToolingPhase = 'reasoning' | 'activity' | 'status'

export interface ToolingLine {
  phase: ToolingPhase
  text: string
  tool?: string | null
  args?: Record<string, unknown> | null
}

/** @deprecated alias — same shape as ToolingLine */
export type ProcessLine = ToolingLine

export interface MessageProcess {
  lines: ToolingLine[]
}

export function insertMessageProcess(
  db: Database.Database,
  input: {
    assistantMessageId: string
    conversationId: string
    lines: ToolingLine[]
  },
): void {
  db.prepare(`
    INSERT INTO message_process (id, assistant_message_id, conversation_id, lines_json)
    VALUES (?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.assistantMessageId,
    input.conversationId,
    JSON.stringify(input.lines),
  )
}

export function getProcessByAssistantMessageIds(
  db: Database.Database,
  assistantMessageIds: string[],
): Map<string, MessageProcess> {
  if (assistantMessageIds.length === 0) {
    return new Map()
  }

  const placeholders = assistantMessageIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT assistant_message_id, lines_json
      FROM message_process
      WHERE assistant_message_id IN (${placeholders})
    `)
    .all(...assistantMessageIds) as Array<{ assistant_message_id: string; lines_json: string }>

  const map = new Map<string, MessageProcess>()
  for (const row of rows) {
    map.set(row.assistant_message_id, {
      lines: JSON.parse(row.lines_json) as ToolingLine[],
    })
  }

  return map
}