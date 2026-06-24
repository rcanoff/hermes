import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openHermesStateDbRw,
  updateSessionModel,
  upsertCompanionSession,
} from '../src/services/hermes-session-store.js'

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

describe('hermes-session-store', () => {
  const tempFiles: string[] = []

  afterEach(() => {
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

  it('creates a session row when missing and stores companion provider', () => {
    const dbPath = createStateDb()
    const db = openHermesStateDbRw(dbPath)!

    upsertCompanionSession(db, {
      sessionId: 'hs1',
      model: 'grok-4.3',
      provider: 'xai-oauth',
      systemPrompt: 'You are helpful.',
    })

    const row = db
      .prepare('SELECT id, source, model, model_config, system_prompt FROM sessions WHERE id = ?')
      .get('hs1') as {
      id: string
      source: string
      model: string
      model_config: string
      system_prompt: string
    }

    expect(row).toMatchObject({
      id: 'hs1',
      source: 'api_server',
      model: 'grok-4.3',
      system_prompt: 'You are helpful.',
    })
    expect(JSON.parse(row.model_config)).toEqual({ companion_provider: 'xai-oauth' })
    db.close()
  })

  it('updates model and provider on existing sessions', () => {
    const dbPath = createStateDb()
    const db = openHermesStateDbRw(dbPath)!

    upsertCompanionSession(db, {
      sessionId: 'hs1',
      model: 'grok-composer-2.5-fast',
      provider: 'xai-oauth',
    })

    updateSessionModel(db, {
      sessionId: 'hs1',
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })

    const row = db
      .prepare('SELECT model, model_config FROM sessions WHERE id = ?')
      .get('hs1') as { model: string; model_config: string }

    expect(row.model).toBe('grok-4.3')
    expect(JSON.parse(row.model_config)).toEqual({ companion_provider: 'xai-oauth' })
    db.close()
  })
})