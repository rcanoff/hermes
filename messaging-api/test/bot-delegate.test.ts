import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { insertBot, ensureDefaultBotRow } from '../src/db/repos/bots.js'
import {
  createConversation,
  createJobConversation,
  findPeerConversation,
} from '../src/db/repos/conversations.js'
import { insertMessage, listMessages } from '../src/db/repos/messages.js'
import { createRun } from '../src/db/repos/runs.js'
import { initSchema } from '../src/db/schema.js'
import {
  MESSAGE_TEAMMATE_MAX_DEPTH,
  messageTeammate,
  messageTeammateDepth,
} from '../src/services/bot-delegate.js'
import { StreamHub, type SessionStreamEvent } from '../src/streams/hub.js'
import { FakeGrokGatewayClient } from './helpers/grok-gateway.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { resolveGrokInput } from '../src/services/grok-input.js'

function seedUser(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash')`).run()
}

function seedTravel(db: Database.Database) {
  return insertBot(db, {
    userId: 'u1',
    slug: 'travel',
    name: 'Travel',
    role: 'Flights',
    soul: 'You book trips.',
    icon: 'map',
    color: 'green',
  })
}

function seedCallerTurn(db: Database.Database, botId?: string) {
  const conversationId = createConversation(db, 'u1', 'hs-caller', null, undefined, botId)
  const userMessageId = insertMessage(db, {
    conversationId,
    role: 'user',
    content: 'Plan a trip to Lisbon',
  })
  createRun(db, conversationId, userMessageId, 'sess-1')
  return conversationId
}

