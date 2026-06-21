export const REMINDER_OUTPUT_PREFIX =
  'Scheduled reminder only. Your entire response must be exactly one line:'

export const RICH_REMINDER_OUTPUT_PREFIX =
  'Scheduled reminder only. Your entire response must match the following message exactly (including fences and links). Do not add, remove, or rephrase anything:'

const REMINDER_FOOTER = 'No tools. No other text, steps, or narration.'

export function buildReminderCronPrompt(reminderText: string): string {
  const line = reminderText.trim().replace(/\s+/g, ' ')
  const body = line.startsWith('Reminder:') ? line : `Reminder: ${line}`
  return `${REMINDER_OUTPUT_PREFIX}

${body}

${REMINDER_FOOTER}`
}

export function buildRichReminderCronPrompt(precomposedBody: string): string {
  const body = precomposedBody.trim()
  if (!body) {
    throw new Error('Rich reminder body must not be empty')
  }

  return `${RICH_REMINDER_OUTPUT_PREFIX}

${body}

${REMINDER_FOOTER}`
}

export function isCompanionReminderTemplate(prompt: string): boolean {
  const trimmed = prompt.trim()
  return (
    trimmed.includes(REMINDER_OUTPUT_PREFIX) || trimmed.includes(RICH_REMINDER_OUTPUT_PREFIX)
  )
}

export function needsReminderPromptNormalization(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (!trimmed) {
    return true
  }

  if (isCompanionReminderTemplate(trimmed)) {
    return false
  }

  if (trimmed.includes('```map')) {
    return false
  }

  const lower = trimmed.toLowerCase()
  const badPhrases = [
    'send a reminder',
    'send the user',
    'send the reminder',
    'notify the user',
    'message the user',
    'current conversation user',
    'deliver to',
    'use the companion',
    'use send_message',
  ]

  return badPhrases.some((phrase) => lower.includes(phrase))
}

export function extractReminderLabel(input: { name: string; prompt?: string | null }): string {
  const fromName = input.name.trim().replace(/\s+reminder$/i, '').trim()
  if (fromName) {
    return fromName
  }

  const prompt = input.prompt?.trim() ?? ''
  const match = /remind(?:er)?(?:\s+to)?\s+(.+?)(?:\.|$)/i.exec(prompt)
  if (match?.[1]) {
    return match[1].trim()
  }

  return 'Complete your reminder task'
}

export function normalizeCompanionReminderPrompt(input: {
  name: string
  prompt?: string | null
}): string | null {
  const prompt = input.prompt?.trim() ?? ''
  if (!needsReminderPromptNormalization(prompt)) {
    return null
  }

  return buildReminderCronPrompt(extractReminderLabel(input))
}