import type { FastifyPluginAsync } from 'fastify'
import { deliverCronRun } from '../db/repos/cron-deliver.js'
import { isAuthorizedHeader } from './mcp.js'

interface CronDeliverBody {
  hermes_job_id?: string
  content?: string
  run_at?: string
  status?: 'ok' | 'error'
}

const cronInternalRoutes: FastifyPluginAsync = async (app) => {
  app.post('/internal/cron/deliver', async (request, reply) => {
    if (!isAuthorizedHeader(request.headers.authorization, app.cronWebhookBearer)) {
      reply.header('WWW-Authenticate', 'Bearer realm="cron"')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const query = request.query as { job_id?: string }
    const body = parseDeliverBody(request.body)

    const hermesJobId = (body.hermes_job_id ?? query.job_id ?? '').trim()
    if (!hermesJobId) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const content = typeof body.content === 'string' ? body.content : ''
    const result = deliverCronRun(app.db, {
      hermesJobId,
      content,
      status: body.status,
      runAt: body.run_at,
    })

    if (!result) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (result.kind === 'silent') {
      return reply.code(204).send()
    }

    return { message_id: result.messageId }
  })
}

export default cronInternalRoutes

function parseDeliverBody(body: unknown): CronDeliverBody {
  if (typeof body === 'string') {
    return { content: body }
  }

  if (typeof body !== 'object' || body === null) {
    return {}
  }

  const record = body as CronDeliverBody
  return {
    hermes_job_id: record.hermes_job_id,
    content: record.content,
    run_at: record.run_at,
    status: record.status,
  }
}