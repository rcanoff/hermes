import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMPANION_MODELS } from '../src/lib/companion-models.js'
import {
  buildCatalogFromProviderCache,
  loadCompanionModelCatalog,
  resolveCompanionModels,
} from '../src/lib/hermes-model-catalog.js'

describe('hermes-model-catalog', () => {
  const tempFiles: string[] = []

  afterEach(() => {
    for (const file of tempFiles.splice(0)) {
      fs.rmSync(file, { force: true })
    }
  })

  function writeCache(contents: unknown): string {
    const filePath = path.join(os.tmpdir(), `provider-models-${Date.now()}-${Math.random()}.json`)
    fs.writeFileSync(filePath, JSON.stringify(contents))
    tempFiles.push(filePath)
    return filePath
  }

  it('builds catalog from authenticated picker providers with model ids as display', () => {
    const catalog = buildCatalogFromProviderCache({
      'xai-oauth': { models: ['grok-composer-2.5-fast', 'grok-4.3'] },
      'openai-codex': { models: ['gpt-5.4-mini'] },
      anthropic: { models: ['should-not-appear'] },
    })

    expect(catalog).toEqual([
      {
        model: 'grok-composer-2.5-fast',
        provider: 'xai-oauth',
        display: 'grok-composer-2.5-fast',
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
    ])
  })

  it('loads catalog from cache file and falls back when missing', () => {
    const cachePath = writeCache({
      'xai-oauth': { models: ['grok-4.3'] },
    })

    expect(loadCompanionModelCatalog(cachePath)).toEqual([
      {
        model: 'grok-4.3',
        provider: 'xai-oauth',
        display: 'grok-4.3',
        subtitle: 'xAI Grok OAuth (SuperGrok / Premium+)',
      },
    ])
    expect(loadCompanionModelCatalog('/does/not/exist.json')).toEqual(DEFAULT_COMPANION_MODELS)
  })

  it('prefers COMPANION_MODELS_JSON override over cache file', () => {
    const cachePath = writeCache({
      'xai-oauth': { models: ['grok-4.3'] },
    })
    const custom = [
      {
        model: 'custom-model',
        provider: 'custom-provider',
        display: 'custom-model',
      },
    ]

    expect(resolveCompanionModels(JSON.stringify(custom), cachePath)).toEqual(custom)
    expect(resolveCompanionModels(undefined, cachePath)).toEqual([
      {
        model: 'grok-4.3',
        provider: 'xai-oauth',
        display: 'grok-4.3',
        subtitle: 'xAI Grok OAuth (SuperGrok / Premium+)',
      },
    ])
  })
})