import { describe, expect, it } from 'vitest'
import type { ToolingLine } from '../src/db/repos/process.js'
import {
  buildActivityLine,
  buildStatusLine,
  pickPresentationArgs,
} from '../src/services/tooling-line.js'

describe('ToolingLine', () => {
  it('accepts structured activity line', () => {
    const line: ToolingLine = {
      phase: 'activity',
      text: 'companion-user-location',
      tool: 'skill_view',
      args: { name: 'companion-user-location' },
    }
    expect(line.phase).toBe('activity')
  })
})

describe('tooling-line builders', () => {
  it('picks memory presentation args', () => {
    expect(pickPresentationArgs('memory', { action: 'add', target: 'user', content: 'x' })).toEqual({
      action: 'add',
      target: 'user',
    })
  })

  it('builds activity line preferring Hermes label', () => {
    expect(
      buildActivityLine({
        tool: 'skill_view',
        label: 'companion-user-location',
        argumentsJson: '{"name":"companion-user-location"}',
      }),
    ).toEqual({
      phase: 'activity',
      text: 'companion-user-location',
      tool: 'skill_view',
      args: { name: 'companion-user-location' },
    })
  })

  it('builds status line', () => {
    expect(buildStatusLine({ text: 'Updating user preferences…', tool: 'memory' })).toEqual({
      phase: 'status',
      text: 'Updating user preferences…',
      tool: 'memory',
      args: null,
    })
  })
})