export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HermesPromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function buildHermesMessages(history: TranscriptMessage[]): HermesPromptMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}