import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'

const SESSION_SOURCE = 'api_server'

export function openHermesStateDbRw(path: string): Database.Database | null {
  if (!path.trim()) {
    return null
  }

  if (!existsSync(path)) {
    return new Database(path)
  }

  return new Database(path, { fileMustExist: true })
}

export interface UpsertCompanionSessionInput {
  sessionId: string
  model: string
  provider: string
  systemPrompt?: string | null
}

export interface UpdateSessionModelInput {
  sessionId: string
  model: string
  provider: string
}

export function upsertCompanionSession(
  db: Database.Database,
  input: UpsertCompanionSessionInput,
): void {
  const existing = db
    .prepare('SELECT id FROM sessions WHERE id = ?')
    .get(input.sessionId) as { id: string } | undefined

  if (!existing) {
    db.prepare(
      `INSERT INTO sessions (id, source, model, model_config, system_prompt, started_at)
       VALUES (?, ?, ?, json_object('companion_provider', ?), ?, ?)`,
    ).run(
      input.sessionId,
      SESSION_SOURCE,
      input.model,
      input.provider,
      input.systemPrompt?.trim() || null,
      Date.now() / 1000,
    )
    return
  }

  const assignments = [
    'model = ?',
    "model_config = json_set(COALESCE(model_config, '{}'), '$.companion_provider', ?)",
  ]
  const params: unknown[] = [input.model, input.provider]

  const systemPrompt = input.systemPrompt?.trim()
  if (systemPrompt) {
    assignments.push('system_prompt = ?')
    params.push(systemPrompt)
  }

  params.push(input.sessionId)
  db.prepare(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`).run(...params)
}

export function updateSessionModel(db: Database.Database, input: UpdateSessionModelInput): void {
  db.prepare(
    `UPDATE sessions
     SET model = ?,
         model_config = json_set(COALESCE(model_config, '{}'), '$.companion_provider', ?)
     WHERE id = ?`,
  ).run(input.model, input.provider, input.sessionId)
}