import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createJobConversation, linkJobConversation } from '../src/db/repos/conversations.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

const INITIAL_JOBS = {
  jobs: [
    {
      id: 'job-linked',
      name: 'Daily Home Report',
      deliver: 'local',
      schedule_display: '0 9 * * *',
    },
    {
      id: 'job-other',
      name: 'Other job',
      deliver: 'origin',
      schedule_display: '30 9 * * *',
    },
  ],
}

describe('DELETE /conversations/:id job cleanup', () => {
  let app: FastifyInstance | undefined
  let operatorToken: string
  let userId: string
  let jobsPath: string
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-job-conv-'))
    jobsPath = path.join(tempDir, 'jobs.json')
    await fs.writeFile(jobsPath, `${JSON.stringify(INITIAL_JOBS, null, 2)}\n`, 'utf8')

    app = await createTestApp({ cronJobsPath: jobsPath })
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')
    operatorToken = seeded.token
    userId = seeded.id
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('removes the linked Hermes cron job when deleting a job conversation', async () => {
    const conversationId = createJobConversation(app!.db, userId, 'operator', {
      name: 'Daily Home Report',
      scheduleDisplay: '0 9 * * *',
    })
    linkJobConversation(app!.db, userId, {
      conversationId,
      hermesJobId: 'job-linked',
      username: 'operator',
    })

    const del = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(del.statusCode).toBe(204)

    const parsed = JSON.parse(await fs.readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ id: string }>
    }
    expect(parsed.jobs.map((job) => job.id)).toEqual(['job-other'])

    const row = app!.db
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get(conversationId)
    expect(row).toBeUndefined()
  })

  it('does not touch Hermes jobs when deleting a regular conversation', async () => {
    const create = await app!.inject({
      method: 'POST',
      url: '/conversations',
      headers: { authorization: `Bearer ${operatorToken}` },
    })
    const conversation = create.json() as { id: string }

    const del = await app!.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    })

    expect(del.statusCode).toBe(204)

    const parsed = JSON.parse(await fs.readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ id: string }>
    }
    expect(parsed.jobs.map((job) => job.id)).toEqual(['job-linked', 'job-other'])
  })
})