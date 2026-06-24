import type { HermesPromptMessage } from './prompt-builder.js'

export interface CompleteHermesAuxiliaryInput {
  provider: string
  model: string
  messages: HermesPromptMessage[]
  timeoutMs: number
}

interface CompleteHermesAuxiliaryResponse {
  content?: string
  error?: string
}

export async function completeHermesAuxiliary(
  bridgeUrl: string,
  apiKey: string,
  input: CompleteHermesAuxiliaryInput,
): Promise<string> {
  const base = bridgeUrl.trim().replace(/\/$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)

  try {
    const response = await fetch(`${base}/v1/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        provider: input.provider,
        model: input.model,
        messages: input.messages,
        max_tokens: 64,
        temperature: 0.3,
        timeout: input.timeoutMs / 1000,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Hermes auxiliary bridge failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }

    const payload = (await response.json()) as CompleteHermesAuxiliaryResponse
    return payload.content ?? ''
  } finally {
    clearTimeout(timeout)
  }
}