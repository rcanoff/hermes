import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import httpProxy from 'http-proxy'
import type { BrowserDaemonConfig } from './config.js'
import { BraveLauncher } from './brave.js'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) {
    return null
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export function createServer(config: BrowserDaemonConfig) {
  const launcher = new BraveLauncher(config)
  const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
  })

  proxy.on('error', (error, req, res) => {
    const message = error instanceof Error ? error.message : String(error)
    if (res && 'writeHead' in res) {
      sendJson(res as ServerResponse, 502, { error: 'cdp_proxy_error', message })
      return
    }
    console.error('CDP proxy error for', req?.url, message)
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const status = await launcher.status()
        sendJson(res, 200, { ok: true, brave: status })
        return
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, await launcher.status())
        return
      }

      if (req.method === 'POST' && url.pathname === '/start') {
        const status = await launcher.ensureRunning()
        sendJson(res, 200, { ok: true, brave: status })
        return
      }

      if (req.method === 'GET' && url.pathname === '/cdp-url') {
        const status = await launcher.ensureRunning()
        if (!status.webSocketDebuggerUrl) {
          sendJson(res, 503, { error: 'cdp_unavailable' })
          return
        }
        sendJson(res, 200, {
          cdpUrl: `http://${config.cdpPublicHost}:${config.cdpPublicPort}`,
          webSocketDebuggerUrl: status.webSocketDebuggerUrl,
        })
        return
      }

      await launcher.ensureRunning()

      if (url.pathname === '/json/version') {
        const version = await launcher.fetchCdpVersion()
        const ws = String(version.webSocketDebuggerUrl ?? '')
        if (ws) {
          version.webSocketDebuggerUrl = launcher.rewriteWebSocketUrl(ws)
        }
        sendJson(res, 200, version)
        return
      }

      if (url.pathname === '/json' || url.pathname.startsWith('/json/')) {
        proxy.web(req, res, { target: launcher.cdpBaseUrl(), changeOrigin: true })
        return
      }

      sendJson(res, 404, {
        error: 'not_found',
        routes: ['GET /health', 'GET /status', 'POST /start', 'GET /cdp-url', 'GET /json/version'],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: 'browser_daemon_error', message })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    void launcher
      .ensureRunning()
      .then(() => {
        proxy.ws(req, socket, head, {
          target: `ws://127.0.0.1:${config.braveCdpPort}`,
          changeOrigin: true,
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('WebSocket upgrade failed:', message)
        socket.write(
          'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n' +
            JSON.stringify({ error: 'browser_unavailable', message }),
        )
        socket.destroy()
      })
  })

  return { server, launcher }
}

export async function readControlRequest(req: IncomingMessage) {
  return readJsonBody(req)
}