export const HOME_ASSISTANT_DIGEST_PROMPT_MARKER = 'MANDATORY TOOL USE (do not skip)'

export type CompanionCronJobKind = 'reminder' | 'ha_digest' | 'monitoring'

const ONE_SHOT_SCHEDULE_PATTERN = /^once\b/i
const REMINDER_REQUEST_PATTERN =
  /\b(remind(?:er)? me|look into (?:this|that|it)(?: later)?|follow[- ]?up)\b/i
const DIGEST_NAME_PATTERN =
  /\b(ha daily digest|home assistant daily(?:\s+report)?|daily digest|house overview)\b/i
const DIGEST_PROMPT_PATTERN =
  /\b(daily digest|yesterday(?:'s)?\s+(?:calendar day|logbook)|produce\s+(?:a\s+)?(?:compact\s+)?(?:ha|home assistant)\s+digest)\b/i
const MONITORING_NAME_PATTERN = /\b(watch|monitor|checker|inbox watch)\b/i

export function buildHomeAssistantDigestCronPrompt(): string {
  return `Produce a compact Home Assistant digest for YESTERDAY's calendar day in Europe/Berlin (not today). Do not use shell date commands unless necessary; use HA logbook with end_time at yesterday's Berlin midnight boundary expressed in UTC plus hours_back=24.

${HOME_ASSISTANT_DIGEST_PROMPT_MARKER}:
- Use only HA MCP tools via Hermes deferred-tool discovery: tool_search → tool_call on mcp_ha_ha_get_logs, mcp_ha_ha_eval_template, mcp_ha_ha_search_entities, etc.
- tool_search is the Hermes function named exactly "tool_search" — NOT web_search, NOT skill_view, NOT skills_list.
- Call tool_search("home assistant logbook") first, then mcp_ha_ha_get_logs (logbook, compact=true, paginate with offset), then mcp_ha_ha_get_logs (source="system", level="ERROR"), then mcp_ha_ha_eval_template for battery <20%.
- Never respond "[SILENT]" or claim tools are unavailable without completing those tool_search + mcp_ha_* calls.
- Only use "[SILENT]" after those queries succeed and there is genuinely nothing noteworthy.

OUTPUT RULES (strict — this is the entire user-visible message):
- Max ~8 lines of content; no preamble, no tool narration, no job_id, no "Cronjob Response" header.
- Header: one line with Berlin date label for yesterday.
- Section "Automations": bullet only automations that actually triggered; name + brief when/why; skip zero-fire automations.
- Optional one-line "Notable" only if high-signal (backup, leave-home, one evening cluster).
- "Errors": only if ERROR-level issues in that window (dedupe; redact secrets as [REDACTED]); omit section if none.
- "Battery (<20%)": ONLY if any sensor with battery in entity_id reads <20% at run time via ha_eval_template; omit entire section if none.
- Optional single-line "Action" — one practical fix, not a list.
- Timezone: HA timestamps are UTC; show Berlin times in digest. Final response must be ONLY the digest text.`
}

export function isOneShotCompanionCronSchedule(scheduleDisplay?: string | null): boolean {
  const schedule = scheduleDisplay?.trim() ?? ''
  return schedule.length > 0 && ONE_SHOT_SCHEDULE_PATTERN.test(schedule)
}

export function isExplicitHomeAssistantDigestJob(input: {
  name?: string | null
  prompt?: string | null
  schedule_display?: string | null
}): boolean {
  if (isOneShotCompanionCronSchedule(input.schedule_display)) {
    return false
  }

  const name = (input.name ?? '').trim()
  const prompt = (input.prompt ?? '').trim()

  if (prompt.includes(HOME_ASSISTANT_DIGEST_PROMPT_MARKER)) {
    return false
  }

  return DIGEST_NAME_PATTERN.test(name) || DIGEST_PROMPT_PATTERN.test(prompt)
}

export function inferCompanionCronJobKindHeuristic(input: {
  name?: string | null
  prompt?: string | null
  schedule_display?: string | null
  userTriggerMessage?: string | null
}): CompanionCronJobKind {
  if (isExplicitHomeAssistantDigestJob(input)) {
    return 'ha_digest'
  }

  const name = (input.name ?? '').trim()
  const trigger = (input.userTriggerMessage ?? '').trim()

  if (
    isOneShotCompanionCronSchedule(input.schedule_display) ||
    REMINDER_REQUEST_PATTERN.test(trigger) ||
    REMINDER_REQUEST_PATTERN.test(name)
  ) {
    return 'reminder'
  }

  if (MONITORING_NAME_PATTERN.test(name)) {
    return 'monitoring'
  }

  return 'reminder'
}

export function needsHomeAssistantDigestPromptNormalization(input: {
  name?: string | null
  prompt?: string | null
  schedule_display?: string | null
}): boolean {
  return isExplicitHomeAssistantDigestJob(input)
}

export function normalizeHomeAssistantDigestPrompt(input: {
  name?: string | null
  prompt?: string | null
  schedule_display?: string | null
}): string | null {
  if (!needsHomeAssistantDigestPromptNormalization(input)) {
    return null
  }

  return buildHomeAssistantDigestCronPrompt()
}