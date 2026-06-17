import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { denyToken, isTokenDenied } from '../src/db/repos/sessions.js'
import { markRunCompleted, markRunFailed } from '../src/db/repos/runs.js'
import { initSchema, reconcileRunningRuns } from '../src/db/schema.js'
import { closeDb, getDb } from '../src/db/index.js'

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
