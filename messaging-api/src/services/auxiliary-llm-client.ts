import type { HermesPromptMessage } from './prompt-builder.js'

export const DEFAULT_TITLE_GENERATION_MODEL = 'gpt-5.4-nano'

export interface AuxiliaryLlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}

export function isAuxiliaryLlmConfigured(config: AuxiliaryLlmConfig | null | undefined): boolean {
  return Boolean(config?.apiKey.trim())
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '')
  if (!trimmed) {
    return 'https://api.openai.com/v1/chat/completions'
  }
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`
  }
  return `${trimmed}/v1/chat/completions`
}

interface OpenAiChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
    }
  }>
}

export async function completeAuxiliaryLlm(
  config: AuxiliaryLlmConfig,
  messages: HermesPromptMessage[],
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(resolveChatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        temperature: 0.3,
        max_tokens: 64,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Auxiliary LLM request failed with status ${response.status}`)
    }

    const payload = (await response.json()) as OpenAiChatCompletion
    return extractCompletionText(payload.choices?.[0]?.message?.content)
  } finally {
    clearTimeout(timeout)
  }
}

function extractCompletionText(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}