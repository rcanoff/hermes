import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openHermesStateDbRw,
  syncSessionPromptModelFooter,
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

  it('replaces existing model and provider footer lines', () => {
    const prompt = [
      'You are helpful.',
      '',
      'Conversation started: Wednesday, June 10, 2026',
      'Model: grok-composer-2.5-fast',
      'Provider: xai-oauth',
    ].join('\n')

    expect(syncSessionPromptModelFooter(prompt, 'grok-4.3', 'xai-oauth')).toBe(
      [
        'You are helpful.',
        '',
        'Conversation started: Wednesday, June 10, 2026',
        'Model: grok-4.3',
        'Provider: xai-oauth',
      ].join('\n'),
    )
  })

  it('appends footer when model and provider lines are missing', () => {
    expect(syncSessionPromptModelFooter('You are helpful.', 'grok-4.3', 'xai-oauth')).toMatch(
      /^You are helpful\.\n\nConversation started: .+\nModel: grok-4\.3\nProvider: xai-oauth$/,
    )
    expect(syncSessionPromptModelFooter(null, 'grok-4.3', 'xai-oauth')).toMatch(
      /^Conversation started: .+\nModel: grok-4\.3\nProvider: xai-oauth$/,
    )
  })

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
    })
    expect(row.system_prompt).toContain('You are helpful.')
    expect(row.system_prompt).toContain('Model: grok-4.3')
    expect(row.system_prompt).toContain('Provider: xai-oauth')
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
      systemPrompt: [
        'You are helpful.',
        '',
        'Conversation started: Wednesday, June 10, 2026',
        'Model: grok-composer-2.5-fast',
        'Provider: xai-oauth',
      ].join('\n'),
    })

    updateSessionModel(db, {
      sessionId: 'hs1',
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })

    const row = db
      .prepare('SELECT model, model_config, system_prompt FROM sessions WHERE id = ?')
      .get('hs1') as { model: string; model_config: string; system_prompt: string }

    expect(row.model).toBe('grok-4.3')
    expect(JSON.parse(row.model_config)).toEqual({ companion_provider: 'xai-oauth' })
    expect(row.system_prompt).toContain('Model: grok-4.3')
    expect(row.system_prompt).not.toContain('grok-composer-2.5-fast')
    db.close()
  })
})