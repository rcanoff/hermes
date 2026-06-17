export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HermesPromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface BuildHermesMessagesOptions {
  bootstrapPrompt?: string | null
  companionUsername?: string
}

const USERNAME_SAFETY_TEMPLATE =
  'The authenticated companion user for this conversation is "{username}". Use this username for companion MCP data calls unless the user explicitly asks about someone else.'

export function buildHermesSystemPrompt(options?: BuildHermesMessagesOptions): string {
  const parts: string[] = []
  const bootstrap = options?.bootstrapPrompt?.trim()

  if (bootstrap) {
    parts.push(bootstrap)
  }

  const username = options?.companionUsername?.trim()
  if (username && !bootstrap?.includes(username)) {
    parts.push(USERNAME_SAFETY_TEMPLATE.replace('{username}', username))
  }

  return parts.join(' ')
}

export function buildHermesMessages(
  history: TranscriptMessage[],
  options?: BuildHermesMessagesOptions,
): HermesPromptMessage[] {
  const systemContent = buildHermesSystemPrompt(options)
  const messages: HermesPromptMessage[] = []

  if (systemContent) {
    messages.push({ role: 'system', content: systemContent })
  }

  return [
    ...messages,
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ]
}