import type Database from 'better-sqlite3'
import {
  BOT_ICONS,
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_ICON,
} from '../lib/bot-appearance.js'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
} from '../lib/companion-models.js'
import { backfillAccountSyncEvents } from './repos/chat-sync-events.js'
import { ensureDefaultBotRow, seedKnownBotResponsibilities } from './repos/bots.js'

export function initSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_changed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      hermes_session_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_id_pair_idx
      ON messages (conversation_id, id);

    CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
      ON messages (conversation_id, created_at ASC, id ASC);

    CREATE TABLE IF NOT EXISTS message_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      error_code TEXT,
      error_detail TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (conversation_id, user_message_id) REFERENCES messages(conversation_id, id),
      FOREIGN KEY (conversation_id, assistant_message_id) REFERENCES messages(conversation_id, id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS message_runs_one_running_per_conversation
      ON message_runs (conversation_id)
      WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS message_process (
      id TEXT PRIMARY KEY,
      assistant_message_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (conversation_id, assistant_message_id)
        REFERENCES messages(conversation_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS location_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy_m REAL NOT NULL,
      timestamp TEXT NOT NULL,
      trigger TEXT NOT NULL,
      source TEXT NOT NULL,
      address TEXT,
      address_source TEXT,
      address_status TEXT NOT NULL DEFAULT 'resolved',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_location_events_user_timestamp
      ON location_events (user_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS account_invites (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('activation', 'password_reset')),
      label TEXT,
      user_id TEXT,
      revoked_at TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_account_invites_token_hash
      ON account_invites (token_hash);
    CREATE INDEX IF NOT EXISTS idx_account_invites_active
      ON account_invites (used_at, revoked_at, expires_at);

    CREATE TABLE IF NOT EXISTS health_daily_summaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
      finalized_at TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'healthkit',
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS health_daily_summaries_user_date_idx
      ON health_daily_summaries (user_id, date);

    CREATE INDEX IF NOT EXISTS health_daily_summaries_user_date_desc_idx
      ON health_daily_summaries (user_id, date DESC, id DESC);
  `)

  ensureLegacyUserColumns(db)
  ensureLegacyConversationColumns(db)
  ensureConversationModelColumns(db)
  ensureJobConversationColumns(db)
  ensureBots(db)
  ensureUserBotPreferences(db)
  ensureConversationBotId(db)
  ensureConversationPeerBotId(db)
  ensureMessageDelegationColumns(db)
  ensureMessageInputJson(db)
  ensureCronOutputDeliveries(db)
  ensureLegacyHealthDailySummaries(db)
  ensureMessageRunsOriginSessionId(db)
  ensureChatSyncEvents(db)
  ensurePushDevices(db)
  ensureDeviceSyncState(db)
  ensureCompanionSettings(db)
}

function ensureConversationBotId(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>

  if (!columns.some((column) => column.name === 'bot_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN bot_id TEXT REFERENCES bots(id)`)
  }

  ensureDefaultBotRow(db)

  db.exec(`
    UPDATE conversations
    SET bot_id = (SELECT id FROM bots WHERE slug = 'default')
    WHERE bot_id IS NULL
      AND kind = 'regular'
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS conversations_user_bot_updated_idx
      ON conversations (user_id, bot_id, updated_at DESC, id DESC)
  `)
}

function ensureConversationPeerBotId(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>

  if (!columns.some((column) => column.name === 'peer_bot_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN peer_bot_id TEXT REFERENCES bots(id)`)
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_user_bot_peer_idx
      ON conversations (user_id, bot_id, peer_bot_id)
      WHERE kind = 'regular' AND peer_bot_id IS NOT NULL
  `)
}

function ensureMessageDelegationColumns(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(messages)`)
    .all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))

  if (!names.has('kind')) {
    db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`)
  }

  if (!names.has('from_bot_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN from_bot_id TEXT REFERENCES bots(id)`)
  }

  if (!names.has('to_bot_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN to_bot_id TEXT REFERENCES bots(id)`)
  }

  if (!names.has('delegation_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN delegation_id TEXT`)
  }

  db.exec(`UPDATE messages SET kind = 'chat' WHERE kind IS NULL OR kind = ''`)

  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_delegation_id_idx
      ON messages (delegation_id)
      WHERE delegation_id IS NOT NULL
  `)
}

function ensureBots(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      soul TEXT NOT NULL,
      responsibilities TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '${DEFAULT_BOT_ICON}',
      color TEXT NOT NULL DEFAULT '${DEFAULT_BOT_COLOR}',
      runtime TEXT NOT NULL DEFAULT 'hermes' CHECK (runtime IN ('hermes', 'grok')),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS bots_one_default_idx
      ON bots (is_default)
      WHERE is_default = 1;

    CREATE INDEX IF NOT EXISTS bots_list_idx
      ON bots (is_default DESC, created_at DESC, id DESC);
  `)

  const columns = db
    .prepare(`PRAGMA table_info(bots)`)
    .all() as Array<{ name: string }>

  if (!columns.some((column) => column.name === 'icon')) {
    db.exec(`ALTER TABLE bots ADD COLUMN icon TEXT NOT NULL DEFAULT '${DEFAULT_BOT_ICON}'`)
  }

  if (!columns.some((column) => column.name === 'color')) {
    db.exec(`ALTER TABLE bots ADD COLUMN color TEXT NOT NULL DEFAULT '${DEFAULT_BOT_COLOR}'`)
  }

  if (!columns.some((column) => column.name === 'responsibilities')) {
    db.exec(`ALTER TABLE bots ADD COLUMN responsibilities TEXT NOT NULL DEFAULT ''`)
  }

  if (!columns.some((column) => column.name === 'runtime')) {
    db.exec(`ALTER TABLE bots ADD COLUMN runtime TEXT NOT NULL DEFAULT 'hermes'`)
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS bots_one_grok_idx
      ON bots (runtime)
      WHERE runtime = 'grok'
  `)

  rewriteRetiredBotIcons(db)
  seedKnownBotResponsibilities(db)
}

function ensureMessageInputJson(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(messages)`)
    .all() as Array<{ name: string }>

  if (!columns.some((column) => column.name === 'input_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN input_json TEXT`)
  }
}

function rewriteRetiredBotIcons(db: Database.Database): void {
  const allowed = BOT_ICONS.map((icon) => `'${icon}'`).join(', ')
  db.exec(`UPDATE bots SET icon = '${DEFAULT_BOT_ICON}' WHERE icon NOT IN (${allowed})`)
}

function ensureUserBotPreferences(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_bot_preferences (
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, bot_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS user_bot_preferences_user_idx
      ON user_bot_preferences (user_id);
  `)
}

function ensureCompanionSettings(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

function ensureDeviceSyncState(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_sync_state (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_account_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, device_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS device_sync_state_user_idx
      ON device_sync_state (user_id);
  `)
}

function ensurePushDevices(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_token TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios')),
      environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS push_devices_device_token_idx ON push_devices (device_token);
    CREATE INDEX IF NOT EXISTS push_devices_user_id_idx ON push_devices (user_id);
  `)
}

function ensureCronOutputDeliveries(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_output_deliveries (
      output_path TEXT PRIMARY KEY,
      hermes_job_id TEXT NOT NULL,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function ensureMessageRunsOriginSessionId(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(message_runs)`)
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'origin_session_id')) {
    db.exec(`
      ALTER TABLE message_runs
      ADD COLUMN origin_session_id TEXT NOT NULL DEFAULT 'legacy'
    `)
  }
}

