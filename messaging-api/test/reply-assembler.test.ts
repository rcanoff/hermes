import { describe, expect, it } from 'vitest'
import { createReplyAssembler } from '../src/lib/reply-assembler.js'

describe('createReplyAssembler', () => {
  it('keeps a no-tool reply', () => {
    const reply = createReplyAssembler()
    reply.pushToken('Here is')
    reply.pushToken(' an idea')
    expect(reply.text()).toBe('Here is an idea')
    expect(reply.tokens()).toEqual(['Here is', ' an idea'])
  })

  it('drops tokens that arrived before a tool', () => {
    const reply = createReplyAssembler()
    reply.pushToken('Updating user preferences…')
    reply.onToolActivity()
    reply.pushToken('Got it.')
    expect(reply.text()).toBe('Got it.')
  })

  it('keeps only the segment after the last tool (Homer overview leak)', () => {
    const reply = createReplyAssembler()
    reply.pushToken("I'll pull the home overview from Home Assistant and format a short status for you.")
    reply.onToolActivity()
    reply.pushToken('Pulling the live Home Assistant overview next.')
    reply.onToolActivity()
    reply.pushToken('Gathering a few more device states for the overview.')
    reply.onToolActivity()
    reply.pushToken('Fetching live house status now.')
    reply.onToolActivity()
    reply.pushToken('House is quiet and empty — you and Aline are both away.')
    expect(reply.text()).toBe('House is quiet and empty — you and Aline are both away.')
    expect(reply.tokens()).toEqual(['House is quiet and empty — you and Aline are both away.'])
  })

  it('ignores empty tokens', () => {
    const reply = createReplyAssembler()
    reply.pushToken('')
    reply.pushToken('Hi')
    expect(reply.tokens()).toEqual(['Hi'])
  })
})
