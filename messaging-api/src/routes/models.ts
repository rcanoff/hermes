import type { FastifyPluginAsync } from 'fastify'
import {
  COMPANION_DEFAULT_MODEL,
  COMPANION_DEFAULT_PROVIDER,
} from '../lib/companion-models.js'

const modelsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/models', { preHandler: app.authenticate }, async () => ({
    models: app.companionModels,
    default: {
      model: COMPANION_DEFAULT_MODEL,
      provider: COMPANION_DEFAULT_PROVIDER,
    },
  }))
}

export default modelsRoutes