describe('messageTeammate', () => {
  it('lets the default bot message Travel; copies appear on both threads', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    const hermes = ensureDefaultBotRow(db, 'u1')
    const travel = seedTravel(db)
    const callerId = seedCallerTurn(db)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('Lisbon is lovely in June.')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    const hub = new StreamHub()
    hub.registerUserSession('u1', 'sess-1')
    const events: SessionStreamEvent[] = []
    hub.subscribeSession('sess-1', (event) => events.push(event))

    const result = await messageTeammate({
      db,
      hermesClient,
      hub,
      username: 'operator',
      name: 'Travel',
      text: 'Plan a trip to Lisbon',
    })

    expect(result).toEqual({
      ok: true,
      from: 'Hermes',
      to: 'Travel',
      reply: 'Lisbon is lovely in June.',
    })

    const callerMessages = listMessages(db, callerId)
    expect(callerMessages.map((message) => message.kind)).toEqual(['chat', 'bot_sent', 'bot_reply'])
    expect(callerMessages[1]).toMatchObject({
      role: 'assistant',
      kind: 'bot_sent',
      content: 'Plan a trip to Lisbon',
      from_bot_id: hermes.id,
      to_bot_id: travel.id,
    })
    expect(callerMessages[2]).toMatchObject({
      role: 'assistant',
      kind: 'bot_reply',
      content: 'Lisbon is lovely in June.',
      from_bot_id: travel.id,
      to_bot_id: hermes.id,
      delegation_id: callerMessages[1]!.delegation_id,
    })

    const pair = findPeerConversation(db, 'u1', travel.id, hermes.id)
    expect(pair).toMatchObject({
      bot_id: travel.id,
      peer_bot_id: hermes.id,
      title: 'From Hermes',
    })
    const targetMessages = listMessages(db, pair!.id)
    expect(targetMessages.map((message) => ({ kind: message.kind, role: message.role }))).toEqual([
      { kind: 'bot_sent', role: 'assistant' },
      { kind: 'chat', role: 'assistant' },
    ])
    expect(targetMessages[0]).toMatchObject({
      content: 'Plan a trip to Lisbon',
      from_bot_id: hermes.id,
      to_bot_id: travel.id,
      delegation_id: callerMessages[1]!.delegation_id,
    })
    expect(targetMessages[1]).toMatchObject({
      content: 'Lisbon is lovely in June.',
    })

    const promptUser = hermesClient.requests[0]?.messages.find((message) => message.role === 'user')
    expect(promptUser?.content).toBe('Hermes (teammate) asks: Plan a trip to Lisbon')
    expect(hermesClient.requests[0]?.profileSlug).toBe('u1/travel')

    const callerUpserts = events.filter(
      (event) =>
        event.event === 'message_upsert' && event.data.conversationId === callerId,
    )
    expect(callerUpserts.map((event) => event.data.message.kind)).toEqual(['bot_sent', 'bot_reply'])
    expect(events.some((event) => event.event === 'tooling' && event.data.tool === 'message_teammate')).toBe(
      true,
    )
  })

  it('resolves a teammate by slug', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    seedTravel(db)
    seedCallerTurn(db)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('ok')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    const result = await messageTeammate({
      db,
      hermesClient,
      hub: new StreamHub(),
      username: 'operator',
      name: 'travel',
      text: 'Go',
    })

    expect(result.to).toBe('Travel')
  })

  it('lets a non-default bot message Hermes; copies appear on both threads', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    const hermes = ensureDefaultBotRow(db, 'u1')
    const travel = seedTravel(db)
    const callerId = seedCallerTurn(db, travel.id)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('I can help with that.')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()

    const hub = new StreamHub()
    hub.registerUserSession('u1', 'sess-1')
    const events: SessionStreamEvent[] = []
    hub.subscribeSession('sess-1', (event) => events.push(event))

    const result = await messageTeammate({
      db,
      hermesClient,
      hub,
      username: 'operator',
      name: 'Hermes',
      text: 'Help',
    })

    expect(result).toEqual({
      ok: true,
      from: 'Travel',
      to: 'Hermes',
      reply: 'I can help with that.',
    })

    const callerMessages = listMessages(db, callerId)
    expect(callerMessages.map((message) => message.kind)).toEqual(['chat', 'bot_sent', 'bot_reply'])
    expect(callerMessages[1]).toMatchObject({
      role: 'assistant',
      kind: 'bot_sent',
      content: 'Help',
      from_bot_id: travel.id,
      to_bot_id: hermes.id,
    })
    expect(callerMessages[2]).toMatchObject({
      role: 'assistant',
      kind: 'bot_reply',
      content: 'I can help with that.',
      from_bot_id: hermes.id,
      to_bot_id: travel.id,
      delegation_id: callerMessages[1]!.delegation_id,
    })

    const pair = findPeerConversation(db, 'u1', hermes.id, travel.id)
    expect(pair).toMatchObject({
      bot_id: hermes.id,
      peer_bot_id: travel.id,
      title: 'From Travel',
    })
    const targetMessages = listMessages(db, pair!.id)
    expect(targetMessages.map((message) => ({ kind: message.kind, role: message.role }))).toEqual([
      { kind: 'bot_sent', role: 'assistant' },
      { kind: 'chat', role: 'assistant' },
    ])
    expect(targetMessages[0]).toMatchObject({
      content: 'Help',
      from_bot_id: travel.id,
      to_bot_id: hermes.id,
      delegation_id: callerMessages[1]!.delegation_id,
    })
    expect(targetMessages[1]).toMatchObject({
      content: 'I can help with that.',
    })

    const promptUser = hermesClient.requests[0]?.messages.find((message) => message.role === 'user')
    expect(promptUser?.content).toBe('Travel (teammate) asks: Help')
    expect(hermesClient.requests[0]?.profileSlug).toBe('u1/default')

    const callerUpserts = events.filter(
      (event) =>
        event.event === 'message_upsert' && event.data.conversationId === callerId,
    )
    expect(callerUpserts.map((event) => event.data.message.kind)).toEqual(['bot_sent', 'bot_reply'])
    expect(events.some((event) => event.event === 'tooling' && event.data.tool === 'message_teammate')).toBe(
      true,
    )
  })

  it('rejects an unknown teammate', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    seedCallerTurn(db)

    await expect(
      messageTeammate({
        db,
        hermesClient: new FakeHermesClient(),
        hub: new StreamHub(),
        username: 'operator',
        name: 'Unknown',
        text: 'Help',
      }),
    ).rejects.toThrow('Unknown teammate "Unknown"')
  })

  it('rejects a job conversation', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    seedTravel(db)
    const conversationId = createJobConversation(db, 'u1', 'operator', { name: 'Daily check' })
    const userMessageId = insertMessage(db, {
      conversationId,
      role: 'user',
      content: 'run',
    })
    createRun(db, conversationId, userMessageId, 'sess-1')

    await expect(
      messageTeammate({
        db,
        hermesClient: new FakeHermesClient(),
        hub: new StreamHub(),
        username: 'operator',
        name: 'Travel',
        text: 'Help',
      }),
    ).rejects.toThrow('Job conversations cannot message teammates')
  })

  it('rejects when no run is in progress', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    seedTravel(db)
    createConversation(db, 'u1', 'hs-caller')

    await expect(
      messageTeammate({
        db,
        hermesClient: new FakeHermesClient(),
        hub: new StreamHub(),
        username: 'operator',
        name: 'Travel',
        text: 'Help',
      }),
    ).rejects.toThrow('No running turn to delegate from')
  })

  it('rejects nested depth over 3', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    seedTravel(db)
    seedCallerTurn(db)

    await expect(
      messageTeammateDepth.run(MESSAGE_TEAMMATE_MAX_DEPTH, () =>
        messageTeammate({
          db,
          hermesClient: new FakeHermesClient(),
          hub: new StreamHub(),
          username: 'operator',
          name: 'Travel',
          text: 'Help',
        }),
      ),
    ).rejects.toThrow('message_teammate nested too deep')
  })

  it('routes Hermes→Grok through the gateway and copies pending_input with the same input.id', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    const hermes = ensureDefaultBotRow(db, 'u1')
    const grokBot = insertBot(db, {
      userId: 'u1',
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    const callerId = seedCallerTurn(db)

    const hermesClient = new FakeHermesClient()
    const grokClient = new FakeGrokGatewayClient()
    const hub = new StreamHub()
    hub.registerUserSession('u1', 'sess-1')

    const inputId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const teammate = messageTeammate({
      db,
      hermesClient,
      grokGatewayClient: grokClient,
      hermesHome: '/tmp/hermes-home-test',
      hub,
      username: 'operator',
      name: 'Grok',
      text: 'List files',
    })

    await waitFor(() => grokClient.prompts.length === 1)
    grokClient.pushEvent({
      type: 'pending_input',
      content: 'Run `ls`?',
      input: { id: inputId, status: 'pending', type: 'permission', tool: 'run_terminal_cmd', preview: 'ls' },
    })

    await waitFor(() => listMessages(db, callerId).some((message) => message.kind === 'pending_input'))
    const callerCard = listMessages(db, callerId).find((message) => message.kind === 'pending_input')!
    const pair = findPeerConversation(db, 'u1', grokBot.id, hermes.id)
    const grokCard = listMessages(db, pair!.id).find((message) => message.kind === 'pending_input')!
    expect(callerCard.input?.id).toBe(inputId)
    expect(grokCard.input?.id).toBe(inputId)
    expect(hermesClient.requests).toHaveLength(0)

    await resolveGrokInput({
      db,
      hub,
      grokGatewayClient: grokClient,
      userId: 'u1',
      conversationId: callerId,
      messageId: callerCard.id,
      action: 'allow',
    })
    expect(grokClient.inputs[0]).toMatchObject({
      conversationId: pair!.id,
      input_id: inputId,
      action: 'allow',
    })
    expect(listMessages(db, callerId).find((message) => message.id === callerCard.id)?.input?.status).toBe(
      'allowed',
    )
    expect(listMessages(db, pair!.id).find((message) => message.id === grokCard.id)?.input?.status).toBe(
      'allowed',
    )

    grokClient.pushEvent({ type: 'token', text: 'README.md' })
    grokClient.pushDone()
    grokClient.close()

    const result = await teammate
    expect(result).toEqual({
      ok: true,
      from: 'Hermes',
      to: 'Grok',
      reply: 'README.md',
    })
    expect(grokClient.prompts[0]?.text).toContain('List files')
  })

  it('routes Grok→Hermes through the Hermes client, not the gateway', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    ensureDefaultBotRow(db, 'u1')
    const grokBot = insertBot(db, {
      userId: 'u1',
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    seedCallerTurn(db, grokBot.id)

    const hermesClient = new FakeHermesClient()
    hermesClient.pushAnswerToken('I can help with that.')
    hermesClient.pushDone()
    hermesClient.closeWithoutDone()
    const grokClient = new FakeGrokGatewayClient()

    const result = await messageTeammate({
      db,
      hermesClient,
      grokGatewayClient: grokClient,
      hermesHome: '/tmp/hermes-home-test',
      hub: new StreamHub(),
      username: 'operator',
      name: 'Hermes',
      text: 'Help',
    })

    expect(result.to).toBe('Hermes')
    expect(result.reply).toBe('I can help with that.')
    expect(hermesClient.requests).toHaveLength(1)
    expect(grokClient.prompts).toHaveLength(0)
  })

  it('rejects messaging self', async () => {
    const db = new Database(':memory:')
    initSchema(db)
    seedUser(db)
    seedCallerTurn(db)

    await expect(
      messageTeammate({
        db,
        hermesClient: new FakeHermesClient(),
        hub: new StreamHub(),
        username: 'operator',
        name: 'Hermes',
        text: 'Help',
      }),
    ).rejects.toThrow('Cannot message yourself')
  })
})

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}
