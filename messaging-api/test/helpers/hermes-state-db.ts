import Database from 'better-sqlite3'

export function createHermesStateDb(path: string): Database.Database {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      reasoning_content TEXT,
      timestamp REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `)
  return db
}

export function seedCronSession(
  db: Database.Database,
  input: {
    sessionId: string
    endedAtUnix: number
    startedAtUnix?: number
    messages: Array<{
      role: string
      tool_calls?: string
      reasoning_content?: string
      timestamp: number
    }>
  },
): void {
  db.prepare(`
    INSERT INTO sessions (id, source, started_at, ended_at, end_reason)
    VALUES (?, 'cron', ?, ?, 'cron_complete')
  `).run(input.sessionId, input.startedAtUnix ?? input.endedAtUnix - 40, input.endedAtUnix)

  const insertMessage = db.prepare(`
    INSERT INTO messages (session_id, role, tool_calls, reasoning_content, timestamp, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `)

  for (const message of input.messages) {
    insertMessage.run(
      input.sessionId,
      message.role,
      message.tool_calls ?? null,
      message.reasoning_content ?? null,
      message.timestamp,
    )
  }
}