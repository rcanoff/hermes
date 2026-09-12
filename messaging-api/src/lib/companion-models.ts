export const COMPANION_DEFAULT_MODEL = 'grok-composer-2.5-fast'
export const COMPANION_DEFAULT_PROVIDER = 'xai-oauth'
export const GROK_TUI_PROVIDER = 'grok'
export const GROK_TUI_SUBTITLE = 'Grok TUI'

export interface CuratedModelEntry {
  model: string
  provider: string
  display: string
  subtitle?: string
}

export const DEFAULT_COMPANION_MODELS: CuratedModelEntry[] = [
  {
    model: COMPANION_DEFAULT_MODEL,
    provider: COMPANION_DEFAULT_PROVIDER,
    display: COMPANION_DEFAULT_MODEL,
    subtitle: 'xAI Grok OAuth (SuperGrok / Premium+)',
  },
  {
    model: 'grok-4.3',
    provider: 'xai-oauth',
    display: 'grok-4.3',
    subtitle: 'xAI Grok OAuth (SuperGrok / Premium+)',
  },
  {
    model: 'gpt-5.4-mini',
    provider: 'openai-codex',
    display: 'gpt-5.4-mini',
    subtitle: 'OpenAI Codex',
  },
]

function isCuratedModelEntry(value: unknown): value is CuratedModelEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const entry = value as Record<string, unknown>
  return (
    typeof entry.model === 'string' &&
    entry.model.trim().length > 0 &&
    typeof entry.provider === 'string' &&
    entry.provider.trim().length > 0 &&
    typeof entry.display === 'string' &&
    entry.display.trim().length > 0 &&
    (entry.subtitle === undefined || typeof entry.subtitle === 'string')
  )
}

export function parseCompanionModelsJson(raw: string | undefined): CuratedModelEntry[] {
  if (!raw?.trim()) {
    return DEFAULT_COMPANION_MODELS
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid_companion_models_json')
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isCuratedModelEntry)) {
    throw new Error('invalid_companion_models_json')
  }

  return parsed
}

export function findCuratedModel(
  catalog: CuratedModelEntry[],
  model: string,
  provider: string,
): CuratedModelEntry | undefined {
  return catalog.find((entry) => entry.model === model && entry.provider === provider)
}

export function curatedModelOrFallback(
  catalog: CuratedModelEntry[],
  model: string,
  provider: string,
): CuratedModelEntry {
  return findCuratedModel(catalog, model, provider) ?? { model, provider, display: model }
}

export function modelDisplayName(
  catalog: CuratedModelEntry[],
  model: string,
  provider: string,
): string {
  return findCuratedModel(catalog, model, provider)?.display ?? model
}

export function assertCuratedModel(
  catalog: CuratedModelEntry[],
  model: string,
  provider: string,
): void {
  if (!catalog.some((entry) => entry.model === model && entry.provider === provider)) {
    throw new Error('invalid_model')
  }
}

export function curatedGrokTuiModels(
  models: Array<{ id: string; display: string }>,
): CuratedModelEntry[] {
  return models.map((entry) => ({
    model: entry.id,
    provider: GROK_TUI_PROVIDER,
    display: entry.display,
    subtitle: GROK_TUI_SUBTITLE,
  }))
}