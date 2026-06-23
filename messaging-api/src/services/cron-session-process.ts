import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { ToolingLine } from '../db/repos/process.js'
import { buildActivityLine, buildReasoningLine } from './tooling-line.js'

const SESSION_MATCH_TOLERANCE_SECONDS = 30

interface HermesSessionRow {
  id: string
  ended_at: number | null
}

interface HermesMessageRow {
  role: string
  tool_calls: string | null
  reasoning_content: string | null
}

interface HermesToolCall {
  function?: {
    name?: string
    arguments?: string
  }
}

export function openHermesStateDb(path: string): Database.Database | null {
  if (!path.trim() || !existsSync(path)) {
    return null
  }

  return new Database(path, { readonly: true, fileMustExist: true })
}

export function resolveCronSessionId(
  stateDb: Database.Database,
  hermesJobId: string,
  completedAt: Date,
): string | null {
  const prefix = `cron_${hermesJobId}_`
  const targetUnix = completedAt.getTime() / 1000
  const rows = stateDb
    .prepare(`
      SELECT id, ended_at
      FROM sessions
      WHERE id LIKE ?
        AND source = 'cron'
        AND ended_at IS NOT NULL
      ORDER BY ABS(ended_at - ?) ASC
      LIMIT 1
    `)
    .all(`${prefix}%`, targetUnix) as HermesSessionRow[]

  const best = rows[0]
  if (!best?.id || best.ended_at == null) {
    return null
  }

  if (Math.abs(best.ended_at - targetUnix) > SESSION_MATCH_TOLERANCE_SECONDS) {
    return null
  }

  return best.id
}

export function buildCronProcessLines(
  stateDb: Database.Database,
  sessionId: string,
): ToolingLine[] {
  const rows = stateDb
    .prepare(`
      SELECT role, tool_calls, reasoning_content
      FROM messages
      WHERE session_id = ?
        AND active = 1
      ORDER BY timestamp ASC
    `)
    .all(sessionId) as HermesMessageRow[]

  const lines: ToolingLine[] = []

  for (const row of rows) {
    if (row.role !== 'assistant') {
      continue
    }

    const reasoning = row.reasoning_content?.trim()
    if (reasoning) {
      lines.push(buildReasoningLine(reasoning))
    }

    for (const call of parseHermesToolCalls(row.tool_calls)) {
      lines.push(
        buildActivityLine({
          tool: call.name,
          argumentsJson: call.arguments,
        }),
      )
    }
  }

  return lines
}

export function loadCronRunProcessLines(input: {
  hermesStateDbPath?: string
  hermesJobId: string
  completedAt: Date
}): ToolingLine[] {
  const stateDb = input.hermesStateDbPath
    ? openHermesStateDb(input.hermesStateDbPath)
    : null
  if (!stateDb) {
    return []
  }

  try {
    const sessionId = resolveCronSessionId(stateDb, input.hermesJobId, input.completedAt)
    if (!sessionId) {
      return []
    }

    return buildCronProcessLines(stateDb, sessionId)
  } finally {
    stateDb.close()
  }
}

function parseHermesToolCalls(raw: string | null): Array<{ name: string; arguments?: string }> {
  if (!raw?.trim()) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const calls: Array<{ name: string; arguments?: string }> = []
  for (const item of parsed) {
    const call = item as HermesToolCall
    const name = call.function?.name?.trim()
    if (!name) {
      continue
    }

    calls.push({
      name,
      arguments: call.function?.arguments,
    })
  }

  return calls
}