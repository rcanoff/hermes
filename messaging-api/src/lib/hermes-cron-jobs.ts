import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface HermesCronJob {
  id: string
  name: string
  prompt?: string | null
  deliver: string
  schedule_display?: string | null
  created_at?: string | null
  enabled?: boolean
}

export function deriveCronJobsPath(cronOutputDir: string): string {
  return join(dirname(cronOutputDir), 'jobs.json')
}

export function isCompanionLocalDeliver(deliver: string | null | undefined): boolean {
  return deliver?.trim() === 'local'
}

export async function readHermesCronJobs(jobsPath: string): Promise<HermesCronJob[]> {
  let raw: string
  try {
    raw = await readFile(jobsPath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }
    throw error
  }

  const parsed = JSON.parse(raw) as { jobs?: unknown }
  if (!Array.isArray(parsed.jobs)) {
    return []
  }

  return parsed.jobs
    .filter(isHermesCronJobRecord)
    .map((job) => ({
      id: job.id.trim(),
      name: job.name.trim(),
      prompt: typeof job.prompt === 'string' ? job.prompt : null,
      deliver: job.deliver.trim(),
      schedule_display: typeof job.schedule_display === 'string' ? job.schedule_display : null,
      created_at: typeof job.created_at === 'string' ? job.created_at : null,
      enabled: job.enabled !== false,
    }))
}

export function listHermesJobIds(jobs: HermesCronJob[]): Set<string> {
  return new Set(jobs.map((job) => job.id))
}

export async function listHermesJobIdsFromFile(jobsPath: string): Promise<Set<string>> {
  const jobs = await readHermesCronJobs(jobsPath)
  return listHermesJobIds(jobs)
}

function isHermesCronJobRecord(value: unknown): value is {
  id: string
  name: string
  prompt?: unknown
  deliver: string
  schedule_display?: unknown
  created_at?: unknown
  enabled?: unknown
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.trim().length > 0 &&
    typeof record.name === 'string' &&
    record.name.trim().length > 0 &&
    typeof record.deliver === 'string' &&
    record.deliver.trim().length > 0
  )
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}