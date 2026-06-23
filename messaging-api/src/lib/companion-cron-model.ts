export const COMPANION_CRON_DEFAULT_PROVIDER = 'openai-api'
export const COMPANION_CRON_DEFAULT_MODEL = 'gpt-5.4'

export interface CompanionCronModelTarget {
  model: string
  provider: string
}

/** Returns model/provider to write, or null when jobs.json needs no change. */
export function companionCronModelPatch(current: {
  model?: string | null
  provider?: string | null
}): CompanionCronModelTarget | null {
  const model = current.model?.trim() || null
  const provider = current.provider?.trim() || null
  const target: CompanionCronModelTarget = {
    model: COMPANION_CRON_DEFAULT_MODEL,
    provider: COMPANION_CRON_DEFAULT_PROVIDER,
  }

  if (model === target.model && provider === target.provider) {
    return null
  }

  // Unset inherits config default (gpt-5.4-mini). Upgrade explicit mini as well.
  if (!model || model === 'gpt-5.4-mini') {
    if (!provider || provider === COMPANION_CRON_DEFAULT_PROVIDER) {
      return target
    }
  }

  return null
}