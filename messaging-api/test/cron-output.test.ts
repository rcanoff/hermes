import { describe, expect, it } from 'vitest'
import {
  extractResponseSection,
  extractRunTime,
  parseCronOutputMarkdown,
  parseCronOutputPath,
} from '../src/lib/cron-output.js'

const SAMPLE = `# Cron Job: Drink water reminder

**Job ID:** 4093912bd33a
**Run Time:** 2026-06-18 23:21:36
**Schedule:** once in 1m

## Prompt

Send a reminder to drink water.

## Response

Drink some water.
`

describe('parseCronOutputMarkdown', () => {
  it('extracts the response section and run time', () => {
    expect(parseCronOutputMarkdown(SAMPLE)).toEqual({
      response: 'Drink some water.',
      runAt: '2026-06-18 23:21:36',
    })
  })

  it('returns null when the response section is missing', () => {
    expect(extractResponseSection('# Cron Job\n\n## Prompt\n\nHi')).toBeNull()
  })

  it('parses cron output paths under the configured directory', () => {
    expect(
      parseCronOutputPath(
        '/opt/data/cron/output',
        '/opt/data/cron/output/4093912bd33a/2026-06-18_23-21-36.md',
      ),
    ).toEqual({
      hermesJobId: '4093912bd33a',
      relativePath: '4093912bd33a/2026-06-18_23-21-36.md',
    })
  })

  it('rejects paths outside the output directory', () => {
    expect(
      parseCronOutputPath('/opt/data/cron/output', '/opt/data/cron/jobs.json'),
    ).toBeNull()
  })

  it('extracts run time from markdown metadata', () => {
    expect(extractRunTime(SAMPLE)).toBe('2026-06-18 23:21:36')
  })
})