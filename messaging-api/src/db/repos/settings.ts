import type Database from 'better-sqlite3'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
} from '../../lib/companion-models.js'
import {
  readHermesDefaultModel,
  writeHermesDefaultModel,
} from '../../lib/hermes-default-model.js'

export const DEFAULT_MODEL_SETTING_KEY = 'default_model'

export interface DefaultModelSetting {
  model: string
  provider: string
}

export function getStoredDefaultModel(db: Database.Database): DefaultModelSetting | null {
  const row = db
    .prepare(`SELECT value FROM companion_settings WHERE key = ?`)
    .get(DEFAULT_MODEL_SETTING_KEY) as { value: string } | undefined

  if (!row) {
    return null
  }

  return parseDefaultModelValue(row.value)
}

export function setStoredDefaultModel(
  db: Database.Database,
  setting: DefaultModelSetting,
): void {
  db.prepare(`
    INSERT INTO companion_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(DEFAULT_MODEL_SETTING_KEY, JSON.stringify({
    model: setting.model,
    provider: setting.provider,
  }))
}

export function resolveDefaultModel(
  db: Database.Database,
  hermesHome: string,
): DefaultModelSetting {
  return (
    getStoredDefaultModel(db) ??
    readHermesDefaultModel(hermesHome) ?? {
      model: COMPANION_DEFAULT_MODEL,
      provider: COMPANION_DEFAULT_PROVIDER,
    }
  )
}

export function saveDefaultModel(
  db: Database.Database,
  hermesHome: string,
  setting: DefaultModelSetting,
): void {
  setStoredDefaultModel(db, setting)
  writeHermesDefaultModel(hermesHome, setting.model, setting.provider)
}

function parseDefaultModelValue(raw: string): DefaultModelSetting | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const record = parsed as { model?: unknown; provider?: unknown }
    if (typeof record.model !== 'string' || typeof record.provider !== 'string') {
      return null
    }
    const model = record.model.trim()
    const provider = record.provider.trim()
    if (!model || !provider) {
      return null
    }
    return { model, provider }
  } catch {
    return null
  }
}
