import { readFile, writeFile } from 'node:fs/promises'
import { normalizeSkillsList } from './companion-cron-skills.js'

export async function patchHermesCronJobPrompt(
  jobsPath: string,
  hermesJobId: string,
  prompt: string,
): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(jobsPath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }

  const parsed = JSON.parse(raw) as { jobs?: unknown }
  if (!Array.isArray(parsed.jobs)) {
    return false
  }

  let updated = false
  for (const entry of parsed.jobs) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { id?: string }).id === hermesJobId
    ) {
      ;(entry as { prompt: string }).prompt = prompt
      updated = true
      break
    }
  }

  if (!updated) {
    return false
  }

  await writeFile(jobsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return true
}

export async function patchHermesCronJobModel(
  jobsPath: string,
  hermesJobId: string,
  model: string,
  provider: string,
): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(jobsPath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }

  const parsed = JSON.parse(raw) as { jobs?: unknown; updated_at?: string }
  if (!Array.isArray(parsed.jobs)) {
    return false
  }

  let updated = false
  for (const entry of parsed.jobs) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { id?: string }).id === hermesJobId
    ) {
      const record = entry as { model?: string | null; provider?: string | null }
      record.model = model
      record.provider = provider
      updated = true
      break
    }
  }

  if (!updated) {
    return false
  }

  parsed.updated_at = new Date().toISOString()
  await writeFile(jobsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return true
}

export async function patchHermesCronJobSkills(
  jobsPath: string,
  hermesJobId: string,
  skills: string[],
): Promise<boolean> {
  const canonical = normalizeSkillsList(skills)

  let raw: string
  try {
    raw = await readFile(jobsPath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }

  const parsed = JSON.parse(raw) as { jobs?: unknown; updated_at?: string }
  if (!Array.isArray(parsed.jobs)) {
    return false
  }

  let updated = false
  for (const entry of parsed.jobs) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { id?: string }).id === hermesJobId
    ) {
      const record = entry as { skills?: unknown; skill?: string | null }
      record.skills = canonical
      record.skill = canonical[0] ?? null
      updated = true
      break
    }
  }

  if (!updated) {
    return false
  }

  parsed.updated_at = new Date().toISOString()
  await writeFile(jobsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return true
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}