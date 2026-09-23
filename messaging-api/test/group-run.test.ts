import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { enqueueGroupRun, finishGroupRun, claimNextGroupRun } from '../src/db/repos/group-bot-runs.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { drainGroupRuns, type GroupRunDeps } from '../src/services/group-run.js'
import * as hermesAuxiliaryClient from '../src/services/hermes-auxiliary-client.js'
import { GROUP_PROMPT_CHAR_BUDGET } from '../src/lib/group-prompt.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('group runs', () => {
  let app: FastifyInstance | undefined
  let complete: ReturnType<typeof vi.spyOn>
  let auxiliary: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    vi.spyOn(app.hermesClient, 'ensureSession').mockResolvedValue()
    complete = vi.spyOn(app.hermesClient, 'completeChat').mockResolvedValue('ok')
    auxiliary = vi.spyOn(hermesAuxiliaryClient, 'completeHermesAuxiliary').mockResolvedValue('ok')
  })

  afterEach(async () => {
    if (app) {
      await drainGroupRuns(deps(app))
      await app.close()
    }
    vi.restoreAllMocks()
    app = undefined
  })

  it('runs two queued mentions in sequence', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    const prompts: string[] = []
    const replies = ['boundary reply', 'second answer', 'third answer']
    complete.mockImplementation(async (input) => {
      const text = typeof input.messages[0]?.content === 'string' ? input.messages[0].content : ''
      prompts.push(text)
      return replies[prompts.length - 1] ?? 'later'
    })
    const publish = vi.spyOn(app!.streamHub, 'publishToUser')
    const legacy = vi.spyOn(app!.streamHub, 'publishLegacy')
    queueMention(app!, group.id, alice.id, group.botId, 'first request')
    queueMention(app!, group.id, alice.id, group.botId, 'second request')

    await drainGroupRuns(deps(app!))

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Primary request from alice:\nfirst request')
    expect(prompts[0]).not.toContain('boundary reply')
    expect(prompts[1]).toContain('alice: first request')
    expect(prompts[1]).not.toContain('boundary reply')
    const secondSection = prompts[1].indexOf('Primary request from alice:')
    expect(prompts[1].slice(0, secondSection)).not.toContain('second request')
    expect(prompts[1].slice(secondSection)).toContain('second request')
    expect(auxiliary).not.toHaveBeenCalled()
    expect(complete.mock.calls[0]?.[0]?.hermesSessionId).toBeTruthy()
    expect(complete.mock.calls[0]?.[0]?.messages[0]?.content).toContain('Primary request from alice:')
    expect(messageContents(app!, group.id)).toEqual([
      'first request',
      'second request',
      'boundary reply',
      'second answer',
    ])
    expect(runStates(app!, group.id)).toEqual(['done', 'done'])
    queueMention(app!, group.id, bob.id, group.botId, 'third request')
    await drainGroupRuns(deps(app!))
    const thirdSection = prompts[2]?.indexOf('Primary request from bob:') ?? -1
    expect(prompts[2]?.slice(0, thirdSection)).toContain('Hermes: second answer')
    expect(prompts[2]?.slice(0, thirdSection)).not.toContain('boundary reply')
    expect(prompts[2]?.slice(0, thirdSection)).not.toContain('third request')

    const aliceEvents = publish.mock.calls.filter((call) => call[0] === alice.id).map((call) => call[1])
    const typing = aliceEvents.findIndex(
      (event) => event.event === 'typing' && event.data.actorId === group.botId && event.data.active === true,
    )
    const done = aliceEvents.findIndex(
      (event, index) => index > typing && event.event === 'reply' && event.data.phase === 'done',
    )
    const upsert = aliceEvents.findIndex((event, index) => index > done && event.event === 'message_upsert')
    expect(typing).toBeGreaterThanOrEqual(0)
    expect(done).toBeGreaterThan(typing)
    expect(upsert).toBeGreaterThan(done)
    expect(aliceEvents.some((event) => event.event === 'reply' && event.data.text)).toBe(false)
    expect(aliceEvents.some((event) => event.event === 'tooling')).toBe(false)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('does not let a failed finish block the next claim', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    const first = queueMention(app!, group.id, alice.id, group.botId, 'one')
    const second = queueMention(app!, group.id, alice.id, group.botId, 'two')

    expect(claimNextGroupRun(app!.db)?.messageId).toBe(first)
    expect(finishGroupRun(app!.db, first, 'running', 'stuck', 'run_unconfirmed')).toBe(true)
    expect(finishGroupRun(app!.db, first, 'running', 'done')).toBe(false)
    expect(claimNextGroupRun(app!.db)?.messageId).toBe(second)
  })

  it('writes no assistant message when a late done loses to stuck', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    const first = queueMention(app!, group.id, alice.id, group.botId, 'one')
    queueMention(app!, group.id, alice.id, group.botId, 'two')
    let turn = 0
    complete.mockImplementation(async () => {
      turn += 1
      if (turn === 1) {
        const running = app!.db
          .prepare(`SELECT message_id FROM group_bot_runs WHERE state = 'running'`)
          .get() as { message_id: string }
        finishGroupRun(app!.db, running.message_id, 'running', 'stuck')
        return 'lost reply'
      }
      return 'next reply'
    })

    await drainGroupRuns(deps(app!))

    expect(finishGroupRun(app!.db, first, 'running', 'done')).toBe(false)
    expect(messageContents(app!, group.id)).not.toContain('lost reply')
    expect(messageContents(app!, group.id)).toContain('next reply')
    expect(runStates(app!, group.id)).toEqual(['stuck', 'done'])
  })

  it('writes run_unconfirmed once for a swept running row and does not redispatch', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    queueMention(app!, group.id, alice.id, group.botId, 'orphaned')
    expect(claimNextGroupRun(app!.db)?.conversationId).toBe(group.id)

    await drainGroupRuns(deps(app!))
    await drainGroupRuns(deps(app!))

    expect(complete).not.toHaveBeenCalled()
    expect(messageContents(app!, group.id)).toEqual(['orphaned', 'run_unconfirmed'])
    expect(runStates(app!, group.id)).toEqual(['stuck'])
  })

  it('does not insert a second queue row on replay', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    const clientMessageId = randomUUID()
    const payload = {
      text: '@Homer hi',
      client_message_id: clientMessageId,
      mentioned_bot_id: group.botId,
    }
    const headers = { authorization: `Bearer ${alice.token}` }

    const first = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.id}/messages`,
      headers,
      payload,
    })
    expect(groupRunCount(app!, group.id)).toBe(1)
    enqueueGroupRun(app!.db, { messageId: first.json().message.id, conversationId: group.id })
    expect(groupRunCount(app!, group.id)).toBe(1)

    const second = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.id}/messages`,
      headers,
      payload,
    })

    expect(second.statusCode).toBe(200)
    expect(second.json().message.id).toBe(first.json().message.id)
    expect(groupRunCount(app!, group.id)).toBe(1)
    await drainGroupRuns(deps(app!))
    expect(messageContents(app!, group.id).filter((content) => content === 'ok')).toHaveLength(1)
  })

  it('commits context_too_large without a queue row or gateway call', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    const legacy = vi.spyOn(app!.streamHub, 'publishLegacy')

    const sent = await app!.inject({
      method: 'POST',
      url: `/conversations/${group.id}/messages`,
      headers: { authorization: `Bearer ${alice.token}` },
      payload: {
        text: 'z'.repeat(GROUP_PROMPT_CHAR_BUDGET),
        client_message_id: randomUUID(),
        mentioned_bot_id: group.botId,
      },
    })

    expect(sent.statusCode).toBe(202)
    expect(groupRunCount(app!, group.id)).toBe(0)
    expect(complete).not.toHaveBeenCalled()
    expect(messageContents(app!, group.id).at(-1)).toBe('context_too_large')
    expect(legacy).not.toHaveBeenCalled()
  })

  it('commits runtime_unavailable when the bridge rejects the provider', async () => {
    const alice = await seedTestUser(app!, 'alice', 'password123')
    const bob = await seedTestUser(app!, 'bob', 'password123')
    const group = await createGroup(app!, alice.token, bob.id, alice.id)
    app!.db.prepare(`UPDATE bots SET runtime = 'grok' WHERE id = ?`).run(group.botId)
    app!.db.prepare(`UPDATE conversations SET provider = 'grok' WHERE id = ?`).run(group.id)
    auxiliary.mockRejectedValue(new Error("unsupported provider 'grok'"))
    const prompt = vi.spyOn(app!.grokGatewayClient, 'prompt')
    queueMention(app!, group.id, alice.id, group.botId, 'ask grok')

    await drainGroupRuns(deps(app!))

    expect(prompt).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(auxiliary.mock.calls[0]?.[2]).toMatchObject({ provider: 'grok', maxTokens: 2048 })
    expect(messageContents(app!, group.id)).toEqual(['ask grok', 'runtime_unavailable'])
    expect(runStates(app!, group.id)).toEqual(['failed'])
  })
})

