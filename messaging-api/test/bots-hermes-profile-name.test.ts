import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getBotById, insertBot } from '../src/db/repos/bots.js'
import { initSchema } from '../src/db/schema.js'

describe('bots.hermes_profile_name', () => {
  it('persists hermes_profile_name on insert', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x')`).run()
    const row = insertBot(db, {
      userId: 'u1',
      slug: 'travel',
      name: 'Travel',
      role: 'Flights',
      soul: 'soul',
      hermesProfileName: 'alice-travel',
    })
    expect(row.hermes_profile_name).toBe('alice-travel')
    expect(getBotById(db, row.id)?.hermes_profile_name).toBe('alice-travel')
  })

  it('initSchema backfills existing hermes extra bots', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO users (id, username, password_hash) VALUES
        ('rcanoff-id', 'rcanoff', 'hash'),
        ('aline-id', 'AlineTusi', 'hash');
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        soul TEXT NOT NULL,
        responsibilities TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT 'message',
        color TEXT NOT NULL DEFAULT 'blue',
        runtime TEXT NOT NULL DEFAULT 'hermes' CHECK (runtime IN ('hermes', 'grok')),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (user_id, slug)
      );
      INSERT INTO bots (id, user_id, slug, name, role, soul, runtime, is_default) VALUES
        ('b-op-default', 'rcanoff-id', 'default', 'Hermes', 'Default', 'soul', 'hermes', 1),
        ('b-op-travel', 'rcanoff-id', 'travel', 'Travel', 'Flights', 'soul', 'hermes', 0),
        ('b-aline-default', 'aline-id', 'default', 'Hermes', 'Default', 'soul', 'hermes', 1),
        ('b-aline-grok', 'aline-id', 'grok', 'Grok', 'Mac agent', 'soul', 'grok', 0);
    `)

    initSchema(db)

    const rows = db
      .prepare(`SELECT id, hermes_profile_name FROM bots ORDER BY id`)
      .all() as Array<{ id: string; hermes_profile_name: string | null }>

    expect(rows).toEqual([
      { id: 'b-aline-default', hermes_profile_name: 'alinetusi-default' },
      { id: 'b-aline-grok', hermes_profile_name: null },
      { id: 'b-op-default', hermes_profile_name: null },
      { id: 'b-op-travel', hermes_profile_name: 'rcanoff-travel' },
    ])
  })
})
