import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createConversation,
  createJobConversation,
  findOrCreatePeerConversation,
  getConversationForUser,
  listRecentModelsForUser,
  updateConversationModel,
} from '../src/db/repos/conversations.js'
import { insertBot, getBotBySlug, ensureDefaultBotRow } from '../src/db/repos/bots.js'
import { insertDbUser } from './helpers/users.js'
import { insertMessage, listMessages } from '../src/db/repos/messages.js'
import { denyToken, isTokenDenied } from '../src/db/repos/sessions.js'
import { markRunCompleted, markRunFailed } from '../src/db/repos/runs.js'
import { initSchema, reconcileRunningRuns } from '../src/db/schema.js'
import { closeDb, getDb } from '../src/db/index.js'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
} from '../src/lib/companion-models.js'

describe('schema', () => {
  it('creates health_daily_summaries table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_daily_summaries'")
      .all()
    expect(rows).toHaveLength(1)
  })

  it('creates account_invites table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('account_invites')
  })

  it('adds password_changed_at column to users', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(users)`)
      .all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('password_changed_at')
  })

  it('includes updated_at on conversations', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('updated_at')
  })

  it('includes push_devices table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'push_devices'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('includes message_attachments table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'message_attachments'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('includes icon and color on bots', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(bots)`)
      .all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    expect(names).toContain('icon')
    expect(names).toContain('color')
    expect(names).toContain('responsibilities')
    expect(names).toContain('runtime')
    expect(names).toContain('user_id')
  })

  it('seeds default responsibilities; new bots start with empty jobs', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const user = insertDbUser(db)
    const defaultBot = ensureDefaultBotRow(db, user.id)
    expect(defaultBot?.responsibilities).toBe(
      'Default Companion assistant; routes matching work to specialist teammates.',
    )

    insertBot(db, {
      userId: user.id,
      slug: 'patrik',
      name: 'Patrik',
      role: 'Personal agent',
      soul: 'You are Patrik.',
    })
    expect(getBotBySlug(db, user.id, 'patrik')?.responsibilities).toBe('')
  })

  it('backfills existing bots to rcanoff and unique-grok is per user', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES ('rcanoff-id', 'rcanoff', 'hash');
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO bots (id, slug, name, role, soul, is_default)
      VALUES ('b1', 'default', 'Hermes', 'Default', 'You are Hermes', 1);
    `)

    initSchema(db)

    const row = db
      .prepare('SELECT user_id, slug FROM bots WHERE id = ?')
      .get('b1') as { user_id: string; slug: string }
    expect(row).toEqual({ user_id: 'rcanoff-id', slug: 'default' })

    const aline = insertDbUser(db, 'AlineTusi')
    insertBot(db, {
      userId: aline.id,
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    insertBot(db, {
      userId: 'rcanoff-id',
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    expect(() =>
      insertBot(db, {
        userId: aline.id,
        slug: 'grok-two',
        name: 'Grok Two',
        role: 'Mac agent',
        soul: 'You are Grok.',
        runtime: 'grok',
      }),
    ).toThrow()
  })

  it('adds icon and color to legacy bots', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES ('rcanoff-id', 'rcanoff', 'hash');
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO bots (id, slug, name, role, soul, is_default)
      VALUES ('b1', 'default', 'Hermes', 'Default', 'You are Hermes', 1);
    `)

    initSchema(db)

    const row = db
      .prepare('SELECT icon, color FROM bots WHERE id = ?')
      .get('b1') as { icon: string; color: string }
    expect(row).toEqual({ icon: 'message', color: 'blue' })
  })

  it('adds runtime=hermes to legacy bots and allows one grok per user', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES ('rcanoff-id', 'rcanoff', 'hash');
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO bots (id, slug, name, role, soul, is_default)
      VALUES ('b1', 'default', 'Hermes', 'Default', 'You are Hermes', 1);
    `)

    initSchema(db)

    const defaultRow = db
      .prepare('SELECT runtime, user_id FROM bots WHERE id = ?')
      .get('b1') as { runtime: string; user_id: string }
    expect(defaultRow.runtime).toBe('hermes')
    expect(defaultRow.user_id).toBe('rcanoff-id')

    insertBot(db, {
      userId: 'rcanoff-id',
      slug: 'grok',
      name: 'Grok',
      role: 'Mac agent',
      soul: 'You are Grok.',
      runtime: 'grok',
    })
    expect(() =>
      insertBot(db, {
        userId: 'rcanoff-id',
        slug: 'grok-two',
        name: 'Grok Two',
        role: 'Mac agent',
        soul: 'You are Grok.',
        runtime: 'grok',
      }),
    ).toThrow()
  })

  it('rewrites retired bot icons to message and keeps allowlisted icons', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES ('rcanoff-id', 'rcanoff', 'hash');
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'person',
        color TEXT NOT NULL DEFAULT 'blue',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO bots (id, slug, name, role, soul, icon, is_default)
      VALUES
        ('b1', 'default', 'Hermes', 'Default', 'You are Hermes', 'person', 1),
        ('b2', 'travel', 'Travel', 'Flights', 'You book trips.', 'map', 0),
        ('b3', 'energy', 'Energy', 'Power', 'You track energy.', 'bolt', 0),
        ('b4', 'old', 'Old', 'Retired', 'You used a retired icon.', 'legacy-foo', 0);
    `)

    initSchema(db)

    const rows = db
      .prepare('SELECT id, icon FROM bots ORDER BY id')
      .all() as Array<{ id: string; icon: string }>
    expect(rows).toEqual([
      { id: 'b1', icon: 'person' },
      { id: 'b2', icon: 'map' },
      { id: 'b3', icon: 'bolt' },
      { id: 'b4', icon: 'message' },
    ])
  })

  it('adds responsibilities to legacy bots and seeds default plus Patrik', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES ('rcanoff-id', 'rcanoff', 'hash');
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO bots (id, slug, name, role, soul, is_default)
      VALUES
        ('b1', 'default', 'Hermes', 'Default', 'You are Hermes', 1),
        ('b2', 'patrik', 'Patrik', 'Personal agent', 'You are Patrik.', 0);
    `)

    initSchema(db)

    const rows = db
      .prepare('SELECT slug, responsibilities FROM bots ORDER BY slug')
      .all() as Array<{ slug: string; responsibilities: string }>
    expect(rows).toEqual([
      {
        slug: 'default',
        responsibilities:
          'Default Companion assistant; routes matching work to specialist teammates.',
      },
      {
        slug: 'patrik',
        responsibilities:
          'Personal data: addresses, phone numbers, and things the user owns.',
      },
    ])
  })

  it('includes user_bot_preferences table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'user_bot_preferences'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('includes device_sync_state table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'device_sync_state'`)
      .get()
    expect(row).toBeDefined()
  })

  it('includes chat_sync_events table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('chat_sync_events')
  })

  it('includes bootstrap_prompt on conversations', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('bootstrap_prompt')
  })

  it('creates companion_settings table', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('companion_settings')
  })

  it('lists recent models for a user by updated_at, de-duped, excluding jobs', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO users (id, username, password_hash) VALUES ('u2', 'other', 'hash');
    `)

    const oldest = createConversation(db, 'u1', 'hs1', null, {
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
    })
    const middle = createConversation(db, 'u1', 'hs2', null, {
      model: 'grok-4.3',
      provider: 'xai-oauth',
    })
    const newestSameAsOldest = createConversation(db, 'u1', 'hs3', null, {
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
    })
    const otherUser = createConversation(db, 'u2', 'hs4', null, {
      model: COMPANION_DEFAULT_MODEL,
      provider: COMPANION_DEFAULT_PROVIDER,
    })
    const jobId = createJobConversation(db, 'u1', 'operator', { name: 'nightly' })
    db.prepare(`UPDATE conversations SET model = ?, provider = ? WHERE id = ?`).run(
      'job-model',
      'job-provider',
      jobId,
    )

    db.prepare(`UPDATE conversations SET updated_at = datetime('now', '-3 hours') WHERE id = ?`).run(
      oldest,
    )
    db.prepare(`UPDATE conversations SET updated_at = datetime('now', '-2 hours') WHERE id = ?`).run(
      middle,
    )
    db.prepare(`UPDATE conversations SET updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(
      newestSameAsOldest,
    )
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(otherUser)
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(jobId)

    expect(listRecentModelsForUser(db, 'u1', 8)).toEqual([
      { model: 'gpt-5.4-mini', provider: 'openai-codex' },
      { model: 'grok-4.3', provider: 'xai-oauth' },
    ])
  })

  it('includes model and provider on conversations', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    expect(names).toContain('model')
    expect(names).toContain('provider')
  })

  it('backfills model and provider on legacy conversations', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
    `)

    initSchema(db)

    const row = db
      .prepare('SELECT model, provider FROM conversations WHERE id = ?')
      .get('c1') as { model: string; provider: string }

    expect(row.model).toBe(COMPANION_DEFAULT_MODEL)
    expect(row.provider).toBe(COMPANION_DEFAULT_PROVIDER)
  })

  it('stores default model and provider when creating a conversation', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');`)

    const conversationId = createConversation(db, 'u1', 'hs1')
    const conversation = getConversationForUser(db, 'u1', conversationId)

    expect(conversation?.model).toBe(COMPANION_DEFAULT_MODEL)
    expect(conversation?.provider).toBe(COMPANION_DEFAULT_PROVIDER)
  })

  it('stores explicit model and provider when creating a conversation', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');`)

    const conversationId = createConversation(db, 'u1', 'hs1', null, {
      model: 'gpt-5.4-mini',
      provider: 'openai-codex',
    })
    const conversation = getConversationForUser(db, 'u1', conversationId)

    expect(conversation?.model).toBe('gpt-5.4-mini')
    expect(conversation?.provider).toBe('openai-codex')
  })

  it('updates model and provider via updateConversationModel', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');`)

    const conversationId = createConversation(db, 'u1', 'hs1')
    const updated = updateConversationModel(db, conversationId, 'grok-4.3', 'xai-oauth')

    expect(updated?.model).toBe('grok-4.3')
    expect(updated?.provider).toBe('xai-oauth')

    const conversation = getConversationForUser(db, 'u1', conversationId)
    expect(conversation?.model).toBe('grok-4.3')
    expect(conversation?.provider).toBe('xai-oauth')
  })

  it('includes peer_bot_id on conversations', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('peer_bot_id')
  })

  it('includes delegation columns on messages', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    expect(names).toContain('kind')
    expect(names).toContain('from_bot_id')
    expect(names).toContain('to_bot_id')
    expect(names).toContain('delegation_id')
    expect(names).toContain('input_json')
  })

  it('backfills kind=chat on legacy messages', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
    `)

    initSchema(db)

    const row = db
      .prepare(`SELECT kind, from_bot_id, to_bot_id, delegation_id FROM messages WHERE id = 'm1'`)
      .get() as {
      kind: string
      from_bot_id: string | null
      to_bot_id: string | null
      delegation_id: string | null
    }
    expect(row).toEqual({
      kind: 'chat',
      from_bot_id: null,
      to_bot_id: null,
      delegation_id: null,
    })
  })

  it('defaults new messages to kind=chat', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');`)
    const conversationId = createConversation(db, 'u1', 'hs1')
    insertMessage(db, { conversationId, role: 'user', content: 'hi' })

    expect(listMessages(db, conversationId)).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'hi',
        kind: 'chat',
        from_bot_id: null,
        to_bot_id: null,
        delegation_id: null,
        input: null,
      }),
    ])
  })

  it('persists and reads pending_input on messages', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');`)
    const conversationId = createConversation(db, 'u1', 'hs1')
    const input = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'pending' as const,
      type: 'permission' as const,
      tool: 'run_terminal_cmd',
      preview: 'git status',
    }
    insertMessage(db, {
      conversationId,
      role: 'assistant',
      content: 'Run `git status` in ~/Companion/grok?',
      kind: 'pending_input',
      input,
    })

    expect(listMessages(db, conversationId)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        kind: 'pending_input',
        content: 'Run `git status` in ~/Companion/grok?',
        input,
      }),
    ])
  })

  it('finds or creates a pair thread titled From sender', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');`)
    const hermes = ensureDefaultBotRow(db, 'u1')
    const travel = insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'You book trips.',
    })

    const created = findOrCreatePeerConversation(db, {
      userId: 'u1',
      targetBotId: travel.id,
      senderBotId: hermes.id,
      senderName: 'Hermes',
    })
    const again = findOrCreatePeerConversation(db, {
      userId: 'u1',
      targetBotId: travel.id,
      senderBotId: hermes.id,
      senderName: 'Hermes',
    })

    expect(again.id).toBe(created.id)
    expect(created).toMatchObject({
      user_id: 'u1',
      bot_id: travel.id,
      peer_bot_id: hermes.id,
      kind: 'regular',
      title: 'From Hermes',
    })
  })

  it('includes job conversation columns on conversations', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    expect(names).toContain('kind')
    expect(names).toContain('hermes_job_id')
    expect(names).toContain('schedule_display')
    expect(names).toContain('job_enabled')
    expect(names).toContain('job_last_run_at')
    expect(names).toContain('job_last_status')
  })

  it('includes origin_session_id on message_runs', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const columns = db
      .prepare(`PRAGMA table_info(message_runs)`)
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('origin_session_id')
  })

  it('creates the durable run tables', () => {
    const db = new Database(':memory:')

    initSchema(db)

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>

    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'location_events',
        'conversations',
        'message_process',
        'message_runs',
        'messages',
        'sessions',
        'users',
      ]),
    )
  })

  it('creates secondary indexes for hot read paths', () => {
    const db = new Database(':memory:')

    initSchema(db)

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>

    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'conversations_user_updated_idx',
        'idx_location_events_user_timestamp',
        'message_runs_one_running_per_conversation',
        'messages_conversation_id_pair_idx',
        'messages_conversation_created_idx',
      ]),
    )
  })

  it('enforces a single running run per conversation', () => {
    const db = new Database(':memory:')

    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)

    expect(() =>
      db
        .prepare(`
          INSERT INTO message_runs (id, conversation_id, user_message_id, status)
          VALUES ('r2', 'c1', 'm1', 'running')
        `)
        .run(),
    ).toThrow(/UNIQUE constraint failed: message_runs.conversation_id/)
  })

  it('rejects run message references from a different conversation', () => {
    const db = new Database(':memory:')

    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c2', 'u1', 'hs2');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m2', 'c2', 'assistant', 'done');
    `)

    expect(() =>
      db
        .prepare(`
          INSERT INTO message_runs (id, conversation_id, user_message_id, assistant_message_id, status)
          VALUES ('r1', 'c1', 'm1', 'm2', 'completed')
        `)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe('startup reconciliation', () => {
  it('marks running runs failed with restart metadata', () => {
    const db = new Database(':memory:')

    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)

    const changes = reconcileRunningRuns(db)
    const row = db
      .prepare('SELECT status, error_code, error_detail, finished_at FROM message_runs WHERE id = ?')
      .get('r1') as {
      status: string
      error_code: string
      error_detail: string
      finished_at: string
    }

    expect(changes).toBe(1)
    expect(row.status).toBe('failed')
    expect(row.error_code).toBe('server_restart')
    expect(row.error_detail).toContain('interrupted')
    expect(row.finished_at).toBeTruthy()
  })
})

describe('run transitions', () => {
  it('only completes runs that are still running', () => {
    const db = new Database(':memory:')

    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m2', 'c1', 'assistant', 'done');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
      INSERT INTO message_runs (id, conversation_id, user_message_id, assistant_message_id, status, finished_at)
      VALUES ('r2', 'c1', 'm1', 'm2', 'completed', datetime('now'));
    `)

    expect(markRunCompleted(db, 'r1', 'm2')).toBe(true)
    expect(markRunCompleted(db, 'r2', 'm2')).toBe(false)

    const runningRow = db
      .prepare('SELECT status, assistant_message_id, finished_at FROM message_runs WHERE id = ?')
      .get('r1') as { status: string; assistant_message_id: string; finished_at: string }
    const completedRow = db
      .prepare('SELECT status, assistant_message_id FROM message_runs WHERE id = ?')
      .get('r2') as { status: string; assistant_message_id: string }

    expect(runningRow.status).toBe('completed')
    expect(runningRow.assistant_message_id).toBe('m2')
    expect(runningRow.finished_at).toBeTruthy()
    expect(completedRow.status).toBe('completed')
    expect(completedRow.assistant_message_id).toBe('m2')
  })

  it('only fails runs that are still running', () => {
    const db = new Database(':memory:')

    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status, error_code, error_detail, finished_at)
      VALUES ('r2', 'c1', 'm1', 'failed', 'old_error', 'already failed', datetime('now'));
    `)

    expect(markRunFailed(db, 'r1', 'upstream_error', 'Hermes failed')).toBe(true)
    expect(markRunFailed(db, 'r2', 'new_error', 'should not overwrite')).toBe(false)

    const runningRow = db
      .prepare('SELECT status, error_code, error_detail, finished_at FROM message_runs WHERE id = ?')
      .get('r1') as { status: string; error_code: string; error_detail: string; finished_at: string }
    const failedRow = db
      .prepare('SELECT status, error_code, error_detail FROM message_runs WHERE id = ?')
      .get('r2') as { status: string; error_code: string; error_detail: string }

    expect(runningRow.status).toBe('failed')
    expect(runningRow.error_code).toBe('upstream_error')
    expect(runningRow.error_detail).toBe('Hermes failed')
    expect(runningRow.finished_at).toBeTruthy()
    expect(failedRow.status).toBe('failed')
    expect(failedRow.error_code).toBe('old_error')
    expect(failedRow.error_detail).toBe('already failed')
  })

  it('backfills shared-conversation membership and message sequence', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES ('owner', 'ada', 'hash');
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'regular',
        dm_key TEXT
      );
      INSERT INTO conversations (id, user_id, hermes_session_id, title, created_at, kind, dm_key)
      VALUES ('c1', 'owner', 'hs1', 'Chat', '2026-01-01 00:00:00', 'regular', 'not-a-dm');
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES
        ('m-b', 'c1', 'assistant', 'later', '2026-01-03 00:00:00'),
        ('m-d', 'c1', 'user', 'tie-b', '2026-01-02 00:00:00'),
        ('m-a', 'c1', 'user', 'first', '2026-01-01 00:00:00'),
        ('m-c', 'c1', 'user', 'tie-a', '2026-01-02 00:00:00');
    `)

    initSchema(db)

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_members', 'group_bot_runs')`)
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name).sort()).toEqual(['conversation_members', 'group_bot_runs'])

    const members = db
      .prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = 'c1'`)
      .all() as Array<{ user_id: string }>
    expect(members).toEqual([{ user_id: 'owner' }])

    const sequences = db
      .prepare(`SELECT id, sequence FROM messages WHERE conversation_id = 'c1' ORDER BY sequence ASC`)
      .all() as Array<{ id: string; sequence: number }>
    expect(sequences).toEqual([
      { id: 'm-a', sequence: 1 },
      { id: 'm-c', sequence: 2 },
      { id: 'm-d', sequence: 3 },
      { id: 'm-b', sequence: 4 },
    ])
    expect(new Set(sequences.map((row) => row.sequence)).size).toBe(sequences.length)
  })
  it('rebuilds legacy group runs with bot-scoped keys and backfills roster rows', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const user = insertDbUser(db)
    const bot = ensureDefaultBotRow(db, user.id)!
    const conversationId = createConversation(db, user.id, 'legacy-session')
    db.prepare(`UPDATE conversations SET kind = 'group', bot_id = ? WHERE id = ?`).run(bot.id, conversationId)
    db.exec(`
      DROP INDEX IF EXISTS group_bot_runs_one_running_idx;
      DROP TABLE group_bot_runs;
      CREATE TABLE group_bot_runs (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        state TEXT NOT NULL,
        run_id TEXT NOT NULL,
        error_code TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    db.prepare(`
      INSERT INTO group_bot_runs (message_id, conversation_id, state, run_id)
      VALUES ('legacy-message', ?, 'queued', 'legacy-run')
    `).run(conversationId)

    initSchema(db)

    const columns = db.prepare(`PRAGMA table_info(group_bot_runs)`).all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('bot_id')
    expect(
      db
        .prepare(`SELECT message_id, bot_id, conversation_id FROM group_bot_runs`)
        .all(),
    ).toEqual([{ message_id: 'legacy-message', bot_id: bot.id, conversation_id: conversationId }])
    expect(
      db.prepare(`SELECT conversation_id, bot_id FROM conversation_bots`).all(),
    ).toEqual([{ conversation_id: conversationId, bot_id: bot.id }])
    expect(
      db.prepare(`SELECT bot_id FROM conversations WHERE id = ?`).get(conversationId),
    ).toEqual({ bot_id: null })
  })
})

