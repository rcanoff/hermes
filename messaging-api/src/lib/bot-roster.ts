export interface RosterBot {
  slug: string
  name: string
  role: string
  responsibilities: string
  is_default: number
}

export const ONBOARDING_JOBS_PLACEHOLDER = '(onboarding — jobs not set yet)'

export const SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION = [
  'Your jobs are not set yet. Do not do specialist work yet.',
  'Ask 2–3 short questions about what you should own.',
  'When you have enough, call MCP tool set_my_responsibilities with a short jobs string (1–3 clauses, no first-person, max 200 characters).',
].join('\n')

export const MESSAGE_TEAMMATE_ROSTER_INSTRUCTION = [
  'To ask a teammate, call MCP tool message_teammate with their name and your request.',
  "The user already sees that send and their reply in this chat. Do not paste the teammate's full reply; one short wrap-up is enough.",
  'Only the main assistant may call this tool.',
].join('\n')

export function buildBotRosterPrompt(
  bots: readonly RosterBot[],
  currentSlug: string,
): string {
  const current = bots.find((bot) => bot.slug === currentSlug)
  if (!current) {
    return ''
  }

  const lines = [`You are ${rosterLabel(current)}. Specialty: ${jobsLine(current, true)}`]
  if (needsOnboarding(current)) {
    lines.push('')
    lines.push(SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION)
  }

  const teammates = bots.filter((bot) => bot.slug !== currentSlug)
  if (teammates.length > 0) {
    lines.push('')
    lines.push(
      'Teammates on this Companion instance (do not impersonate them; they are specialists):',
    )
    for (const teammate of teammates) {
      lines.push(`- ${rosterLabel(teammate)}: ${jobsLine(teammate, false)}`)
    }
  }

  lines.push('')
  lines.push(MESSAGE_TEAMMATE_ROSTER_INSTRUCTION)

  return lines.join('\n')
}

function jobsLine(bot: RosterBot, isSelf: boolean): string {
  const jobs = bot.responsibilities.trim()
  if (jobs) {
    return jobs
  }
  if (!isSelf && bot.is_default !== 1) {
    return ONBOARDING_JOBS_PLACEHOLDER
  }
  return bot.role
}

function needsOnboarding(bot: RosterBot): boolean {
  return bot.is_default !== 1 && bot.responsibilities.trim() === ''
}

function rosterLabel(bot: RosterBot): string {
  return bot.is_default === 1 ? `${bot.name} (main)` : bot.name
}
