import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProcessByAssistantMessageIds } from '../src/db/repos/process.js'
import {
  createJobConversation,
  linkJobConversation,
} from '../src/db/repos/conversations.js'
import { CronOutputBridge } from '../src/services/cron-output-bridge.js'
import { createTestApp } from './helpers/app.js'
import { createHermesStateDb, seedCronSession } from './helpers/hermes-state-db.js'
import { seedTestUser } from './helpers/users.js'

const SAMPLE_OUTPUT = `# Cron Job: Drink water reminder

**Job ID:** job-abc
**Run Time:** 2026-06-18 23:21:36
**Schedule:** once in 1m

## Prompt

Send a reminder.

## Response

Drink some water.
`

describe('CronOutputBridge', () => {
  let outputDir: string
  let stateDbPath: string

  beforeEach(async () => {
    outputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cron-output-bridge-'))
    stateDbPath = path.join(os.tmpdir(), `cron-state-${Date.now()}.db`)
  })

  afterEach(async () => {
    await fsPromises.rm(outputDir, { recursive: true, force: true })
    fs.rmSync(stateDbPath, { force: true })
  })

  it('delivers linked cron output files into the job conversation', async () => {
    const app = await createTestApp({ cronOutputDir: outputDir })
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    const jobConversationId = createJobConversation(app.db, seeded.id, 'operator', {
      name: 'Drink water reminder',
      scheduleDisplay: 'once in 1m',
    })
    linkJobConversation(app.db, seeded.id, {
      conversationId: jobConversationId,
      hermesJobId: 'job-abc',
      username: 'operator',
    })

    const bridge = new CronOutputBridge({ db: app.db, outputDir, hermesStateDbPath: stateDbPath })
    const jobDir = path.join(outputDir, 'job-abc')
    await fsPromises.mkdir(jobDir, { recursive: true })
    await fsPromises.writeFile(path.join(jobDir, '2026-06-18_23-21-36.md'), SAMPLE_OUTPUT)

    await bridge.poll()

    const message = app.db
      .prepare(`
        SELECT role, content
        FROM messages
        WHERE conversation_id = ?
      `)
      .get(jobConversationId) as { role: string; content: string }

    expect(message).toEqual({ role: 'assistant', content: 'Drink some water.' })

    const delivered = app.db
      .prepare('SELECT output_path FROM cron_output_deliveries')
      .pluck()
      .get() as string
    expect(delivered).toBe('job-abc/2026-06-18_23-21-36.md')

    await bridge.poll()
    const messageCount = app.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
      .get(jobConversationId) as { count: number }
    expect(messageCount.count).toBe(1)

    await app.close()
  })

  it('ignores output for unlinked Hermes jobs', async () => {
    const app = await createTestApp({ cronOutputDir: outputDir })
    await app.ready()

    const bridge = new CronOutputBridge({ db: app.db, outputDir, hermesStateDbPath: stateDbPath })
    const jobDir = path.join(outputDir, 'orphan-job')
    await fsPromises.mkdir(jobDir, { recursive: true })
    await fsPromises.writeFile(path.join(jobDir, '2026-06-18_23-21-36.md'), SAMPLE_OUTPUT)

    await bridge.poll()

    const count = app.db
      .prepare('SELECT COUNT(*) AS count FROM messages')
      .get() as { count: number }
    expect(count.count).toBe(0)

    await app.close()
  })

  it('attaches cron session tooling to delivered assistant messages', async () => {
    const app = await createTestApp({ cronOutputDir: outputDir })
    await app.ready()

    const seeded = await seedTestUser(app, 'operator', 'password123')
    const jobConversationId = createJobConversation(app.db, seeded.id, 'operator', {
      name: 'HA digest',
      scheduleDisplay: '0 9 * * *',
    })
    linkJobConversation(app.db, seeded.id, {
      conversationId: jobConversationId,
      hermesJobId: 'job-abc',
      username: 'operator',
    })

    const stateDb = createHermesStateDb(stateDbPath)
    seedCronSession(stateDb, {
      sessionId: 'cron_job-abc_20260618_232100',
      endedAtUnix: Date.parse('2026-06-18T23:21:36Z') / 1000,
      messages: [
        {
          role: 'assistant',
          tool_calls: JSON.stringify([
            {
              function: {
                name: 'skill_view',
                arguments: JSON.stringify({ name: 'companion-cron' }),
              },
            },
          ]),
          timestamp: 1,
        },
      ],
    })
    stateDb.close()

    const bridge = new CronOutputBridge({ db: app.db, outputDir, hermesStateDbPath: stateDbPath })
    const jobDir = path.join(outputDir, 'job-abc')
    await fsPromises.mkdir(jobDir, { recursive: true })
    await fsPromises.writeFile(path.join(jobDir, '2026-06-18_23-21-36.md'), SAMPLE_OUTPUT)

    await bridge.poll()

    const message = app.db
      .prepare('SELECT id, role, content FROM messages WHERE conversation_id = ?')
      .get(jobConversationId) as { id: string; role: string; content: string }

    const processMap = getProcessByAssistantMessageIds(app.db, [message.id])
    expect(processMap.get(message.id)).toEqual({
      lines: [
        {
          phase: 'activity',
          text: 'Loading skill: companion-cron',
          tool: 'skill_view',
          args: { name: 'companion-cron' },
        },
      ],
    })

    await app.close()
  })
})