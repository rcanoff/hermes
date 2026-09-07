import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOT_RESPONSIBILITIES,
  insertBot,
  listBotsForRoster,
  PATRIK_BOT_RESPONSIBILITIES,
  updateBot,
} from '../src/db/repos/bots.js'
import { initSchema } from '../src/db/schema.js'
import {
  buildBotRosterPrompt,
  MESSAGE_TEAMMATE_ROSTER_INSTRUCTION,
  ONBOARDING_JOBS_PLACEHOLDER,
  SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION,
  type RosterBot,
} from '../src/lib/bot-roster.js'

const hermes: RosterBot = {
  slug: 'default',
  name: 'Hermes',
  role: 'Default Companion assistant.',
  responsibilities: '',
  is_default: 1,
}

const patrik: RosterBot = {
  slug: 'patrik',
  name: 'Patrik',
  role: 'Personal agent',
  responsibilities: '',
  is_default: 0,
}

const travel: RosterBot = {
  slug: 'travel',
  name: 'Travel',
  role: 'Finds flights, bookings, and tickets.',
  responsibilities: '',
  is_default: 0,
}

const team = [hermes, patrik, travel]

const seededTeam: RosterBot[] = [
  {
    ...hermes,
    responsibilities: DEFAULT_BOT_RESPONSIBILITIES,
  },
  {
    ...patrik,
    responsibilities: PATRIK_BOT_RESPONSIBILITIES,
  },
  travel,
]

describe('buildBotRosterPrompt', () => {
  it('returns an empty string when there are no bots', () => {
    expect(buildBotRosterPrompt([], 'default')).toBe('')
  })

  it('returns an empty string when the current slug is missing', () => {
    expect(buildBotRosterPrompt(team, 'unknown')).toBe('')
  })

  it('identifies the current bot and lists teammates without duplicating self', () => {
    expect(buildBotRosterPrompt(team, 'patrik')).toBe(
      [
        'You are Patrik. Specialty: Personal agent',
        '',
        SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION,
        '',
        'Teammates on this Companion instance (do not impersonate them; they are specialists):',
        '- Hermes (main): Default Companion assistant.',
        `- Travel: ${ONBOARDING_JOBS_PLACEHOLDER}`,
        '',
        MESSAGE_TEAMMATE_ROSTER_INSTRUCTION,
      ].join('\n'),
    )
  })

  it('tags the default bot as (main) when it is speaking', () => {
    expect(buildBotRosterPrompt(team, 'default')).toBe(
      [
        'You are Hermes (main). Specialty: Default Companion assistant.',
        '',
        'Teammates on this Companion instance (do not impersonate them; they are specialists):',
        `- Patrik: ${ONBOARDING_JOBS_PLACEHOLDER}`,
        `- Travel: ${ONBOARDING_JOBS_PLACEHOLDER}`,
        '',
        MESSAGE_TEAMMATE_ROSTER_INSTRUCTION,
      ].join('\n'),
    )
  })

  it('does not ask the default bot to onboard when jobs are empty', () => {
    const prompt = buildBotRosterPrompt(team, 'default')
    expect(prompt).not.toContain(SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION)
    expect(prompt).not.toContain('set_my_responsibilities')
  })

  it('adds onboarding instructions when the current non-default bot has empty jobs', () => {
    const prompt = buildBotRosterPrompt(team, 'travel')
    expect(prompt).toContain('You are Travel. Specialty: Finds flights, bookings, and tickets.')
    expect(prompt).toContain(SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION)
    expect(prompt).toContain('set_my_responsibilities')
  })

  it('uses responsibilities on the roster when set', () => {
    expect(buildBotRosterPrompt(seededTeam, 'default')).toBe(
      [
        `You are Hermes (main). Specialty: ${DEFAULT_BOT_RESPONSIBILITIES}`,
        '',
        'Teammates on this Companion instance (do not impersonate them; they are specialists):',
        `- Patrik: ${PATRIK_BOT_RESPONSIBILITIES}`,
        `- Travel: ${ONBOARDING_JOBS_PLACEHOLDER}`,
        '',
        MESSAGE_TEAMMATE_ROSTER_INSTRUCTION,
      ].join('\n'),
    )
  })

  it('omits the teammates list when the current bot is the only row', () => {
    expect(buildBotRosterPrompt([hermes], 'default')).toBe(
      [
        'You are Hermes (main). Specialty: Default Companion assistant.',
        '',
        MESSAGE_TEAMMATE_ROSTER_INSTRUCTION,
      ].join('\n'),
    )
  })

  it('does not include soul text', () => {
    const prompt = buildBotRosterPrompt(seededTeam, 'patrik')
    expect(prompt).toContain(`You are Patrik. Specialty: ${PATRIK_BOT_RESPONSIBILITIES}`)
    expect(prompt).not.toContain('You are Hermes Agent')
    expect(prompt).not.toContain('You take care of personal data')
    expect(prompt).not.toContain(SET_MY_RESPONSIBILITIES_ONBOARDING_INSTRUCTION)
  })

  it('mentions message_teammate on the roster', () => {
    const prompt = buildBotRosterPrompt(team, 'default')
    expect(prompt).toContain('message_teammate')
    expect(prompt).toContain(MESSAGE_TEAMMATE_ROSTER_INSTRUCTION)
  })
})

describe('listBotsForRoster', () => {
  it('returns default first, then remaining bots by name, including newly created roles', () => {
    const db = new Database(':memory:')
    initSchema(db)
    insertBot(db, {
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      soul: 'You book trips.',
    })
    insertBot(db, {
      slug: 'patrik',
      name: 'Patrik',
      role: 'Personal agent',
      soul: 'You are Patrik.',
    })

    const rows = listBotsForRoster(db)
    expect(rows.map((bot) => bot.slug)).toEqual(['default', 'patrik', 'travel'])
    expect(rows.map((bot) => bot.role)).toEqual([
      'Default Companion assistant.',
      'Personal agent',
      'Finds flights, bookings, and tickets.',
    ])
    expect(rows[0]?.responsibilities).toBe(DEFAULT_BOT_RESPONSIBILITIES)
    expect(rows[1]?.responsibilities).toBe('')
    expect(buildBotRosterPrompt(rows, 'default')).toContain(`- Travel: ${ONBOARDING_JOBS_PLACEHOLDER}`)
    expect(buildBotRosterPrompt(rows, 'default')).not.toContain('You book trips.')
  })

  it('shows jobs on the roster after they are set', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const travelRow = insertBot(db, {
      slug: 'travel',
      name: 'Travel',
      role: 'Finds flights, bookings, and tickets.',
      soul: 'You book trips.',
    })
    updateBot(db, travelRow.id, {
      responsibilities: 'Flights, bookings, and tickets.',
    })

    const prompt = buildBotRosterPrompt(listBotsForRoster(db), 'default')
    expect(prompt).toContain('- Travel: Flights, bookings, and tickets.')
    expect(prompt).not.toContain('You book trips.')
  })
})
