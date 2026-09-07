import type { FastifyPluginAsync } from 'fastify'
import { resolveDefaultModel, saveDefaultModel } from '../db/repos/settings.js'
import {
  assertCuratedModel,
  curatedModelOrFallback,
} from '../lib/companion-models.js'

const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/settings', { preHandler: app.authenticate }, async () => {
    const defaults = resolveDefaultModel(app.db, app.hermesHome)
    return {
      default_model: curatedModelOrFallback(
        app.companionModels,
        defaults.model,
        defaults.provider,
      ),
    }
  })

  app.patch('/settings', { preHandler: app.authenticate }, async (request, reply) => {
    const body = parsePatchSettingsBody(request.body)
    if (!body) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    try {
      assertCuratedModel(app.companionModels, body.model, body.provider)
    } catch {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    saveDefaultModel(app.db, app.hermesHome, body)
    return {
      default_model: curatedModelOrFallback(
        app.companionModels,
        body.model,
        body.provider,
      ),
    }
  })
}

export default settingsRoutes

function parsePatchSettingsBody(value: unknown): { model: string; provider: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const defaultModel = (value as { default_model?: unknown }).default_model
  if (typeof defaultModel !== 'object' || defaultModel === null || Array.isArray(defaultModel)) {
    return null
  }

  const record = defaultModel as { model?: unknown; provider?: unknown }
  if (typeof record.model !== 'string' || typeof record.provider !== 'string') {
    return null
  }

  const model = record.model.trim()
  const provider = record.provider.trim()
  if (!model || !provider) {
    return null
  }

  return { model, provider }
}