function ensureLegacyConversationColumns(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'updated_at')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN updated_at TEXT`)
  }

  if (!columns.some((column) => column.name === 'bootstrap_prompt')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN bootstrap_prompt TEXT`)
  }

  db.exec(`UPDATE conversations SET updated_at = created_at WHERE updated_at IS NULL`)

  db.exec(`
    CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
      ON conversations (user_id, updated_at DESC, id DESC)
  `)
}

function ensureConversationModelColumns(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>

  if (!columns.some((column) => column.name === 'model')) {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT '${COMPANION_DEFAULT_MODEL}'`,
    )
  }

  if (!columns.some((column) => column.name === 'provider')) {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT '${COMPANION_DEFAULT_PROVIDER}'`,
    )
  }

  db.exec(
    `UPDATE conversations SET model = '${COMPANION_DEFAULT_MODEL}' WHERE model IS NULL OR model = ''`,
  )
  db.exec(
    `UPDATE conversations SET provider = '${COMPANION_DEFAULT_PROVIDER}' WHERE provider IS NULL OR provider = ''`,
  )
}

function ensureJobConversationColumns(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>

  if (!columns.some((column) => column.name === 'kind')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular'`)
  }

  if (!columns.some((column) => column.name === 'hermes_job_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN hermes_job_id TEXT`)
  }

  if (!columns.some((column) => column.name === 'schedule_display')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN schedule_display TEXT`)
  }

  if (!columns.some((column) => column.name === 'job_enabled')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN job_enabled INTEGER NOT NULL DEFAULT 1`)
  }

  if (!columns.some((column) => column.name === 'job_last_run_at')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN job_last_run_at TEXT`)
  }

  if (!columns.some((column) => column.name === 'job_last_status')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN job_last_status TEXT`)
  }

  db.exec(`UPDATE conversations SET kind = 'regular' WHERE kind IS NULL`)
  db.exec(`UPDATE conversations SET job_enabled = 1 WHERE job_enabled IS NULL`)

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_hermes_job_id_idx
      ON conversations (hermes_job_id)
      WHERE hermes_job_id IS NOT NULL
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS conversations_user_kind_updated_idx
      ON conversations (user_id, kind, updated_at DESC, id DESC)
  `)
}

function ensureChatSyncEvents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sync_events (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('account', 'conversation')),
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS chat_sync_events_account_idx
      ON chat_sync_events (user_id, occurred_at ASC, id ASC)
      WHERE scope = 'account';

    CREATE INDEX IF NOT EXISTS chat_sync_events_conversation_idx
      ON chat_sync_events (conversation_id, occurred_at ASC, id ASC)
      WHERE scope = 'conversation';
  `)

  backfillAccountSyncEvents(db)
}

function ensureLegacyHealthDailySummaries(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_daily_summaries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
      finalized_at TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'healthkit',
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS health_daily_summaries_user_date_idx
      ON health_daily_summaries (user_id, date);

    CREATE INDEX IF NOT EXISTS health_daily_summaries_user_date_desc_idx
      ON health_daily_summaries (user_id, date DESC, id DESC);

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      original_path TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      vision_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS message_attachments_user_unattached_idx
      ON message_attachments (user_id, expires_at)
      WHERE message_id IS NULL;

    CREATE INDEX IF NOT EXISTS message_attachments_message_idx
      ON message_attachments (message_id, position);
  `)
}

function ensureLegacyUserColumns(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(users)`)
    .all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'password_changed_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN password_changed_at TEXT`)
  }
}

export function reconcileRunningRuns(db: Database.Database): number {
  const result = db
    .prepare(`
      UPDATE message_runs
      SET status = 'failed',
          error_code = 'server_restart',
          error_detail = 'Run was interrupted during API restart',
          finished_at = datetime('now')
      WHERE status = 'running'
    `)
    .run()

  return result.changes
}
