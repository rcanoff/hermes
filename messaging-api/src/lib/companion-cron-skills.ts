export const COMPANION_CRON_SKILL = 'companion-cron'
export const HOME_ASSISTANT_MCP_SKILL = 'home-assistant-mcp'

const HOME_ASSISTANT_JOB_PATTERN =
  /home assistant|\bha mcp\b|mcp_ha_|house overview|daily digest|daily house/i

export function normalizeSkillsList(skills: unknown): string[] {
  if (!Array.isArray(skills)) {
    return []
  }

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of skills) {
    if (typeof entry !== 'string') {
      continue
    }
    const name = entry.trim()
    if (!name || seen.has(name)) {
      continue
    }
    seen.add(name)
    normalized.push(name)
  }
  return normalized
}

export function isHomeAssistantCompanionJob(input: {
  name?: string | null
  prompt?: string | null
}): boolean {
  const text = `${input.name ?? ''}\n${input.prompt ?? ''}`
  return HOME_ASSISTANT_JOB_PATTERN.test(text)
}

/** Run-time skills for scheduled execution — not job-chat bootstrap skills. */
export function resolveCompanionCronSkills(input: {
  name?: string | null
  prompt?: string | null
}): string[] {
  // HA digest jobs use a self-contained cron prompt (see companion-cron-prompt.ts).
  // Inlining home-assistant-mcp bloats the run and encourages [SILENT] without tool use.
  return []
}

/** Returns the skills array to write, or null when jobs.json needs no change. */
export function companionCronSkillsPatch(
  current: unknown,
  input: {
    name?: string | null
    prompt?: string | null
  },
): string[] | null {
  const existing = normalizeSkillsList(current)
  const stripped = existing.filter(
    (skill) => skill !== COMPANION_CRON_SKILL && skill !== HOME_ASSISTANT_MCP_SKILL,
  )

  if (existing.includes(COMPANION_CRON_SKILL) || existing.includes(HOME_ASSISTANT_MCP_SKILL)) {
    return stripped
  }

  return null
}