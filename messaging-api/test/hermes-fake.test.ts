import { describe, expect, it } from 'vitest'
import { FakeHermesClient } from './helpers/hermes.js'

describe('FakeHermesClient concurrent streams', () => {
  it('routes events to independent streamChat calls', async () => {
    const client = new FakeHermesClient()

    const assistantPromise = (async () => {
      let text = ''
      for await (const event of client.streamChat({
        hermesSessionId: 'assistant-session',
        messages: [{ role: 'user', content: 'Hello' }],
      })) {
        if (event.type === 'token' && event.text) {
          text += event.text
        }
        if (event.type === 'done') {
          return text
        }
      }
      return text
    })()

    const titlePromise = (async () => {
      let text = ''
      for await (const event of client.streamChat({
        hermesSessionId: 'title-session',
        messages: [
          { role: 'system', content: 'Generate a short conversation title' },
          { role: 'user', content: 'Hello' },
        ],
      })) {
        if (event.type === 'token' && event.text) {
          text += event.text
        }
        if (event.type === 'done') {
          return text
        }
      }
      return text
    })()

    expect(client.requests).toHaveLength(2)

    client.pushToken('Hi', 0)
    client.pushDone(0)
    client.closeWithoutDone(0)

    client.pushToken('Greetings', 1)
    client.pushDone(1)
    client.closeWithoutDone(1)

    await expect(assistantPromise).resolves.toBe('Hi')
    await expect(titlePromise).resolves.toBe('Greetings')
  })
})