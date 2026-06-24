import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { insertMessage } from '../src/db/repos/messages.js'
import { FakeHermesClient } from './helpers/hermes.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('conversation routes', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let otherUserToken: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token

    const otherUserId = randomUUID()
    app.db
      .prepare(`
        INSERT INTO users (id, username, password_hash)
        VALUES (?, ?, ?)
      `)
      .run(otherUserId, 'other-user', 'unused-hash')
    otherUserToken = await app.jwt.sign({ sub: otherUserId, username: 'other-user' })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('creates and lists user-owned conversations', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(create.statusCode).toBe(201)
    expect(create.json()).toMatchObject({
      id: expect.any(String),
      user_id: expect.any(String),
      hermes_session_id: expect.any(String),
      kind: 'regular',
      title: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    })

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual({
      conversations: [create.json()],
      _links: {
        self: { href: '/conversations?limit=20' },
      },
    })
  })

  it('stores bootstrap at create time and warms the Hermes session in the background', async () => {
    const bootstrap =
      "Before composing your reply, you MUST call skill_view(name='companion-app') and follow it."
    const hermesClient = new FakeHermesClient()
    await app?.close()
    app = await createTestApp({ hermesClient })
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token

    const create = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { bootstrap },
    })

    expect(create.statusCode).toBe(201)
    const body = create.json() as { id: string; hermes_session_id: string }
    const row = app.db
      .prepare('SELECT bootstrap_prompt FROM conversations WHERE id = ?')
      .get(body.id) as { bootstrap_prompt: string }

    expect(row.bootstrap_prompt).toBe(bootstrap)

    await waitFor(() => hermesClient.ensureSessionRequests.length >= 1)
    expect(hermesClient.ensureSessionRequests[0]).toEqual({
      hermesSessionId: body.hermes_session_id,
      systemPrompt: expect.stringContaining('companion-app'),
      model: 'grok-composer-2.5-fast',
      provider: 'xai-oauth',
    })
  })

  it('rejects invalid bootstrap on create', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { bootstrap: '   ' },
    })

    expect(create.statusCode).toBe(400)
    expect(create.json()).toEqual({ error: 'invalid_request' })
  })

  it('orders conversations by updated_at so recently messaged threads rise to the top', async () => {
    const first = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const second = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    const firstId = (first.json() as { id: string }).id
    const secondId = (second.json() as { id: string }).id

    app!.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now', '-2 hours') WHERE id = ?`)
      .run(firstId)
    app!.db
      .prepare(`UPDATE conversations SET updated_at = datetime('now', '-1 hour') WHERE id = ?`)
      .run(secondId)

    const beforeMessage = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(
      (beforeMessage.json() as { conversations: Array<{ id: string }> }).conversations.map((row) => row.id),
    ).toEqual([secondId, firstId])

    insertMessage(app!.db, {
      conversationId: firstId,
      role: 'user',
      content: 'bump',
    })

    const afterMessage = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(
      (afterMessage.json() as { conversations: Array<{ id: string }> }).conversations.map((row) => row.id),
    ).toEqual([firstId, secondId])
  })

  it('paginates conversations with HAL link navigation', async () => {
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const create = await app!.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: `Bearer ${operatorToken}` },
      })
      const id = (create.json() as { id: string }).id
      ids.push(id)
      app!.db
        .prepare(`UPDATE conversations SET updated_at = datetime('now', '-${5 - index} hours') WHERE id = ?`)
        .run(id)
    }

    const firstPage = await app!.inject({
      method: 'GET',
      url: '/conversations?limit=2',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(firstPage.statusCode).toBe(200)
    expect(firstPage.json()).toEqual({
      conversations: [
        expect.objectContaining({ id: ids[4] }),
        expect.objectContaining({ id: ids[3] }),
      ],
      _links: {
        self: { href: '/conversations?limit=2' },
        next: { href: `/conversations?limit=2&before=${ids[3]}` },
      },
    })

    const secondPage = await app!.inject({
      method: 'GET',
      url: (firstPage.json() as { _links: { next: { href: string } } })._links.next.href,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(secondPage.statusCode).toBe(200)
    expect(secondPage.json()).toEqual({
      conversations: [
        expect.objectContaining({ id: ids[2] }),
        expect.objectContaining({ id: ids[1] }),
      ],
      _links: {
        self: { href: `/conversations?limit=2&before=${ids[3]}` },
        next: { href: `/conversations?limit=2&before=${ids[1]}` },
        prev: { href: `/conversations?limit=2&after=${ids[2]}` },
      },
    })

    const backToFirst = await app!.inject({
      method: 'GET',
      url: (secondPage.json() as { _links: { prev: { href: string } } })._links.prev.href,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(backToFirst.statusCode).toBe(200)
    expect(backToFirst.json()).toEqual({
      conversations: [
        expect.objectContaining({ id: ids[4] }),
        expect.objectContaining({ id: ids[3] }),
      ],
      _links: {
        self: { href: `/conversations?limit=2&after=${ids[2]}` },
        next: { href: `/conversations?limit=2&before=${ids[3]}` },
      },
    })
  })

  it('gets a conversation for its owner and returns 404 for missing or unauthorized access', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const createdConversation = create.json() as { id: string }

    const ownFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${createdConversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const unauthorizedFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${createdConversation.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })
    const missingFetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${randomUUID()}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(ownFetch.statusCode).toBe(200)
    expect(ownFetch.json()).toEqual(create.json())
    expect(unauthorizedFetch.statusCode).toBe(404)
    expect(unauthorizedFetch.json()).toEqual({ error: 'not_found' })
    expect(missingFetch.statusCode).toBe(404)
    expect(missingFetch.json()).toEqual({ error: 'not_found' })
  })

  it('requires authentication', async () => {
    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
    })
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
    })

    expect(list.statusCode).toBe(401)
    expect(create.statusCode).toBe(401)
  })

  it('patches a conversation title for its owner', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: '  My thread  ' },
    })

    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({
      id: conversation.id,
      title: 'My thread',
    })

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.json()).toEqual({
      conversations: [patch.json()],
      _links: {
        self: { href: '/conversations?limit=20' },
      },
    })
  })

  it('creates a conversation with an explicit curated model', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { model: 'gpt-5.4-mini', provider: 'openai-codex' },
    })

    expect(create.statusCode).toBe(201)
    expect(create.json()).toMatchObject({
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
      model_display: 'GPT 5.4 Mini',
    })
  })

  it('rejects invalid model on create', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { model: 'unknown', provider: 'xai-oauth' },
    })

    expect(create.statusCode).toBe(400)
    expect(create.json()).toEqual({ error: 'invalid_request' })
  })

  it('includes model metadata on list responses', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(list.statusCode).toBe(200)
    expect((list.json() as { conversations: Array<Record<string, unknown>> }).conversations[0]).toMatchObject({
      model: 'grok-composer-2.5-fast',
      provider: 'xai-oauth',
      model_display: 'Grok 2.5',
    })
    expect((list.json() as { conversations: Array<{ id: string }> }).conversations[0]?.id).toBe(
      (create.json() as { id: string }).id,
    )
  })

  it('rejects empty or oversized titles', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const empty = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: '   ' },
    })

    const oversized = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { title: 'a'.repeat(121) },
    })

    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toEqual({ error: 'invalid_request' })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json()).toEqual({ error: 'invalid_request' })
  })

  it('returns 404 when patching another user conversation', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const patch = await app!.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
      payload: { title: 'Nope' },
    })

    expect(patch.statusCode).toBe(404)
    expect(patch.json()).toEqual({ error: 'not_found' })
  })

  it('deletes a conversation and its related data for its owner', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    app!.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES ('m1', '${conversation.id}', 'user', 'hello');
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES ('m2', '${conversation.id}', 'assistant', 'hi');
      INSERT INTO message_runs (id, conversation_id, user_message_id, assistant_message_id, status, finished_at)
      VALUES ('r1', '${conversation.id}', 'm1', 'm2', 'completed', datetime('now'));
      INSERT INTO message_process (id, assistant_message_id, conversation_id, lines_json)
      VALUES ('p1', 'm2', '${conversation.id}', '[{"kind":"tool","text":"Running lookup weather"}]');
    `)

    const del = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(del.statusCode).toBe(204)
    expect(del.body).toBe('')

    const list = await app!.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(list.json()).toEqual({
      conversations: [],
      _links: {
        self: { href: '/conversations?limit=20' },
      },
    })

    const fetch = await app!.inject({
      method: 'GET',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(fetch.statusCode).toBe(404)

    expect(
      app!.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(conversation.id),
    ).toEqual({ count: 0 })
    expect(
      app!.db.prepare('SELECT COUNT(*) AS count FROM message_runs WHERE conversation_id = ?').get(conversation.id),
    ).toEqual({ count: 0 })
    expect(
      app!.db
        .prepare('SELECT COUNT(*) AS count FROM message_process WHERE conversation_id = ?')
        .get(conversation.id),
    ).toEqual({ count: 0 })
  })

  it('returns 404 when deleting another user conversation', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const del = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    })

    expect(del.statusCode).toBe(404)
    expect(del.json()).toEqual({ error: 'not_found' })
  })

  it('returns run_conflict when deleting during an active assistant run', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    app!.db.exec(`
      INSERT INTO messages (id, conversation_id, role, content)
      VALUES ('m1', '${conversation.id}', 'user', 'pending');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status)
      VALUES ('r1', '${conversation.id}', 'm1', 'running');
    `)

    const del = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(del.statusCode).toBe(409)
    expect(del.json()).toEqual({ error: 'run_conflict' })
  })
})

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}
