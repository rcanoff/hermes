import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_PROMPT_MAX_LENGTH, validateBootstrap } from '../src/lib/bootstrap.js'

describe('validateBootstrap', () => {
  it('accepts non-empty trimmed text within max length', () => {
    expect(validateBootstrap('  call skill_view  ')).toBe('call skill_view')
  })

  it('rejects empty or whitespace-only', () => {
    expect(validateBootstrap('')).toBeNull()
    expect(validateBootstrap('   ')).toBeNull()
    expect(validateBootstrap(undefined)).toBeNull()
  })

  it('rejects text over max length', () => {
    expect(validateBootstrap('x'.repeat(BOOTSTRAP_PROMPT_MAX_LENGTH + 1))).toBeNull()
  })
})