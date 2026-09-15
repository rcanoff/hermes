import { describe, expect, it } from 'vitest'
import {
  OBSIDIAN_VAULTS_ROOT,
  companionObsidianVaultPath,
  companionVaultConstraint,
} from '../src/lib/companion-obsidian-vault.js'

describe('companionObsidianVaultPath', () => {
  it('joins the container root and username', () => {
    expect(OBSIDIAN_VAULTS_ROOT).toBe('/opt/data/vaults')
    expect(companionObsidianVaultPath('rcanoff')).toBe('/opt/data/vaults/rcanoff')
    expect(companionObsidianVaultPath('AlineTusi')).toBe('/opt/data/vaults/alinetusi')
  })

  it('rejects empty, slash, and dot-dot usernames', () => {
    expect(() => companionObsidianVaultPath('')).toThrow()
    expect(() => companionObsidianVaultPath('../etc')).toThrow()
    expect(() => companionObsidianVaultPath('a/b')).toThrow()
  })
})

describe('companionVaultConstraint', () => {
  it('names the only allowed vault directory', () => {
    expect(companionVaultConstraint('rcanoff')).toContain('/opt/data/vaults/rcanoff')
    expect(companionVaultConstraint('rcanoff')).toMatch(/only/i)
  })
})
