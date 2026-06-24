import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import { executeAssistantRun } from '../src/services/run-executor.js'
import type { SessionStreamEvent } from '../src/streams/hub.js'
import { StreamHub } from '../src/streams/hub.js'
import { FakeHermesClient } from './helpers/hermes.js'

function seedConversation(db: Database.Database, originSessionId = 'sess-1') {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()
  db.prepare(`
    INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'sess-1')
  `).run()
  db.prepare(`
    INSERT INTO message_runs (id, conversation_id, user_message_id, origin_session_id, status)
    VALUES ('run-1', 'c1', ?, ?, 'running')
  `).run(
    insertMessage(db, { conversationId: 'c1', role: 'user', content: 'Where am I?' }),
    originSessionId,
  )
}

describe('executeAssistantRun process stream', () => {
  it('emits tooling and reply session events and persists process blob', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
    const events: SessionStreamEvent[] = []
    hub.subscribeSession('sess-1', (event) => events.push(event))
    hub.registerUserSession('u1', 'sess-1')

    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
      userId: 'u1',
      originSessionId: 'sess-1',
    })

    hermes.pushReasoning('Searching for tools…')
    hermes.pushToolCall('skill_view', '{"name":"demo"}')
    hermes.pushAnswerToken('You are home')
    hermes.pushDone()
    hermes.closeWithoutDone()

    const assistantMessageId = await runPromise

    expect(events.map((e) => e.event)).toEqual([
      'tooling',
      'tooling',
      'tooling',
      'tooling',
      'reply',
      'message_upsert',
      'conversation_upsert',
      'reply',
    ])

    expect(events[0]).toEqual({
      event: 'tooling',
      data: {
        conversationId: 'c1',
        runId: 'run-1',
        phase: 'reasoning',
        text: 'Searching for tools…',
        draft: true,
      },
    })
    expect(events.at(-1)).toEqual({
      event: 'reply',
      data: expect.objectContaining({ phase: 'done', messageId: assistantMessageId }),
    })

    const process = getProcessByAssistantMessageIds(db, [assistantMessageId]).get(assistantMessageId)
    expect(process?.lines).toEqual([
      { phase: 'reasoning', text: 'Searching for tools…' },
      {
        phase: 'activity',
        text: 'Loading skill: demo',
        tool: 'skill_view',
        args: { name: 'demo' },
      },
    ])
  })

  it('streams pre-tool answer tokens immediately then emits activity for memory', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
    const events: SessionStreamEvent[] = []
    hub.subscribeSession('sess-1', (event) => events.push(event))
    hub.registerUserSession('u1', 'sess-1')

    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
      userId: 'u1',
      originSessionId: 'sess-1',
    })

    hermes.pushAnswerToken('Updating user preferences…')
    hermes.pushToolCall('memory', '{"action":"add","target":"user","content":"likes tea"}')
    hermes.pushAnswerToken('Got it.')
    hermes.pushDone()
    hermes.closeWithoutDone()

    const assistantMessageId = await runPromise

    expect(events).toContainEqual({
      event: 'reply',
      data: expect.objectContaining({
        text: 'Updating user preferences…',
      }),
    })

    const process = getProcessByAssistantMessageIds(db, [assistantMessageId]).get(assistantMessageId)
    expect(process?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'activity',
          tool: 'memory',
          args: { action: 'add', target: 'user' },
        }),
      ]),
    )
  })

  it('streams no-tool reply tokens immediately instead of buffering until stream end', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
    const legacyEvents: Array<{ event: string; data: unknown }> = []
    hub.subscribeLegacy('c1', (event) => legacyEvents.push(event))

    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
      userId: 'u1',
      originSessionId: 'sess-1',
    })

    hermes.pushAnswerToken('Here is')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(legacyEvents.map((event) => event.event)).toContain('token')
    expect(legacyEvents.map((event) => event.event)).not.toContain('done')

    hermes.pushAnswerToken(' an idea')
    hermes.pushDone()
    hermes.closeWithoutDone()

    await runPromise

    expect(legacyEvents.filter((event) => event.event === 'token')).toEqual([
      { event: 'token', data: { text: 'Here is' } },
      { event: 'token', data: { text: ' an idea' } },
    ])
  })

  it('streams reasoning drafts and ignores tool completion events', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
    const events: SessionStreamEvent[] = []
    hub.subscribeSession('sess-1', (event) => events.push(event))
    hub.registerUserSession('u1', 'sess-1')

    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub,
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
      userId: 'u1',
      originSessionId: 'sess-1',
    })

    hermes.pushReasoning('Think')
    hermes.pushReasoning('ing')
    hermes.pushToolCall('execute_code', '{}')
    hermes.pushToolComplete('execute_code')
    hermes.pushAnswerToken('Done')
    hermes.pushDone()
    hermes.closeWithoutDone()

    await runPromise

    expect(events.map((e) => e.event)).toEqual([
      'tooling',
      'tooling',
      'tooling',
      'tooling',
      'tooling',
      'reply',
      'message_upsert',
      'conversation_upsert',
      'reply',
    ])
    expect(events[0]).toEqual({
      event: 'tooling',
      data: {
        conversationId: 'c1',
        runId: 'run-1',
        phase: 'reasoning',
        text: 'Think',
        draft: true,
      },
    })
    expect(events[2]).toEqual({
      event: 'tooling',
      data: {
        conversationId: 'c1',
        runId: 'run-1',
        phase: 'reasoning',
        text: 'Thinking',
      },
    })
    expect(events[4]).toEqual({
      event: 'tooling',
      data: {
        conversationId: 'c1',
        runId: 'run-1',
        phase: 'complete',
      },
    })
  })

})