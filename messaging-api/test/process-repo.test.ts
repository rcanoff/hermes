import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { insertMessage } from '../src/db/repos/messages.js'
import { getProcessByAssistantMessageIds, insertMessageProcess } from '../src/db/repos/process.js'
import { initSchema } from '../src/db/schema.js'

describe('message_process repo', () => {
  it('inserts and loads process lines for an assistant message', () => {
    const db = new Database(':memory:')
    initSchema(db)

    db.prepare(`
      INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')
    `).run()
    db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id)
      VALUES ('c1', 'u1', 'sess-1')
    `).run()

    const assistantId = insertMessage(db, {
      conversationId: 'c1',
      role: 'assistant',
      content: 'Done',
    })

    insertMessageProcess(db, {
      assistantMessageId: assistantId,
      conversationId: 'c1',
      lines: [
        { phase: 'reasoning', text: 'Thinking…' },
        { phase: 'activity', text: 'Loading skill: demo', tool: 'skill_view', args: { name: 'demo' } },
      ],
    })

    const map = getProcessByAssistantMessageIds(db, [assistantId])
    expect(map.get(assistantId)).toEqual({
      lines: [
        { phase: 'reasoning', text: 'Thinking…' },
        { phase: 'activity', text: 'Loading skill: demo', tool: 'skill_view', args: { name: 'demo' } },
      ],
    })
  })

  it('cascades delete when assistant message is removed', () => {
    const db = new Database(':memory:')
    initSchema(db)

    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'op', 'hash')`).run()
    db.prepare(`
      INSERT INTO conversations (id, user_id, hermes_session_id) VALUES ('c1', 'u1', 'sess-1')
    `).run()

    const assistantId = insertMessage(db, {
      conversationId: 'c1',
      role: 'assistant',
      content: 'Old reply',
    })

    insertMessageProcess(db, {
      assistantMessageId: assistantId,
      conversationId: 'c1',
      lines: [{ phase: 'activity', text: 'Running command', tool: 'terminal' }],
    })

    db.prepare(`DELETE FROM messages WHERE id = ?`).run(assistantId)

    expect(getProcessByAssistantMessageIds(db, [assistantId]).size).toBe(0)
  })
})