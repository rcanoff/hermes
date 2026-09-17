import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import { insertBot, ensureDefaultBotRow } from '../src/db/repos/bots.js'
import { createJobConversation } from '../src/db/repos/conversations.js'
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

    expect(hermes.requests[0]?.companionUserId).toBe('u1')
    expect(hermes.requests[0]?.companionUsername).toBe('op')

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

  it('drops pre-tool answer tokens from the reply bubble and keeps the final answer', async () => {
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

    expect(events).not.toContainEqual({
      event: 'reply',
      data: expect.objectContaining({
        text: 'Updating user preferences…',
      }),
    })
    expect(events).toContainEqual({
      event: 'reply',
      data: expect.objectContaining({
        text: 'Got it.',
      }),
    })
    expect(
      db.prepare(`SELECT content FROM messages WHERE id = ?`).get(assistantMessageId),
    ).toEqual({ content: 'Got it.' })

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

  it('drops mid-turn narration and persists only the last post-tool answer', async () => {
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

    hermes.pushAnswerToken("I'll pull the home overview from Home Assistant and format a short status for you.")
    hermes.pushToolCall('skill_view', '{"name":"home-assistant-mcp"}')
    hermes.pushAnswerToken('Pulling the live Home Assistant overview next.')
    hermes.pushToolCall('mcp__ha__ha_get_overview', '{}')
    hermes.pushAnswerToken('Fetching live house status now.')
    hermes.pushToolCall('mcp__ha__ha_get_state', '{}')
    hermes.pushAnswerToken('House is quiet and empty.')
    hermes.pushDone()
    hermes.closeWithoutDone()

    const assistantMessageId = await runPromise

    const replyTexts = events
      .filter((event) => event.event === 'reply' && typeof event.data.text === 'string')
      .map((event) => event.data.text as string)
    expect(replyTexts).toEqual(['House is quiet and empty.'])
    expect(
      db.prepare(`SELECT content FROM messages WHERE id = ?`).get(assistantMessageId),
    ).toEqual({ content: 'House is quiet and empty.' })
  })

  it('emits no-tool reply tokens before done', async () => {
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
    hermes.pushAnswerToken(' an idea')
    hermes.pushDone()
    hermes.closeWithoutDone()

    await runPromise

    const tokenEvents = legacyEvents.filter((event) => event.event === 'token')
    const doneIndex = legacyEvents.findIndex((event) => event.event === 'done')
    expect(tokenEvents).toEqual([
      { event: 'token', data: { text: 'Here is' } },
      { event: 'token', data: { text: ' an idea' } },
    ])
    expect(doneIndex).toBeGreaterThan(-1)
    expect(legacyEvents.findIndex((event) => event.event === 'token')).toBeLessThan(doneIndex)
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

  it('fails the run instead of persisting an empty assistant message', async () => {
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

    hermes.pushDone()
    hermes.closeWithoutDone()

    await expect(runPromise).rejects.toThrow('Hermes stream completed without assistant text')

    expect(
      db.prepare(`SELECT role, content FROM messages WHERE conversation_id = 'c1' ORDER BY created_at`).all(),
    ).toEqual([{ role: 'user', content: 'Where am I?' }])
    expect(
      db.prepare(`SELECT status, error_code, assistant_message_id FROM message_runs WHERE id = 'run-1'`).get(),
    ).toEqual({
      status: 'failed',
      error_code: 'hermes_stream_failed',
      assistant_message_id: null,
    })
    expect(events).toContainEqual({
      event: 'error',
      data: expect.objectContaining({ code: 'hermes_stream_failed' }),
    })
  })

  it('passes a non-default bot slug to streamChat', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)
    ensureDefaultBotRow(db, 'u1')
    const travel = insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
      hermesProfileName: 'op-travel',
    })
    db.prepare(`UPDATE conversations SET bot_id = ? WHERE id = 'c1'`).run(travel.id)

    const hermes = new FakeHermesClient()
    const hub = new StreamHub()
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

    hermes.pushAnswerToken('ok')
    hermes.pushDone()
    hermes.closeWithoutDone()
    await runPromise

    expect(hermes.requests[0]?.profileSlug).toBe('op-travel')
    const system = hermes.requests[0]?.messages[0]
    expect(system).toMatchObject({ role: 'system' })
    expect(system?.content).toContain('You are Travel. Specialty: Flights')
    expect(system?.content).toContain('set_my_responsibilities')
    expect(system?.content).toContain(
      '- Hermes (main): Default Companion assistant; routes matching work to specialist teammates.',
    )
    expect(system?.content).not.toContain('- Travel:')
  })

  it('includes other bots on the roster after a teammate is created', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedConversation(db)
    insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      soul: 'You book trips.',
    })
    const hermesBot = ensureDefaultBotRow(db, 'u1')
    db.prepare(`UPDATE conversations SET bot_id = ? WHERE id = 'c1'`).run(hermesBot.id)

    const hermes = new FakeHermesClient()
    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub: new StreamHub(),
      conversationId: 'c1',
      hermesSessionId: 'sess-1',
      userMessageId: db.prepare(`SELECT user_message_id FROM message_runs WHERE id = 'run-1'`).pluck().get() as string,
      runId: 'run-1',
      userId: 'u1',
      originSessionId: 'sess-1',
    })

    hermes.pushAnswerToken('ok')
    hermes.pushDone()
    hermes.closeWithoutDone()
    await runPromise

    const system = hermes.requests[0]?.messages[0]
    expect(system).toMatchObject({ role: 'system' })
    expect(system?.content).toContain(
      'You are Hermes (main). Specialty: Default Companion assistant; routes matching work to specialist teammates.',
    )
    expect(system?.content).not.toContain('set_my_responsibilities')
    expect(system?.content).toContain('- Travel: (onboarding — jobs not set yet)')
    expect(system?.content).not.toContain('- Hermes (main):')
    expect(system?.content).not.toContain('You book trips.')
  })

  it('omits roster text for job conversations', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()
    insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      soul: 'You book trips.',
    })
    const conversationId = createJobConversation(db, 'u1', 'op', { name: 'Daily check' })
    const conversation = db
      .prepare(`SELECT hermes_session_id FROM conversations WHERE id = ?`)
      .get(conversationId) as { hermes_session_id: string }
    const userMessageId = insertMessage(db, {
      conversationId,
      role: 'user',
      content: 'run it',
    })
    db.prepare(`
      INSERT INTO message_runs (id, conversation_id, user_message_id, origin_session_id, status)
      VALUES ('run-1', ?, ?, 'sess-1', 'running')
    `).run(conversationId, userMessageId)

    const hermes = new FakeHermesClient()
    const runPromise = executeAssistantRun({
      db,
      hermesClient: hermes,
      hub: new StreamHub(),
      conversationId,
      hermesSessionId: conversation.hermes_session_id,
      userMessageId,
      runId: 'run-1',
      userId: 'u1',
      originSessionId: 'sess-1',
      bootstrapPrompt: 'You are in a Companion App **job conversation**.',
    })

    hermes.pushAnswerToken('ok')
    hermes.pushDone()
    hermes.closeWithoutDone()
    await runPromise

    const system = hermes.requests[0]?.messages[0]
    expect(system).toMatchObject({ role: 'system' })
    expect(system?.content).toContain('job conversation')
    expect(system?.content).not.toContain('Specialty:')
    expect(system?.content).not.toContain('Teammates on this Companion instance')
    expect(system?.content).not.toContain('Finds flights, bookings, and tickets.')
  })

})