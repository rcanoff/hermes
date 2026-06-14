import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000'
const results = []

function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
}

function fail(name, detail) {
  results.push({ name, ok: false, detail })
}

async function req(method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

async function mcpClient() {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.COMPANION_MCP_BEARER_TOKEN}` },
    },
  })
  const client = new Client({ name: 'smoke', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

try {
  const health = await req('GET', '/health')
  if (health.status === 200 && health.json?.ok === true) pass('GET /health')
  else fail('GET /health', `${health.status} ${JSON.stringify(health.json)}`)

  let token
  const login = await req('POST', '/auth/login', {
    body: { username: 'operator', password: 'change-me' },
  })
  if (login.status === 200 && login.json?.token) {
    token = login.json.token
    pass('POST /auth/login (operator)')
  } else {
    const { client, transport } = await mcpClient()
    const inviteResult = await client.callTool({
      name: 'create_companion_invite',
      arguments: { label: 'smoke-test' },
    })
    const inviteText = inviteResult.content.find((part) => part.type === 'text')?.text
    const invite = JSON.parse(inviteText)
    const rawToken = invite.url.split('/invite/')[1]
    const username = `smoke_${Date.now().toString(36)}`
    const activate = await req('POST', '/auth/activate', {
      body: { token: rawToken, username, password: 'smoke-test-pass12' },
    })
    if (activate.status === 200 && activate.json?.token) {
      token = activate.json.token
      pass('invite activation flow', `user=${username}`)
    } else {
      fail('invite activation flow', `${activate.status} ${JSON.stringify(activate.json)}`)
    }
    await transport.close()
    await client.close()
  }

  if (!token) throw new Error('No auth token available')

  const me = await req('GET', '/auth/me', { token })
  if (me.status === 200 && me.json?.username) pass('GET /auth/me', me.json.username)
  else fail('GET /auth/me', `${me.status}`)

  const c1 = await req('POST', '/conversations', { token })
  const c2 = await req('POST', '/conversations', { token })
  if (c1.status !== 201 || c2.status !== 201) {
    fail('POST /conversations', `c1=${c1.status} c2=${c2.status}`)
  } else if (!c1.json.updated_at || !c2.json.updated_at) {
    fail('conversation updated_at field', JSON.stringify({ c1: c1.json, c2: c2.json }))
  } else {
    pass('POST /conversations returns updated_at')
  }

  const id1 = c1.json.id
  const id2 = c2.json.id

  const listBefore = await req('GET', '/conversations', { token })
  const orderBefore = listBefore.json.map((conversation) => conversation.id)
  const pairBefore = orderBefore.filter((conversationId) => conversationId === id1 || conversationId === id2)
  const c2Before = listBefore.json.find((conversation) => conversation.id === id2)
  const c1Before = listBefore.json.find((conversation) => conversation.id === id1)
  if (
    listBefore.status === 200 &&
    pairBefore.length === 2 &&
    c2Before?.updated_at &&
    c1Before?.updated_at &&
    c2Before.updated_at >= c1Before.updated_at
  ) {
    pass('list order before message', `c2 updated_at=${c2Before.updated_at}`)
  } else {
    fail('list order before message', pairBefore.join(','))
  }

  const msg = await req('POST', `/conversations/${id1}/messages`, {
    token,
    body: { role: 'user', content: 'smoke test ping' },
  })
  if (msg.status === 202) pass('POST /conversations/:id/messages')
  else fail('POST /conversations/:id/messages', `${msg.status} ${JSON.stringify(msg.json)}`)

  await new Promise((resolve) => setTimeout(resolve, 2000))

  const listAfter = await req('GET', '/conversations', { token })
  const orderAfter = listAfter.json.map((conversation) => conversation.id)
  const bumped = listAfter.json.find((conversation) => conversation.id === id1)
  const pairAfter = orderAfter.filter((conversationId) => conversationId === id1 || conversationId === id2)
  if (listAfter.status === 200 && pairAfter[0] === id1 && pairAfter[1] === id2) {
    pass('list order after message', 'messaged conversation ahead of sibling')
  } else {
    fail('list order after message', `expected ${id1},${id2} got ${pairAfter.join(',')}`)
  }

  if (bumped && bumped.updated_at >= bumped.created_at) {
    pass('updated_at bumped on message', bumped.updated_at)
  } else {
    fail('updated_at bumped', JSON.stringify(bumped))
  }

  const { client, transport } = await mcpClient()
  const accounts = await client.callTool({ name: 'list_companion_accounts', arguments: {} })
  const accountsText = accounts.content.find((part) => part.type === 'text')?.text
  const accountPayload = JSON.parse(accountsText)
  if (Array.isArray(accountPayload.users) && accountPayload.users.length > 0) {
    pass('MCP list_companion_accounts', `${accountPayload.users.length} user(s)`)
  } else {
    fail('MCP list_companion_accounts', accountsText)
  }

  const loc = await client.callTool({
    name: 'get_user_location',
    arguments: { username: me.json.username },
  })
  const locText = loc.content.find((part) => part.type === 'text')?.text
  const locPayload = JSON.parse(locText)
  if (typeof locPayload.available === 'boolean') {
    pass('MCP get_user_location', locPayload.available ? 'available' : 'unavailable')
  } else {
    fail('MCP get_user_location', locText)
  }

  await transport.close()
  await client.close()
} catch (error) {
  fail('unexpected error', error instanceof Error ? error.message : String(error))
}

const failed = results.filter((result) => !result.ok)
console.log('\n=== Smoke test results ===\n')
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)