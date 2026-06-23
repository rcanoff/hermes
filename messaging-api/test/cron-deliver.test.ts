import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  createJobConversation,
  linkJobConversation,
} from '../src/db/repos/conversations.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('POST /internal/cron/deliver', () => {
  let app: FastifyInstance | undefined
  let userId: string
  let jobConversationId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    userId = seeded.id

    jobConversationId = createJobConversation(app.db, userId, 'operator', {
      name: 'Gate check',
      scheduleDisplay: 'every 30m',
    })
    linkJobConversation(app.db, userId, {
      conversationId: jobConversationId,
      hermesJobId: 'cron-job-1',
      username: 'operator',
    })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns 401 without bearer auth', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/internal/cron/deliver?job_id=cron-job-1',
      payload: { content: 'Gate B12' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('commits assistant message and returns message_id', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/internal/cron/deliver',
      headers: { authorization: 'Bearer test-cron-webhook-bearer' },
      payload: {
        hermes_job_id: 'cron-job-1',
        content: 'Gate B12',
        status: 'ok',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { message_id: string }
    expect(body.message_id).toEqual(expect.any(String))

    const message = app!.db
      .prepare('SELECT role, content FROM messages WHERE id = ?')
      .get(body.message_id) as { role: string; content: string }
    expect(message).toEqual({ role: 'assistant', content: 'Gate B12' })

    const conversation = app!.db
      .prepare('SELECT job_last_status, job_last_run_at FROM conversations WHERE id = ?')
      .get(jobConversationId) as { job_last_status: string; job_last_run_at: string }
    expect(conversation.job_last_status).toBe('ok')
    expect(conversation.job_last_run_at).toBeTruthy()
  })

  it('returns 204 for [SILENT] content', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/internal/cron/deliver?job_id=cron-job-1',
      headers: { authorization: 'Bearer test-cron-webhook-bearer' },
      payload: { content: '[SILENT]' },
    })

    expect(response.statusCode).toBe(204)
    const count = app!.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
      .get(jobConversationId) as { count: number }
    expect(count.count).toBe(0)
  })

  it('returns 404 for unknown job id', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/internal/cron/deliver',
      headers: { authorization: 'Bearer test-cron-webhook-bearer' },
      payload: { hermes_job_id: 'missing', content: 'hello' },
    })
    expect(response.statusCode).toBe(404)
  })
})