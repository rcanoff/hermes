import fs from 'node:fs'
import type Database from 'better-sqlite3'
import {
  DEFAULT_BOT_NAME,
  DEFAULT_BOT_RESPONSIBILITIES,
  DEFAULT_BOT_ROLE,
  DEFAULT_BOT_SOUL,
  ensureDefaultBotRow,
  getBotBySlug,
  insertBot,
  seedKnownBotResponsibilities,
  type BotRow,
} from '../db/repos/bots.js'
import type { UserRow } from '../db/repos/users.js'
import { HermesDashboardError, type HermesDashboard } from '../lib/hermes-dashboard.js'
import {
  DEFAULT_BOT_SLUG,
  addHonchoHost,
  ensureSkillsOverlay,
  hermesProfileName,
  isOperatorOwner,
  profileDir,
  stripClonedApiServer,
  syncProfileApiServerKey,
  writeProfileYaml,
  writeSoulFile,
} from '../lib/hermes-profile.js'

export interface EnsureDefaultHermesBotInput {
  db: Database.Database
  user: Pick<UserRow, 'id' | 'username'>
  hermesHome: string
  dashboard: HermesDashboard
}

export async function ensureDefaultHermesBot(input: EnsureDefaultHermesBotInput): Promise<BotRow> {
  const { db, user, hermesHome, dashboard } = input
  const owner = { userId: user.id, username: user.username }

  if (isOperatorOwner(owner)) {
    return ensureDefaultBotRow(db, user.id)
  }

  const named = hermesProfileName(user.username, DEFAULT_BOT_SLUG)
  if (!named.ok || named.name === null || named.name === DEFAULT_BOT_SLUG) {
    return ensureDefaultBotRow(db, user.id)
  }

  const hermesName = named.name
  const existing = getBotBySlug(db, user.id, DEFAULT_BOT_SLUG)
  if (existing) {
    seedKnownBotResponsibilities(db)
  }

  const dirMissing = !fs.existsSync(profileDir(hermesHome, hermesName))
  if (!existing) {
    const provisioned = await provisionOfficialDefaultProfile({
      dashboard,
      hermesHome,
      hermesName,
      username: user.username,
      name: DEFAULT_BOT_NAME,
      role: DEFAULT_BOT_ROLE,
      soul: DEFAULT_BOT_SOUL,
      writeYaml: true,
    })
    try {
      return insertBot(db, {
        userId: user.id,
        slug: DEFAULT_BOT_SLUG,
        name: DEFAULT_BOT_NAME,
        role: DEFAULT_BOT_ROLE,
        soul: DEFAULT_BOT_SOUL,
        responsibilities: DEFAULT_BOT_RESPONSIBILITIES,
        isDefault: true,
        hermesProfileName: hermesName,
      })
    } catch (error) {
      const raced = getBotBySlug(db, user.id, DEFAULT_BOT_SLUG)
      if (raced) {
        return raced
      }
      if (provisioned.created) {
        await dashboard.deleteProfile(hermesName)
      }
      throw error
    }
  }

  if (dirMissing) {
    await provisionOfficialDefaultProfile({
      dashboard,
      hermesHome,
      hermesName,
      username: user.username,
      name: existing.name,
      role: existing.role,
      soul: existing.soul,
      writeYaml: false,
    })
  }

  if (existing.hermes_profile_name === null) {
    db.prepare(
      `UPDATE bots SET hermes_profile_name = ? WHERE id = ? AND hermes_profile_name IS NULL`,
    ).run(hermesName, existing.id)
  }
  return getBotBySlug(db, user.id, DEFAULT_BOT_SLUG)!
}

async function provisionOfficialDefaultProfile(input: {
  dashboard: HermesDashboard
  hermesHome: string
  hermesName: string
  username: string
  name: string
  role: string
  soul: string
  writeYaml: boolean
}): Promise<{ created: boolean }> {
  if (input.hermesName === DEFAULT_BOT_SLUG) {
    return { created: false }
  }

  let created = false
  const remote = await input.dashboard.getProfile(input.hermesName)
  if (!remote) {
    try {
      await input.dashboard.createProfile({
        name: input.hermesName,
        description: input.name,
      })
      created = true
    } catch (error) {
      if (!(error instanceof HermesDashboardError && error.code === 'hermes_profile_taken')) {
        throw error
      }
    }
  }

  try {
    const dir = profileDir(input.hermesHome, input.hermesName)
    stripClonedApiServer(dir)
    syncProfileApiServerKey(input.hermesHome, input.hermesName)
    writeSoulFile(input.hermesHome, input.hermesName, input.soul)
    ensureSkillsOverlay(input.hermesHome, input.hermesName)
    if (input.writeYaml) {
      writeProfileYaml(input.hermesHome, input.hermesName, {
        name: input.name,
        role: input.role,
        companionUsername: input.username,
      })
    }
    addHonchoHost(input.hermesHome, input.hermesName)
  } catch (error) {
    if (created) {
      await input.dashboard.deleteProfile(input.hermesName)
    }
    throw error
  }

  return { created }
}
