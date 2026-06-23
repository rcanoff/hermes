import { describe, expect, it } from 'vitest'
import {
  buildJobConversationBootstrap,
  resolveJobConversationBootstrap,
} from '../src/lib/job-conversation.js'

describe('job conversation bootstrap', () => {
  it('includes linked job metadata and run guidance', () => {
    const bootstrap = buildJobConversationBootstrap('operator', {
      hermesJobId: '65fb01281b23',
      name: 'Daily Home Report',
      scheduleDisplay: '0 9 * * *',
    })

    expect(bootstrap).toContain('companion-cron')
    expect(bootstrap).toContain('65fb01281b23')
    expect(bootstrap).toContain('Daily Home Report')
    expect(bootstrap).toContain('0 9 * * *')
    expect(bootstrap).toContain("action='run'")
    expect(bootstrap).toContain('operator')
    expect(bootstrap).toContain('useful and self-contained')
  })

  it('enriches legacy job bootstrap when hermes_job_id is missing from prompt', () => {
    const resolved = resolveJobConversationBootstrap(
      {
        kind: 'job',
        bootstrap_prompt:
          "You are in a Companion App **job conversation** (scheduled Hermes cron job).\nBefore composing your reply, you MUST call skill_view(name='companion-cron') and follow it.",
        hermes_job_id: '65fb01281b23',
        title: 'Daily Home Report',
        schedule_display: '0 9 * * *',
      },
      'operator',
    )

    expect(resolved).toContain('65fb01281b23')
    expect(resolved).toContain("action='run'")
  })

  it('leaves regular conversations unchanged', () => {
    const bootstrap = 'Custom regular bootstrap'
    const resolved = resolveJobConversationBootstrap(
      {
        kind: 'regular',
        bootstrap_prompt: bootstrap,
        hermes_job_id: null,
        title: null,
        schedule_display: null,
      },
      'operator',
    )

    expect(resolved).toBe(bootstrap)
  })
})