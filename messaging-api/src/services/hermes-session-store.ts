import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'

const SESSION_SOURCE = 'api_server'

const MODEL_LINE_PATTERN = /^Model:\s*.+$/m
const PROVIDER_LINE_PATTERN = /^Provider:\s*.+$/m
const CONVERSATION_STARTED_PATTERN = /^Conversation started:\s*.+$/m

function formatConversationStartedDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function syncSessionPromptModelFooter(
  systemPrompt: string | null | undefined,
  model: string,
  provider: string,
): string {
  const base = systemPrompt?.trim() ?? ''
  const hasModelLine = MODEL_LINE_PATTERN.test(base)
  const hasProviderLine = PROVIDER_LINE_PATTERN.test(base)

  if (hasModelLine && hasProviderLine) {
    return base
      .replace(MODEL_LINE_PATTERN, `Model: ${model}`)
      .replace(PROVIDER_LINE_PATTERN, `Provider: ${provider}`)
  }

  const footerLines: string[] = []
  if (!CONVERSATION_STARTED_PATTERN.test(base)) {
    footerLines.push(`Conversation started: ${formatConversationStartedDate(new Date())}`)
  }
  footerLines.push(`Model: ${model}`)
  footerLines.push(`Provider: ${provider}`)

  if (!base) {
    return footerLines.join('\n')
  }

  return `${base}\n\n${footerLines.join('\n')}`
}

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
    const systemPrompt = syncSessionPromptModelFooter(
      input.systemPrompt,
      input.model,
      input.provider,
    )
    db.prepare(
      `INSERT INTO sessions (id, source, model, model_config, system_prompt, started_at)
       VALUES (?, ?, ?, json_object('companion_provider', ?), ?, ?)`,
    ).run(
      input.sessionId,
      SESSION_SOURCE,
      input.model,
      input.provider,
      systemPrompt || null,
      Date.now() / 1000,
    )
    return
  }

  const existingPrompt = db
    .prepare('SELECT system_prompt FROM sessions WHERE id = ?')
    .get(input.sessionId) as { system_prompt: string | null } | undefined
  const basePrompt = input.systemPrompt?.trim() || existingPrompt?.system_prompt || null
  const systemPrompt = syncSessionPromptModelFooter(basePrompt, input.model, input.provider)

  db.prepare(
    `UPDATE sessions
     SET model = ?,
         model_config = json_set(COALESCE(model_config, '{}'), '$.companion_provider', ?),
         system_prompt = ?
     WHERE id = ?`,
  ).run(input.model, input.provider, systemPrompt || null, input.sessionId)
}

export function updateSessionModel(db: Database.Database, input: UpdateSessionModelInput): void {
  const existing = db
    .prepare('SELECT system_prompt FROM sessions WHERE id = ?')
    .get(input.sessionId) as { system_prompt: string | null } | undefined
  const systemPrompt = syncSessionPromptModelFooter(
    existing?.system_prompt,
    input.model,
    input.provider,
  )

  db.prepare(
    `UPDATE sessions
     SET model = ?,
         model_config = json_set(COALESCE(model_config, '{}'), '$.companion_provider', ?),
         system_prompt = ?
     WHERE id = ?`,
  ).run(input.model, input.provider, systemPrompt || null, input.sessionId)
}