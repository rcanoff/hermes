import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  COMPANION_CRON_DEFAULT_MODEL,
  COMPANION_CRON_DEFAULT_PROVIDER,
} from '../src/lib/companion-cron-model.js'
import { findConversationByHermesJobId } from '../src/db/repos/conversations.js'
import { insertMessage } from '../src/db/repos/messages.js'
import { autoLinkNewCompanionCronJobs } from '../src/services/companion-cron-auto-link.js'
import type { HermesClient } from '../src/services/hermes-client.js'
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
      jobs: Array<{
        id: string
        prompt: string
        skills?: string[]
        model?: string | null
        provider?: string | null
      }>
    }
    const patchedJob = jobsOnDisk.jobs.find((job) => job.id === 'new-water-job')
    expect(patchedJob?.prompt).toBe(
      'Send a reminder to get water to the current conversation user.',
    )
    expect(patchedJob?.skills ?? []).toEqual([])
    expect(patchedJob?.model).toBe(COMPANION_CRON_DEFAULT_MODEL)
    expect(patchedJob?.provider).toBe(COMPANION_CRON_DEFAULT_PROVIDER)

    await app.close()
  })

  it('classifies one-shot HA-topic reminders instead of replacing them with digest prompts', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-1', 'regular', datetime('now'))
    `).run(seeded.id)

    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'assistant',
      content:
        'Try Bermuda tuning in Home Assistant → Bermuda BLE Trilateration → Configure. Start with smoothing_samples.',
    })
    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'remind me to look into that later at 7pm',
    })

    const bermudaDraftPrompt =
      'Reminder: look into tuning Bermuda for the bedroom fan flicker. Check Bermuda settings in Home Assistant and adjust smoothing_samples.'

    await fs.writeFile(
      jobsPath,
      JSON.stringify({
        jobs: [
          ...INITIAL_JOBS.jobs,
          {
            id: 'bermuda-job',
            name: 'Bermuda tuning follow-up',
            prompt: bermudaDraftPrompt,
            deliver: 'local',
            schedule_display: 'once at 2026-06-22 19:00',
            created_at: '2026-06-22T03:01:38+00:00',
          },
        ],
      }),
    )

    const completeChat = vi.fn().mockResolvedValue(
      JSON.stringify({
        kind: 'reminder',
        prompt: `Scheduled reminder. Your entire response must be the user-facing reminder message only.

Output exactly:

Reminder: Tune Bermuda for the bedroom fan flicker.

Open Home Assistant → Bermuda BLE Trilateration → Configure. Start with smoothing_samples.`,
      }),
    )
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const linked = await autoLinkNewCompanionCronJobs({
      db: app.db,
      userId: seeded.id,
      username: 'operator',
      sourceConversationId: 'regular-1',
      cronJobsPath: jobsPath,
      knownJobIdsBefore: new Set(['existing-job']),
      sawCronjobTool: true,
      hermesClient,
      cronPromptSynthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 60_000 },
    })

    expect(linked).toHaveLength(1)

    const jobsOnDisk = JSON.parse(await readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ id: string; prompt: string }>
    }
    const patchedJob = jobsOnDisk.jobs.find((job) => job.id === 'bermuda-job')
    expect(patchedJob?.prompt).toContain('Tune Bermuda')
    expect(patchedJob?.prompt).not.toContain('MANDATORY TOOL USE')
    expect(completeChat).toHaveBeenCalledOnce()

    await app.close()
  })

  it('synthesizes cron prompt from recent conversation messages', async () => {
    const app = await createTestApp()
    await app.ready()
    const seeded = await seedTestUser(app, 'operator', 'password123')

    app.db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id, kind, updated_at)
      VALUES ('regular-1', ?, 'sess-1', 'regular', datetime('now'))
    `).run(seeded.id)

    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'assistant',
      content: 'Coastal cliffs — maybe Madeira.',
    })
    insertMessage(app.db, {
      conversationId: 'regular-1',
      role: 'user',
      content: 'Remind me to look into this at 7pm',
    })

    await fs.writeFile(
      jobsPath,
      JSON.stringify({
        jobs: [
          ...INITIAL_JOBS.jobs,
          {
            id: 'context-job',
            name: 'Look into this at 7pm Berlin',
            prompt: 'Reminder: Look into this.',
            deliver: 'local',
            schedule_display: 'once at 2026-06-22 19:00',
            created_at: '2026-06-22T01:47:57+00:00',
          },
        ],
      }),
    )

    const completeChat = vi.fn().mockResolvedValue(
      JSON.stringify({
        kind: 'reminder',
        prompt: `Scheduled reminder. Your entire response must be the user-facing reminder message only.

Output exactly:

Reminder: Look into where this photo was taken.

Earlier we guessed a coastal overlook — steep cliffs, turquoise water — possibly Madeira or the Azores.`,
      }),
    )
    const hermesClient: HermesClient = {
      completeChat,
      async *streamChat() {},
      ensureSession: async () => {},
    }

    const linked = await autoLinkNewCompanionCronJobs({
      db: app.db,
      userId: seeded.id,
      username: 'operator',
      sourceConversationId: 'regular-1',
      cronJobsPath: jobsPath,
      knownJobIdsBefore: new Set(['existing-job']),
      sawCronjobTool: true,
      hermesClient,
      cronPromptSynthesisLlm: { apiKey: '', baseUrl: '', model: 'gpt-5.4', timeoutMs: 60_000 },
    })

    expect(linked).toHaveLength(1)

    const jobsOnDisk = JSON.parse(await readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ id: string; prompt: string }>
    }
    const patchedJob = jobsOnDisk.jobs.find((job) => job.id === 'context-job')
    expect(patchedJob?.prompt).toContain('Reminder: Look into where this photo was taken')
    expect(patchedJob?.prompt).toContain('Madeira')
    expect(completeChat).toHaveBeenCalledOnce()

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