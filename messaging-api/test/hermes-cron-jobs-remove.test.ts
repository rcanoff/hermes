import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeHermesCronJob } from '../src/lib/hermes-cron-jobs.js'

const INITIAL_JOBS = {
  jobs: [
    {
      id: 'job-keep',
      name: 'Keep me',
      deliver: 'local',
      schedule_display: '0 9 * * *',
    },
    {
      id: 'job-remove',
      name: 'Remove me',
      deliver: 'local',
      schedule_display: '0 9 * * *',
    },
  ],
  updated_at: '2026-06-21T00:00:00+00:00',
}

describe('removeHermesCronJob', () => {
  let tempDir: string
  let jobsPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-remove-'))
    jobsPath = path.join(tempDir, 'jobs.json')
    await fs.writeFile(jobsPath, `${JSON.stringify(INITIAL_JOBS, null, 2)}\n`, 'utf8')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('removes a job from jobs.json', async () => {
    const result = await removeHermesCronJob(jobsPath, 'job-remove')
    expect(result).toBe('removed')

    const parsed = JSON.parse(await fs.readFile(jobsPath, 'utf8')) as {
      jobs: Array<{ id: string }>
      updated_at: string
    }
    expect(parsed.jobs.map((job) => job.id)).toEqual(['job-keep'])
    expect(parsed.updated_at).not.toBe(INITIAL_JOBS.updated_at)
  })

  it('returns not_found when the job id is absent', async () => {
    const result = await removeHermesCronJob(jobsPath, 'missing-job')
    expect(result).toBe('not_found')
  })

  it('returns missing_file when jobs.json does not exist', async () => {
    const result = await removeHermesCronJob(path.join(tempDir, 'missing.json'), 'job-remove')
    expect(result).toBe('missing_file')
  })
})