import { describe, expect, it } from 'vitest'
import {
  BOT_ICONS,
  DEFAULT_BOT_ICON,
  isBotIcon,
  normalizeBotIcon,
} from '../src/lib/bot-appearance.js'

describe('bot appearance icons', () => {
  it('allowlists four keys and defaults to message', () => {
    expect([...BOT_ICONS]).toEqual(['brain', 'message', 'map', 'bolt'])
    expect(DEFAULT_BOT_ICON).toBe('message')
  })

  it('rejects retired keys on write and maps them to message on read', () => {
    for (const icon of ['person', 'heart', 'star', 'leaf', 'moon', 'sun', 'briefcase', 'book']) {
      expect(isBotIcon(icon)).toBe(false)
      expect(normalizeBotIcon(icon)).toBe('message')
    }
  })

  it('keeps allowlisted icons on read', () => {
    for (const icon of BOT_ICONS) {
      expect(isBotIcon(icon)).toBe(true)
      expect(normalizeBotIcon(icon)).toBe(icon)
    }
  })
})
