import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface HermesCronJob {
  id: string
  name: string
  prompt?: string | null
  deliver: string
  schedule_display?: string | null
  created_at?: string | null
  enabled?: boolean
  skills?: string[]
  model?: string | null
  provider?: string | null
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
      skills: normalizeJobSkills(job.skills),
      model: typeof job.model === 'string' ? job.model : null,
      provider: typeof job.provider === 'string' ? job.provider : null,
    }))
}

export function listHermesJobIds(jobs: HermesCronJob[]): Set<string> {
  return new Set(jobs.map((job) => job.id))
}

export async function listHermesJobIdsFromFile(jobsPath: string): Promise<Set<string>> {
  const jobs = await readHermesCronJobs(jobsPath)
  return listHermesJobIds(jobs)
}

export type RemoveHermesCronJobResult = 'removed' | 'not_found' | 'missing_file'

export async function removeHermesCronJob(
  jobsPath: string,
  hermesJobId: string,
): Promise<RemoveHermesCronJobResult> {
  const jobId = hermesJobId.trim()
  if (!jobId) {
    return 'not_found'
  }

  let raw: string
  try {
    raw = await readFile(jobsPath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return 'missing_file'
    }
    throw error
  }

  const parsed = JSON.parse(raw) as { jobs?: unknown; updated_at?: string }
  if (!Array.isArray(parsed.jobs)) {
    return 'not_found'
  }

  const jobs = parsed.jobs
  const before = jobs.length
  const remaining = jobs.filter((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return true
    }
    return (entry as { id?: string }).id !== jobId
  })

  if (remaining.length === before) {
    return 'not_found'
  }

  parsed.jobs = remaining
  parsed.updated_at = new Date().toISOString()
  await writeFile(jobsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return 'removed'
}

function isHermesCronJobRecord(value: unknown): value is {
  id: string
  name: string
  prompt?: unknown
  deliver: string
  schedule_display?: unknown
  created_at?: unknown
  enabled?: unknown
  skills?: unknown
  model?: unknown
  provider?: unknown
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

function normalizeJobSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) {
    return []
  }

  return skills
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}