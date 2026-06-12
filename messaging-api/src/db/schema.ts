import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
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
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS conversations_user_created_idx
      ON conversations (user_id, created_at DESC, id DESC);

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

    CREATE TABLE IF NOT EXISTS conversation_locations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy_m REAL NOT NULL,
      timestamp TEXT NOT NULL,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `)
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
