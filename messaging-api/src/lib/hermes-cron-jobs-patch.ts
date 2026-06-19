import { readFile, writeFile } from 'node:fs/promises'

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

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}