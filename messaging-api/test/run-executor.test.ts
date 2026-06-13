import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import { executeAssistantRun } from '../src/services/run-executor.js'
import type { StreamEvent } from '../src/streams/hub.js'
import { StreamHub } from '../src/streams/hub.js'
import { FakeHermesClient } from './helpers/hermes.js'

function seedConversation(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'sess-1')
  `).run()
  db.prepare(`
    INSERT INTO message_runs (id, conversation_id, user_message_id, status)
    VALUES ('run-1', 'c1', ?, 'running')
  `).run(
    insertMessage(db, { conversationId: 'c1', role: 'user', content: 'Where am I?' }),
  )
}

describe('executeAssistantRun process stream', () => {
  it('emits process, process_complete, token, persists process blob', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
    const events: StreamEvent[] = []
    hub.subscribe('c1', (event) => events.push(event))

    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
    })

    hermes.pushReasoning('Searching for tools…')
    hermes.pushToolCall('skill_view', '{"name":"demo"}')
    hermes.pushAnswerToken('You are home')
    hermes.pushDone()
    hermes.closeWithoutDone()

    const assistantMessageId = await runPromise

    expect(events.map((e) => e.event)).toEqual([
      'process',
      'process',
      'process_complete',
      'token',
      'done',
    ])

    const process = getProcessByAssistantMessageIds(db, [assistantMessageId]).get(assistantMessageId)
    expect(process?.lines).toEqual([
      { kind: 'reasoning', text: 'Searching for tools…' },
      { kind: 'tool', text: 'Loading skill: demo' },
    ])
  })
})