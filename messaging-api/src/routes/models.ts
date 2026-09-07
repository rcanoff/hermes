import type { FastifyPluginAsync } from 'fastify'
import {
  DEFAULT_RECENT_MODELS_LIMIT,
  listRecentModelsForUser,
} from '../db/repos/conversations.js'
import { resolveDefaultModel } from '../db/repos/settings.js'
import { curatedModelOrFallback } from '../lib/companion-models.js'

const modelsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/models', { preHandler: app.authenticate }, async (request) => {
    const defaults = resolveDefaultModel(app.db, app.hermesHome)
    const recents = listRecentModelsForUser(
      app.db,
      request.userId,
      DEFAULT_RECENT_MODELS_LIMIT,
    )

    return {
      models: app.companionModels,
      recents: recents.map((entry) =>
        curatedModelOrFallback(app.companionModels, entry.model, entry.provider),
      ),
      default: {
        model: defaults.model,
        provider: defaults.provider,
      },
    }
  })
}

export default modelsRoutes