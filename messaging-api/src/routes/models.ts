import type { FastifyPluginAsync } from 'fastify'
import {
  DEFAULT_RECENT_MODELS_LIMIT,
  listRecentModelsForUser,
} from '../db/repos/conversations.js'
import { resolveDefaultModel } from '../db/repos/settings.js'
import {
  GROK_TUI_PROVIDER,
  curatedGrokTuiModels,
  curatedModelOrFallback,
} from '../lib/companion-models.js'
import { GrokGatewayError } from '../services/grok-gateway-client.js'

const modelsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/models', { preHandler: app.authenticate }, async (request, reply) => {
    const runtime = parseModelsRuntime((request.query as { runtime?: string }).runtime)
    if (runtime === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const recents = listRecentModelsForUser(
      app.db,
      request.userId,
      DEFAULT_RECENT_MODELS_LIMIT,
    )

    if (runtime === 'grok') {
      try {
        const list = await app.grokGatewayClient.listModels()
        const models = curatedGrokTuiModels(list.models)
        return {
          models,
          recents: recents
            .filter((entry) => entry.provider === GROK_TUI_PROVIDER)
            .map((entry) => curatedModelOrFallback(models, entry.model, entry.provider)),
          default: {
            model: list.default,
            provider: GROK_TUI_PROVIDER,
          },
        }
      } catch (error) {
        if (error instanceof GrokGatewayError && error.code === 'grok_unavailable') {
          return reply.code(503).send({ error: 'grok_unavailable' })
        }
        throw error
      }
    }

    const defaults = resolveDefaultModel(app.db, app.hermesHome)
    return {
      models: app.companionModels,
      recents: recents
        .filter((entry) => entry.provider !== GROK_TUI_PROVIDER)
        .map((entry) =>
          curatedModelOrFallback(app.companionModels, entry.model, entry.provider),
        ),
      default: {
        model: defaults.model,
        provider: defaults.provider,
      },
    }
  })
}

function parseModelsRuntime(value: unknown): 'hermes' | 'grok' | null {
  if (value === undefined || value === '') {
    return 'hermes'
  }
  if (value === 'hermes' || value === 'grok') {
    return value
  }
  return null
}

export default modelsRoutes