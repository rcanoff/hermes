import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCronProcessLines,
  loadCronRunProcessLines,
  openHermesStateDb,
  resolveCronSessionId,
} from '../src/services/cron-session-process.js'
import { createHermesStateDb, seedCronSession } from './helpers/hermes-state-db.js'

describe('cron-session-process', () => {
  let stateDbPath: string

  beforeEach(() => {
    stateDbPath = path.join(os.tmpdir(), `hermes-state-${Date.now()}.db`)
  })

  afterEach(() => {
    fs.rmSync(stateDbPath, { force: true })
  })

  it('resolves the cron session closest to the output completion time', () => {
    const db = createHermesStateDb(stateDbPath)
    seedCronSession(db, {
      sessionId: 'cron_job-abc_20260621_152506',
      endedAtUnix: Date.parse('2026-06-21T15:25:49Z') / 1000,
      messages: [],
    })
    seedCronSession(db, {
      sessionId: 'cron_job-abc_20260621_153306',
      endedAtUnix: Date.parse('2026-06-21T15:33:12Z') / 1000,
      messages: [],
    })
    db.close()

    const stateDb = openHermesStateDb(stateDbPath)!
    const sessionId = resolveCronSessionId(
      stateDb,
      'job-abc',
      new Date('2026-06-21T15:25:49Z'),
    )
    stateDb.close()

    expect(sessionId).toBe('cron_job-abc_20260621_152506')
  })

  it('builds tooling lines from assistant tool calls', () => {
    const db = createHermesStateDb(stateDbPath)
    seedCronSession(db, {
      sessionId: 'cron_job-abc_20260621_152506',
      endedAtUnix: Date.parse('2026-06-21T15:25:49Z') / 1000,
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
            {
              function: {
                name: 'mcp_ha_ha_get_logs',
                arguments: JSON.stringify({ hours_back: 24 }),
              },
            },
          ]),
          timestamp: 1,
        },
      ],
    })
    db.close()

    const stateDb = openHermesStateDb(stateDbPath)!
    const lines = buildCronProcessLines(stateDb, 'cron_job-abc_20260621_152506')
    stateDb.close()

    expect(lines).toEqual([
      {
        phase: 'activity',
        text: 'Loading skill: companion-cron',
        tool: 'skill_view',
        args: { name: 'companion-cron' },
      },
      {
        phase: 'activity',
        text: 'Running mcp ha ha get logs',
        tool: 'mcp_ha_ha_get_logs',
        args: { hours_back: 24 },
      },
    ])
  })

  it('loads process lines end-to-end for a cron run', () => {
    const db = createHermesStateDb(stateDbPath)
    seedCronSession(db, {
      sessionId: 'cron_job-abc_20260621_152506',
      endedAtUnix: Date.parse('2026-06-21T15:25:49Z') / 1000,
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'Need yesterday window first.',
          timestamp: 1,
        },
        {
          role: 'assistant',
          tool_calls: JSON.stringify([
            {
              function: {
                name: 'tool_search',
                arguments: JSON.stringify({ query: 'home assistant logs' }),
              },
            },
          ]),
          timestamp: 2,
        },
      ],
    })
    db.close()

    const lines = loadCronRunProcessLines({
      hermesStateDbPath: stateDbPath,
      hermesJobId: 'job-abc',
      completedAt: new Date('2026-06-21T15:25:49Z'),
    })

    expect(lines).toEqual([
      {
        phase: 'reasoning',
        text: 'Need yesterday window first.',
      },
      {
        phase: 'activity',
        text: 'Searching tools: home assistant logs',
        tool: 'tool_search',
        args: { query: 'home assistant logs' },
      },
    ])
  })
})