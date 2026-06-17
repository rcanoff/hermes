export const BOOTSTRAP_PROMPT_MAX_LENGTH = 4000

export function validateBootstrap(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > BOOTSTRAP_PROMPT_MAX_LENGTH) {
    return null
  }

  return trimmed
}