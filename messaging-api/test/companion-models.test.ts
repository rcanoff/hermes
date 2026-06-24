import { describe, expect, it } from 'vitest'
import {
  assertCuratedModel,
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
  DEFAULT_COMPANION_MODELS,
  modelDisplayName,
  parseCompanionModelsJson,
} from '../src/lib/companion-models.js'

describe('companion-models', () => {
  it('returns default catalog when env json is empty', () => {
    expect(parseCompanionModelsJson(undefined)).toEqual(DEFAULT_COMPANION_MODELS)
    expect(parseCompanionModelsJson('')).toEqual(DEFAULT_COMPANION_MODELS)
    expect(parseCompanionModelsJson('   ')).toEqual(DEFAULT_COMPANION_MODELS)
  })

  it('parses valid custom catalog json', () => {
    const custom = [
      {
        model: 'custom-model',
        provider: 'custom-provider',
        display: 'Custom',
        subtitle: 'Test',
      },
    ]
    expect(parseCompanionModelsJson(JSON.stringify(custom))).toEqual(custom)
  })

  it('rejects invalid companion models json', () => {
    expect(() => parseCompanionModelsJson('not-json')).toThrow('invalid_companion_models_json')
    expect(() => parseCompanionModelsJson('{}')).toThrow('invalid_companion_models_json')
    expect(() => parseCompanionModelsJson('[]')).toThrow('invalid_companion_models_json')
    expect(() =>
      parseCompanionModelsJson(JSON.stringify([{ model: 'only-model' }])),
    ).toThrow('invalid_companion_models_json')
  })

  it('maps model display names from catalog', () => {
    expect(
      modelDisplayName(DEFAULT_COMPANION_MODELS, COMPANION_DEFAULT_MODEL, COMPANION_DEFAULT_PROVIDER),
    ).toBe('Grok 2.5')
    expect(modelDisplayName(DEFAULT_COMPANION_MODELS, 'grok-4.3', 'xai-oauth')).toBe('Grok 4.3')
    expect(modelDisplayName(DEFAULT_COMPANION_MODELS, 'unknown-model', 'xai-oauth')).toBe(
      'unknown-model',
    )
  })

  it('assertCuratedModel accepts known pairs and rejects unknown pairs', () => {
    expect(() =>
      assertCuratedModel(DEFAULT_COMPANION_MODELS, COMPANION_DEFAULT_MODEL, COMPANION_DEFAULT_PROVIDER),
    ).not.toThrow()
    expect(() =>
      assertCuratedModel(DEFAULT_COMPANION_MODELS, 'grok-4.3', 'xai-oauth'),
    ).not.toThrow()
    expect(() =>
      assertCuratedModel(DEFAULT_COMPANION_MODELS, 'unknown', 'xai-oauth'),
    ).toThrow('invalid_model')
    expect(() =>
      assertCuratedModel(DEFAULT_COMPANION_MODELS, 'grok-4.3', 'wrong-provider'),
    ).toThrow('invalid_model')
  })
})