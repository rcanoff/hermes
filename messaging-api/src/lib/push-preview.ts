export function stripPushPreview(content: string, maxChars: number): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) {
    return collapsed
  }
  return `${collapsed.slice(0, maxChars)}…`
}

export function buildChatPushAlert(input: {
  title: string | null
  content: string
  maxChars?: number
}): { title: string; body: string } {
  const maxChars = input.maxChars ?? 120
  return {
    title: input.title?.trim() || 'New message',
    body: stripPushPreview(input.content, maxChars),
  }
}

export function buildJobPushAlert(input: {
  title: string | null
  content: string
  scheduleDisplay?: string | null
  maxChars?: number
}): { title: string; body: string } {
  const maxChars = input.maxChars ?? 120
  const name = input.title?.trim() || input.scheduleDisplay?.trim() || 'Scheduled job'
  return {
    title: `Job · ${name}`,
    body: stripPushPreview(input.content, maxChars),
  }
}