import { existsSync, readFileSync } from 'node:fs'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
  DEFAULT_COMPANION_MODELS,
  parseCompanionModelsJson,
  type CuratedModelEntry,
} from './companion-models.js'

export const DEFAULT_PROVIDER_MODELS_CACHE_PATH = '/opt/data/provider_models_cache.json'

/** Same provider order as Hermes Telegram `/model` picker (`list_picker_providers`). */
const PICKER_PROVIDER_ORDER = ['openrouter', 'openai-api', 'xai-oauth', 'openai-codex'] as const

/** Display names aligned with `list_picker_providers` (`name` field). */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  'openai-api': 'openai-api',
  'xai-oauth': 'xAI Grok OAuth (SuperGrok / Premium+)',
  'openai-codex': 'OpenAI Codex',
}

interface ProviderCacheEntry {
  models?: string[]
}

type ProviderModelsCache = Record<string, ProviderCacheEntry>

export function buildCatalogFromProviderCache(cache: ProviderModelsCache): CuratedModelEntry[] {
  const catalog: CuratedModelEntry[] = []

  for (const provider of PICKER_PROVIDER_ORDER) {
    const models = cache[provider]?.models
    if (!Array.isArray(models) || models.length === 0) {
      continue
    }

    const subtitle = PROVIDER_DISPLAY_NAMES[provider] ?? provider
    for (const model of models) {
      if (typeof model !== 'string' || !model.trim()) {
        continue
      }

      catalog.push({
        model,
        provider,
        display: model,
        subtitle,
      })
    }
  }

  return catalog
}

export function loadCompanionModelCatalog(cachePath: string): CuratedModelEntry[] {
  if (!cachePath.trim() || !existsSync(cachePath)) {
    return DEFAULT_COMPANION_MODELS
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return DEFAULT_COMPANION_MODELS
  }

  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_COMPANION_MODELS
  }

  const catalog = buildCatalogFromProviderCache(parsed as ProviderModelsCache)
  return catalog.length > 0 ? catalog : DEFAULT_COMPANION_MODELS
}

export function resolveCompanionModels(
  envJson: string | undefined,
  cachePath: string = DEFAULT_PROVIDER_MODELS_CACHE_PATH,
): CuratedModelEntry[] {
  if (envJson?.trim()) {
    return parseCompanionModelsJson(envJson)
  }

  return loadCompanionModelCatalog(cachePath)
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
}

export function fallbackCatalogEntry(
  model: string,
  provider: string = COMPANION_DEFAULT_PROVIDER,
): CuratedModelEntry {
  return {
    model,
    provider,
    display: model,
    subtitle: providerDisplayName(provider),
  }
}

export { COMPANION_DEFAULT_MODEL, COMPANION_DEFAULT_PROVIDER }