import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initSchema } from '../src/db/schema.js'
import { findEditablePair, MessageEditError, applyMessageEdit } from '../src/services/message-editor.js'

describe('findEditablePair', () => {
  const messages = [
    { id: 'u1', conversation_id: 'c1', role: 'user' as const, content: 'hello', created_at: 't1' },
    { id: 'a1', conversation_id: 'c1', role: 'assistant' as const, content: 'hi', created_at: 't2' },
    { id: 'u2', conversation_id: 'c1', role: 'user' as const, content: 'again', created_at: 't3' },
    { id: 'a2', conversation_id: 'c1', role: 'assistant' as const, content: 'sure', created_at: 't4' },
  ]

  it('accepts the latest user message in a completed pair', () => {
    expect(findEditablePair(messages, 'u2')).toEqual({
      userMessage: messages[2],
      assistantMessage: messages[3],
    })
  })

  it('rejects older user messages', () => {
    expect(() => findEditablePair(messages, 'u1')).toThrow(MessageEditError)
  })

  it('rejects missing messages', () => {
    expect(() => findEditablePair(messages, 'missing')).toThrow(MessageEditError)
  })
})

describe('applyMessageEdit', () => {
  function seedDb() {
    const db = new Database(':memory:')
    initSchema(db)
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'operator', 'hash');
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'hs-old');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('u1', 'c1', 'user', 'old text');
      INSERT INTO messages (id, conversation_id, role, content) VALUES ('a1', 'c1', 'assistant', 'old reply');
      INSERT INTO message_runs (id, conversation_id, user_message_id, assistant_message_id, status, finished_at)
      VALUES ('r1', 'c1', 'u1', 'a1', 'completed', datetime('now'));
    `)
    return db
  }

  it('updates the user message, removes assistant reply, and rotates session', () => {
    const db = seedDb()
    const result = applyMessageEdit(db, 'c1', 'u1', 'new text')

    expect(result.message).toMatchObject({ id: 'u1', content: 'new text', role: 'user' })
    expect(result.removedAssistantMessageId).toBe('a1')
    expect(result.hermesSessionId).not.toBe('hs-old')

    const messages = db
      .prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY rowid ASC')
      .all('c1')
    expect(messages).toEqual([{ id: 'u1', role: 'user', content: 'new text' }])

    const run = db
      .prepare('SELECT status, user_message_id FROM message_runs WHERE conversation_id = ?')
      .get('c1') as { status: string; user_message_id: string }
    expect(run).toEqual({ status: 'running', user_message_id: 'u1' })
  })
})