import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAiHermesClient } from '../src/services/hermes-client.js'
import { openHermesStateDbRw } from '../src/services/hermes-session-store.js'

const SESSIONS_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    started_at REAL NOT NULL
  );
`

describe('OpenAiHermesClient session model sync', () => {
  const tempFiles: string[] = []
  let originalFetch: typeof fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const file of tempFiles.splice(0)) {
      fs.rmSync(file, { force: true })
    }
  })

  function createStateDb(): string {
    const filePath = path.join(os.tmpdir(), `hermes-state-${Date.now()}-${Math.random()}.db`)
    const db = openHermesStateDbRw(filePath)
    db!.exec(SESSIONS_SCHEMA)
    db!.close()
    tempFiles.push(filePath)
    return filePath
  }

  it('syncs model to state.db after ensureSession conflict', async () => {
    originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 409 })

    const dbPath = createStateDb()
    const client = new OpenAiHermesClient('http://hermes.test', 'api-key', dbPath)

    await client.ensureSession({
      hermesSessionId: 'hs-conflict',
      model: 'grok-4.3',
      provider: 'xai-oauth',
      systemPrompt: 'Bootstrap',
    })

    const db = openHermesStateDbRw(dbPath)!
    const row = db
      .prepare('SELECT model, model_config, system_prompt FROM sessions WHERE id = ?')
      .get('hs-conflict') as { model: string; model_config: string; system_prompt: string }
    db.close()

    expect(row.model).toBe('grok-4.3')
    expect(JSON.parse(row.model_config)).toEqual({ companion_provider: 'xai-oauth' })
    expect(row.system_prompt).toContain('Bootstrap')
    expect(row.system_prompt).toContain('Model: grok-4.3')
    expect(row.system_prompt).toContain('Provider: xai-oauth')
  })

  it('writes model changes via patchSessionModel on state.db', async () => {
    const dbPath = createStateDb()
    const db = openHermesStateDbRw(dbPath)!
    db.prepare(
      `INSERT INTO sessions (id, source, model, model_config, system_prompt, started_at)
       VALUES ('hs1', 'api_server', 'grok-composer-2.5-fast', '{}', ?, 1)`,
    ).run(
      [
        'Bootstrap prompt',
        '',
        'Conversation started: Wednesday, June 10, 2026',
        'Model: grok-composer-2.5-fast',
        'Provider: xai-oauth',
      ].join('\n'),
    )
    db.close()

    const client = new OpenAiHermesClient('http://hermes.test', 'api-key', dbPath)
    await client.patchSessionModel({
      hermesSessionId: 'hs1',
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })

    const verifyDb = openHermesStateDbRw(dbPath)!
    const row = verifyDb
      .prepare('SELECT model, model_config, system_prompt FROM sessions WHERE id = ?')
      .get('hs1') as { model: string; model_config: string; system_prompt: string }
    verifyDb.close()

    expect(row.model).toBe('grok-4.3')
    expect(JSON.parse(row.model_config)).toEqual({ companion_provider: 'xai-oauth' })
    expect(row.system_prompt).toContain('Model: grok-4.3')
    expect(row.system_prompt).not.toContain('grok-composer-2.5-fast')
  })
})