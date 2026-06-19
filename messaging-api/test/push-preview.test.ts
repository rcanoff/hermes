import { describe, expect, it } from 'vitest'
import { buildChatPushAlert, buildJobPushAlert, stripPushPreview } from '../src/lib/push-preview.js'

describe('stripPushPreview', () => {
  it('truncates long text', () => {
    expect(stripPushPreview('a'.repeat(200), 120)).toBe(`${'a'.repeat(120)}…`)
  })

  it('collapses whitespace', () => {
    expect(stripPushPreview('hello\n\nworld', 120)).toBe('hello world')
  })
})

describe('buildPushAlert', () => {
  it('chat title uses conversation title', () => {
    expect(buildChatPushAlert({ title: 'Trip', content: 'Done' }).title).toBe('Trip')
  })

  it('job title uses Job prefix', () => {
    expect(buildJobPushAlert({ title: null, content: 'x', scheduleDisplay: '30 9 * * *' }).title).toBe(
      'Job · 30 9 * * *',
    )
  })
})