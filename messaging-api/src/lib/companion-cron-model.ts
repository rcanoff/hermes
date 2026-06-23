export const COMPANION_CRON_DEFAULT_PROVIDER = 'xai-oauth'
export const COMPANION_CRON_DEFAULT_MODEL = 'grok-composer-2.5-fast'

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

  if (shouldUpgradeCompanionCronModel(model, provider)) {
    return target
  }

  return null
}

function shouldUpgradeCompanionCronModel(
  model: string | null,
  provider: string | null,
): boolean {
  if (!model) {
    return true
  }

  if (model === 'gpt-5.4-mini' && (!provider || provider === 'openai-api')) {
    return true
  }

  if (model === 'gpt-5.4' && (!provider || provider === 'openai-api')) {
    return true
  }

  return false
}