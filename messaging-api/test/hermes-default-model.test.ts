import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hermesConfigPath,
  readHermesDefaultModel,
  writeHermesDefaultModel,
} from '../src/lib/hermes-default-model.js'

describe('hermes-default-model', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-default-model-'))
  })

  afterEach(() => {
    fs.rmSync(hermesHome, { recursive: true, force: true })
  })

  it('returns null when config.yaml is missing', () => {
    expect(readHermesDefaultModel(hermesHome)).toBeNull()
  })

  it('reads model.default and model.provider from yaml', () => {
    fs.writeFileSync(
      hermesConfigPath(hermesHome),
      [
        'model:',
        '  default: grok-4.5',
        '  provider: xai-oauth',
        '  base_url: https://api.x.ai/v1',
        'fallback_providers: []',
        '',
      ].join('\n'),
    )

    expect(readHermesDefaultModel(hermesHome)).toEqual({
      model: 'grok-4.5',
      provider: 'xai-oauth',
    })
  })

  it('unquotes yaml scalars', () => {
    fs.writeFileSync(
      hermesConfigPath(hermesHome),
      'model:\n  default: "grok-4.5"\n  provider: \'xai-oauth\'\n',
    )

    expect(readHermesDefaultModel(hermesHome)).toEqual({
      model: 'grok-4.5',
      provider: 'xai-oauth',
    })
  })

  it('writes only model.default and model.provider and leaves the rest of the file', () => {
    const original = [
      'model:',
      '  default: grok-4.5',
      '  provider: xai-oauth',
      '  base_url: https://api.x.ai/v1',
      'fallback_providers: []',
      'agent:',
      '  max_turns: 150',
      '',
    ].join('\n')
    fs.writeFileSync(hermesConfigPath(hermesHome), original)

    writeHermesDefaultModel(hermesHome, 'grok-4.3', 'xai-oauth')

    expect(fs.readFileSync(hermesConfigPath(hermesHome), 'utf8')).toBe(
      [
        'model:',
        '  default: grok-4.3',
        '  provider: xai-oauth',
        '  base_url: https://api.x.ai/v1',
        'fallback_providers: []',
        'agent:',
        '  max_turns: 150',
        '',
      ].join('\n'),
    )
  })

  it('inserts missing default/provider keys under an existing model mapping', () => {
    fs.writeFileSync(
      hermesConfigPath(hermesHome),
      'model:\n  base_url: https://api.x.ai/v1\nother: keep-me\n',
    )

    writeHermesDefaultModel(hermesHome, 'gpt-5.4-mini', 'openai-codex')

    expect(fs.readFileSync(hermesConfigPath(hermesHome), 'utf8')).toBe(
      [
        'model:',
        '  default: gpt-5.4-mini',
        '  provider: openai-codex',
        '  base_url: https://api.x.ai/v1',
        'other: keep-me',
        '',
      ].join('\n'),
    )
  })

  it('creates config.yaml when missing', () => {
    writeHermesDefaultModel(hermesHome, 'grok-4.3', 'xai-oauth')

    expect(fs.readFileSync(hermesConfigPath(hermesHome), 'utf8')).toBe(
      'model:\n  default: grok-4.3\n  provider: xai-oauth\n',
    )
    expect(readHermesDefaultModel(hermesHome)).toEqual({
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })
  })
})