function deps(app: FastifyInstance): GroupRunDeps {
  return {
    db: app.db,
    hub: app.streamHub,
    hermesClient: app.hermesClient,
    bridgeUrl: 'http://bridge.test',
    bridgeApiKey: 'key',
    timeoutMs: 1_000,
    catalog: app.companionModels,
  }
}

async function createGroup(app: FastifyInstance, token: string, peerId: string, ownerId: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/conversations',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      kind: 'group',
      participant_user_ids: [peerId],
      bot_id: defaultBotId(app, ownerId),
    },
  })
  return { id: created.json().id as string, botId: defaultBotId(app, ownerId) }
}

function queueMention(
  app: FastifyInstance,
  conversationId: string,
  userId: string,
  botId: string,
  text: string,
): string {
  const messageId = insertMessage(app.db, {
    conversationId,
    role: 'user',
    content: text,
    senderUserId: userId,
    mentionedBotId: botId,
    clientMessageId: randomUUID(),
  })
  enqueueGroupRun(app.db, { messageId, conversationId })
  return messageId
}

function defaultBotId(app: FastifyInstance, userId: string): string {
  return (app.db.prepare(`SELECT id FROM bots WHERE user_id = ? AND is_default = 1`).get(userId) as { id: string })
    .id
}

function messageContents(app: FastifyInstance, conversationId: string): string[] {
  return (
    app.db
      .prepare(`SELECT content FROM messages WHERE conversation_id = ? ORDER BY sequence ASC`)
      .all(conversationId) as Array<{ content: string }>
  ).map((row) => row.content)
}

function runStates(app: FastifyInstance, conversationId: string): string[] {
  return (
    app.db
      .prepare(`
        SELECT group_bot_runs.state
        FROM group_bot_runs
        JOIN messages ON messages.id = group_bot_runs.message_id
        WHERE group_bot_runs.conversation_id = ?
        ORDER BY messages.sequence ASC
      `)
      .all(conversationId) as Array<{ state: string }>
  ).map((row) => row.state)
}

function groupRunCount(app: FastifyInstance, conversationId: string): number {
  return (
    app.db.prepare(`SELECT COUNT(*) AS n FROM group_bot_runs WHERE conversation_id = ?`).get(conversationId) as {
      n: number
    }
  ).n
}
