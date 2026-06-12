import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'

declare module 'fastify' {
  interface FastifyReply {
    sseInit: () => void
    sseSend: (event: string, data: unknown) => void
    sseEnd: () => void
  }
}

const ssePlugin: FastifyPluginAsync = async (app) => {
  app.decorateReply('sseInit', function sseInit(this: FastifyReply) {
    this.hijack()
    this.raw.statusCode = 200
    this.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
    this.raw.setHeader('cache-control', 'no-cache, no-transform')
    this.raw.setHeader('connection', 'keep-alive')
    this.raw.setHeader('x-accel-buffering', 'no')
    this.raw.flushHeaders?.()
  })

  app.decorateReply('sseSend', function sseSend(this: FastifyReply, event: string, data: unknown) {
    this.raw.write(`event: ${event}\n`)
    this.raw.write(`data: ${JSON.stringify(data)}\n\n`)
  })

  app.decorateReply('sseEnd', function sseEnd(this: FastifyReply) {
    if (!this.raw.writableEnded) {
      this.raw.end()
    }
  })
}

export default fp(ssePlugin, { name: 'sse-plugin' })
