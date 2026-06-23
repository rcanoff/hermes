import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createJobConversation, linkJobConversation } from '../src/db/repos/conversations.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

describe('GET /jobs', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let userId: string

  beforeEach(async () => {
    app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token
    userId = seeded.id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns only job conversations for the authenticated user', async () => {
    const regular = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    expect(regular.statusCode).toBe(201)

    const jobConversationId = createJobConversation(app!.db, userId, 'operator', {
      name: 'Morning digest',
      scheduleDisplay: '30 9 * * *',
    })
    linkJobConversation(app!.db, userId, {
      conversationId: jobConversationId,
      hermesJobId: 'job-abc123',
      username: 'operator',
    })

    const response = await app!.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      jobs: Array<{ id: string; kind: string; hermes_job_id: string }>
      _links: { self: { href: string } }
    }
    expect(body.jobs).toHaveLength(1)
    expect(body.jobs[0]).toMatchObject({
      id: jobConversationId,
      kind: 'job',
      hermes_job_id: 'job-abc123',
      schedule_display: '30 9 * * *',
      job_enabled: true,
    })
    expect(body._links.self.href).toBe('/jobs?limit=20')
  })

  it('returns 401 without auth', async () => {
    const response = await app!.inject({ method: 'GET', url: '/jobs' })
    expect(response.statusCode).toBe(401)
  })
})