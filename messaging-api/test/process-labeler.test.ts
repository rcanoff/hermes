import { describe, expect, it } from 'vitest'
import { formatToolProcessLine } from '../src/services/process-labeler.js'

describe('formatToolProcessLine', () => {
  it('formats skill_view with name arg', () => {
    expect(formatToolProcessLine('skill_view', '{"name":"roberto-location-source"}')).toBe(
      'Loading skill: roberto-location-source',
    )
  })

  it('formats tool_search with query arg', () => {
    expect(formatToolProcessLine('tool_search', '{"query":"home assistant state"}')).toBe(
      'Searching tools: home assistant state',
    )
  })

  it('formats ha state tools without entity when args missing', () => {
    expect(formatToolProcessLine('mcp_ha_ha_get_state', '{}')).toBe('Getting Home Assistant state')
  })

  it('humanizes unknown tools', () => {
    expect(formatToolProcessLine('some_custom_tool', '')).toBe('Running some custom tool')
  })

  it('does not expose terminal command args', () => {
    expect(formatToolProcessLine('terminal', '{"command":"rm -rf /"}')).toBe('Running command')
  })

  it('formats hermes progress labels for skill_view', () => {
    expect(formatToolProcessLine('skill_view', undefined, 'companion-user-location')).toBe(
      'Loading skill: companion-user-location',
    )
  })

  it('formats hermes progress labels for skills_list', () => {
    expect(formatToolProcessLine('skills_list', undefined, 'productivity')).toBe('Listing skills: productivity')
  })
})