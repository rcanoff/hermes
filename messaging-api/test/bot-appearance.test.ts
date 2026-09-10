import { describe, expect, it } from 'vitest'
import {
  BOT_ICONS,
  DEFAULT_BOT_ICON,
  isBotIcon,
  normalizeBotIcon,
} from '../src/lib/bot-appearance.js'

describe('bot appearance icons', () => {
  it('allowlists common keys and defaults to message', () => {
    expect(BOT_ICONS).toContain('person')
    expect(BOT_ICONS).toContain('house')
    expect(BOT_ICONS).toContain('sparkles')
    expect([...BOT_ICONS].slice(0, 4)).toEqual(['person', 'brain', 'message', 'map'])
    expect(DEFAULT_BOT_ICON).toBe('message')
  })

  it('rejects unknown keys on write and maps them to message on read', () => {
    for (const icon of ['nope', 'legacy-foo']) {
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
