import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import type { AppOptions } from './types.js'

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true })

  app.register(jwt, { secret: options.jwtSecret })
  app.get('/health', async () => ({ ok: true }))

  return app
}