describe('session denylist', () => {
  it('ignores expired denylist rows', () => {
    const db = new Database(':memory:')

    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
    `)
    const expiredRow = db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour') AS expiresAt")
      .get() as { expiresAt: string }
    const activeRow = db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 hour') AS expiresAt")
      .get() as { expiresAt: string }

    denyToken(db, {
      id: 's1',
      userId: 'u1',
      token: 'expired-same-day-token',
      expiresAt: expiredRow.expiresAt,
    })
    denyToken(db, {
      id: 's2',
      userId: 'u1',
      token: 'active-token',
      expiresAt: activeRow.expiresAt,
    })

    expect(isTokenDenied(db, 'expired-same-day-token')).toBe(false)
    expect(isTokenDenied(db, 'active-token')).toBe(true)
    expect(isTokenDenied(db, 'missing-token')).toBe(false)
  })
})

describe('getDb', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    closeDb()

    for (const filePath of tempPaths.splice(0)) {
      try {
        fs.rmSync(filePath, { force: true })
      } catch {
        // Best-effort test cleanup.
      }
    }
  })

  it('returns isolated in-memory databases for tests', () => {
    const first = getDb(':memory:')
    const second = getDb(':memory:')

    first.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
    `)

    const firstCount = first.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
    const secondCount = second.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }

    expect(first).not.toBe(second)
    expect(firstCount.count).toBe(1)
    expect(secondCount.count).toBe(0)
  })

  it('reconciles orphaned running runs when opening a file-backed database', () => {
    const dbPath = path.join(os.tmpdir(), `messaging-api-db-${Date.now()}.sqlite`)
    tempPaths.push(dbPath)

    const seed = new Database(dbPath)
    initSchema(seed)
    seed.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs1');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello');
      INSERT INTO message_runs (id, conversation_id, user_message_id, status) VALUES ('r1', 'c1', 'm1', 'running');
    `)
    seed.close()

    const db = getDb(dbPath)
    const row = db
      .prepare('SELECT status, error_code, error_detail, finished_at FROM message_runs WHERE id = ?')
      .get('r1') as {
      status: string
      error_code: string
      error_detail: string
      finished_at: string
    }

    expect(row.status).toBe('failed')
    expect(row.error_code).toBe('server_restart')
    expect(row.error_detail).toContain('API restart')
    expect(row.finished_at).toBeTruthy()
  })
})
