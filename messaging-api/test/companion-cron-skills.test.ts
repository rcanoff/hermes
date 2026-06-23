import { describe, expect, it } from 'vitest'
import {
  companionCronSkillsPatch,
  isHomeAssistantCompanionJob,
  resolveCompanionCronSkills,
} from '../src/lib/companion-cron-skills.js'

describe('companion-cron-skills', () => {
  it('detects Home Assistant companion jobs', () => {
    expect(
      isHomeAssistantCompanionJob({
        name: 'Daily house overview',
        prompt: 'Use Home Assistant MCP only.',
      }),
    ).toBe(true)
    expect(
      isHomeAssistantCompanionJob({
        name: 'Get water',
        prompt: 'Reminder: Get water.',
      }),
    ).toBe(false)
  })

  it('resolves empty run-time skills for all companion jobs', () => {
    expect(resolveCompanionCronSkills({ name: 'Water reminder' })).toEqual([])
    expect(
      resolveCompanionCronSkills({
        name: 'Daily house overview',
        prompt: 'Use Home Assistant MCP only.',
      }),
    ).toEqual([])
  })

  it('strips companion-cron and home-assistant-mcp from run-time skills', () => {
    expect(
      companionCronSkillsPatch(['home-assistant-mcp'], {
        name: 'HA daily digest',
        prompt: 'Use Home Assistant MCP only.',
      }),
    ).toEqual([])

    expect(
      companionCronSkillsPatch(['companion-cron', 'home-assistant-mcp'], {
        name: 'HA daily digest',
        prompt: 'Use Home Assistant MCP only.',
      }),
    ).toEqual([])

    expect(
      companionCronSkillsPatch([], {
        name: 'HA daily digest',
        prompt: 'Use Home Assistant MCP only.',
      }),
    ).toBeNull()

    expect(
      companionCronSkillsPatch(['companion-cron'], {
        name: 'Water reminder',
      }),
    ).toEqual([])

    expect(
      companionCronSkillsPatch(['companion-user-location', 'route-planner'], {
        name: 'Route reminder',
      }),
    ).toBeNull()
  })
})