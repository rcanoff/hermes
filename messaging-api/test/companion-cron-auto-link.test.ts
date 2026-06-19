import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { buildReminderCronPrompt } from '../src/lib/companion-cron-prompt.js'
import { findConversationByHermesJobId } from '../src/db/repos/conversations.js'
import { autoLinkNewCompanionCronJobs } from '../src/services/companion-cron-auto-link.js'
import { createTestApp } from './helpers/app.js'
import { seedTestUser } from './helpers/users.js'

const INITIAL_JOBS = {
  jobs: [
    {
      id: 'existing-job',
      name: 'Existing job',
      deliver: 'local',
      schedule_display: '30 9 * * *',
      created_at: '2026-06-18T00:00:00+00:00',
    },
  ],
}

describe('autoLinkNewCompanionCronJobs', () => {
  let jobsPath: string
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-auto-link-'))
    jobsPath = path.join(tempDir, 'jobs.json')
    await fs.writeFile(jobsPath, JSON.stringify(INITIAL_JOBS))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('creates and links job conversations for new deliver:local cron jobs', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-1', 'regular', datetime('now'))
    `).run(seeded.id)

    await fs.writeFile(
      jobsPath,
      JSON.stringify({
        jobs: [
          ...INITIAL_JOBS.jobs,
          {
            id: 'new-water-job',
            name: 'Get water reminder',
            prompt: 'Send a reminder to get water to the current conversation user.',
            deliver: 'local',
            schedule_display: 'once in 1m',
            created_at: '2026-06-19T07:17:16+00:00',
          },
        ],
      }),
    )

    const linked = await autoLinkNewCompanionCronJobs({
      db: app.db,
      userId: seeded.id,
      username: 'operator',
      sourceConversationId: 'regular-1',
      cronJobsPath: jobsPath,
      knownJobIdsBefore: new Set(['existing-job']),
      sawCronjobTool: true,
    })

    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({
      hermesJobId: 'new-water-job',
      conversationId: expect.any(String),
    })

    const jobConversation = findConversationByHermesJobId(app.db, 'new-water-job')
    expect(jobConversation).toMatchObject({
      kind: 'job',
      title: 'Get water reminder',
      schedule_display: 'once in 1m',
      user_id: seeded.id,
    })

    const seedMessage = app.db
      .prepare(`
        SELECT role, content
        FROM messages
        WHERE conversation_id = ?
      `)
      .get(jobConversation!.id) as { role: string; content: string }

    expect(seedMessage).toEqual({
      role: 'assistant',
      content: 'Scheduled: once in 1m\n\nGet water reminder',
    })

    const jobsOnDisk = JSON.parse(await readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ id: string; prompt: string }>
    }
    expect(jobsOnDisk.jobs.find((job) => job.id === 'new-water-job')?.prompt).toBe(
      buildReminderCronPrompt('Get water'),
    )

    await app.close()
  })

  it('does nothing when cronjob tool was not used', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-1', 'regular', datetime('now'))
    `).run(seeded.id)

    await fs.writeFile(
      jobsPath,
      JSON.stringify({
        jobs: [
          ...INITIAL_JOBS.jobs,
          {
            id: 'orphan-job',
            name: 'Orphan',
            deliver: 'local',
            schedule_display: 'once in 1m',
          },
        ],
      }),
    )

    const linked = await autoLinkNewCompanionCronJobs({
      db: app.db,
      userId: seeded.id,
      username: 'operator',
      sourceConversationId: 'regular-1',
      cronJobsPath: jobsPath,
      knownJobIdsBefore: new Set(['existing-job']),
      sawCronjobTool: false,
    })

    expect(linked).toEqual([])
    expect(findConversationByHermesJobId(app.db, 'orphan-job')).toBeUndefined()

    await app.close()
  })
})