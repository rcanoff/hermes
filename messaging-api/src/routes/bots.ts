import type { FastifyPluginAsync } from 'fastify'
import {
  botOwner,
  deleteBot,
  getBotByIdForUser,
  getBotBySlug,
  getBotLastActivityMap,
  getBotNotificationsEnabled,
  getBotNotificationsEnabledMap,
  getGrokBot,
  insertBot,
  isBotRuntime,
  listBotsPage,
  MAX_BOT_RESPONSIBILITIES_CHARS,
  normalizeBotRuntime,
  seedDefaultBot,
  soulForResponse,
  updateBot,
  upsertBotNotificationsEnabled,
  type BotRow,
  type BotRuntime,
} from '../db/repos/bots.js'
import { listConversationsReferencingBot } from '../db/repos/conversations.js'
import { removeHermesCronJob } from '../lib/hermes-cron-jobs.js'
import { emitConversationDeleted } from '../services/chat-sync-emitter.js'
import { publishConversationDeleted } from '../streams/sse-mutation-publisher.js'
import {
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_ICON,
  isBotColor,
  isBotIcon,
  normalizeBotIcon,
  type BotColor,
  type BotIcon,
} from '../lib/bot-appearance.js'
import {
  DEFAULT_BOT_SLUG,
  addHonchoHost,
  createBotProfile,
  defaultSoulFromRole,
  deleteBotProfile,
  ensureSkillsOverlay,
  slugifyBotName,
  writeProfileYaml,
  writeSoulFile,
} from '../lib/hermes-profile.js'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../lib/pagination.js'

const MAX_NAME_CHARS = 80
const MAX_ROLE_CHARS = 1000
const MAX_SOUL_CHARS = 32_000

interface CreateBotBody {
  name: string
  role: string
  soul: string
  slug: string
  icon: BotIcon
  color: BotColor
  runtime: BotRuntime
}

interface PatchBotBody {
  name?: string
  role?: string
  soul?: string
  responsibilities?: string
  icon?: BotIcon
  color?: BotColor
  notifications_enabled?: boolean
}

const botRoutes: FastifyPluginAsync = async (app) => {
  app.get('/bots', { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; before?: string; after?: string }
    const limit = parsePageLimit(query.limit)
    if (limit === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const anchors = parseListAnchors(query)
    if (anchors === null) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    seedDefaultBot(app.db, request.userId, app.hermesHome)

    const page = listBotsPage(app.db, request.userId, limit, anchors)
    if (!page) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const firstId = page.bots[0]?.id
    const lastId = page.bots[page.bots.length - 1]?.id
    const botIds = page.bots.map((row) => row.id)
    const notifications = getBotNotificationsEnabledMap(app.db, request.userId, botIds)
    const lastActivity = getBotLastActivityMap(app.db, request.userId, botIds)

    return {
      bots: page.bots.map((row) =>
        toBotResponse(
          row,
          app.hermesHome,
          notifications.get(row.id) ?? true,
          lastActivity.get(row.id) ?? { last_message_at: null, last_message: null },
        ),
      ),
      _links: buildHalLinks({
        basePath: '/bots',
        limit,
        before: anchors.before,
        after: anchors.after,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        firstId,
        lastId,
      }),
    }
  })

  app.post('/bots', { preHandler: app.authenticate }, async (request, reply) => {
    const body = parseCreateBody(request.body)
    if (!body) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    seedDefaultBot(app.db, request.userId, app.hermesHome)

    if (body.slug === DEFAULT_BOT_SLUG || getBotBySlug(app.db, request.userId, body.slug)) {
      return reply.code(409).send({ error: 'slug_taken' })
    }

    if (body.runtime === 'grok' && getGrokBot(app.db, request.userId)) {
      return reply.code(409).send({ error: 'grok_bot_exists' })
    }

    let row: BotRow
    try {
      row = insertBot(app.db, {
        userId: request.userId,
        slug: body.slug,
        name: body.name,
        role: body.role,
        soul: body.soul,
        icon: body.icon,
        color: body.color,
        runtime: body.runtime,
      })
    } catch (error) {
      if (isUniqueConstraint(error)) {
        if (body.runtime === 'grok' && getGrokBot(app.db, request.userId)) {
          return reply.code(409).send({ error: 'grok_bot_exists' })
        }
        return reply.code(409).send({ error: 'slug_taken' })
      }
      throw error
    }

    if (row.runtime !== 'grok') {
      try {
        createBotProfile({
          hermesHome: app.hermesHome,
          owner: botOwner(row),
          slug: row.slug,
          name: row.name,
          role: row.role,
          soul: row.soul,
        })
      } catch (error) {
        deleteBot(app.db, row.id, request.userId)
        throw error
      }

      addHonchoHost(app.hermesHome, botOwner(row), row.slug)
    }

    return reply.code(201).send(
      toBotResponse(
        row,
        app.hermesHome,
        true,
        getBotLastActivityMap(app.db, request.userId, [row.id]).get(row.id) ?? {
          last_message_at: null,
          last_message: null,
        },
      ),
    )
  })

  app.get('/bots/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = getBotByIdForUser(app.db, request.userId, id)
    if (!row) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (normalizeBotRuntime(row.runtime) !== 'grok') {
      try {
        ensureSkillsOverlay(app.hermesHome, botOwner(row), row.slug)
      } catch (error) {
        app.log.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            botId: row.id,
            slug: row.slug,
          },
          'failed to ensure skills overlay for bot profile',
        )
      }
    }

    return toBotResponse(
      row,
      app.hermesHome,
      getBotNotificationsEnabled(app.db, request.userId, row.id),
      getBotLastActivityMap(app.db, request.userId, [row.id]).get(row.id) ?? {
        last_message_at: null,
        last_message: null,
      },
    )
  })

  app.patch('/bots/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = parsePatchBody(request.body)
    if (!body) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    const existing = getBotByIdForUser(app.db, request.userId, id)
    if (!existing) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const hasBotPatch =
      body.name !== undefined ||
      body.role !== undefined ||
      body.soul !== undefined ||
      body.responsibilities !== undefined ||
      body.icon !== undefined ||
      body.color !== undefined

    let updated = existing
    if (hasBotPatch) {
      const next = updateBot(app.db, id, body)
      if (!next) {
        return reply.code(404).send({ error: 'not_found' })
      }
      updated = next
    }

    if (body.soul !== undefined && updated.runtime !== 'grok') {
      writeSoulFile(app.hermesHome, botOwner(updated), updated.slug, updated.soul)
    }

    if (
      (body.name !== undefined || body.role !== undefined) &&
      updated.runtime !== 'grok'
    ) {
      writeProfileYaml(app.hermesHome, botOwner(updated), updated.slug, {
        name: updated.name,
        role: updated.role,
      })
    }

    if (body.notifications_enabled !== undefined) {
      upsertBotNotificationsEnabled(app.db, request.userId, id, body.notifications_enabled)
    }

    return toBotResponse(
      updated,
      app.hermesHome,
      getBotNotificationsEnabled(app.db, request.userId, updated.id),
      getBotLastActivityMap(app.db, request.userId, [updated.id]).get(updated.id) ?? {
        last_message_at: null,
        last_message: null,
      },
    )
  })

  app.delete('/bots/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = getBotByIdForUser(app.db, request.userId, id)
    if (!existing) {
      return reply.code(404).send({ error: 'not_found' })
    }

    if (existing.is_default === 1 || existing.slug === DEFAULT_BOT_SLUG) {
      return reply.code(409).send({ error: 'default_bot' })
    }

    const conversations = listConversationsReferencingBot(
      app.db,
      existing.id,
      request.userId,
    )
    for (const conversation of conversations) {
      if (conversation.kind === 'job' && conversation.hermes_job_id?.trim()) {
        const hermesJobId = conversation.hermes_job_id.trim()
        try {
          await removeHermesCronJob(app.cronJobsPath, hermesJobId)
        } catch (error) {
          app.log.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              hermesJobId,
              conversationId: conversation.id,
            },
            'failed to remove Hermes cron job while deleting bot',
          )
        }
      }

      if (normalizeBotRuntime(existing.runtime) === 'grok') {
        try {
          await app.grokGatewayClient.deleteSession(conversation.id)
        } catch (error) {
          app.log.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              conversationId: conversation.id,
            },
            'failed to delete grok gateway session while deleting bot',
          )
        }
      }

      emitConversationDeleted(app.db, conversation.user_id, conversation.id)
      publishConversationDeleted(app.streamHub, conversation.user_id, conversation.id)
    }

    deleteBot(app.db, existing.id, request.userId)
    if (existing.runtime !== 'grok') {
      deleteBotProfile(app.hermesHome, botOwner(existing), existing.slug)
    }
    return reply.code(204).send()
  })
}

export default botRoutes

function toBotResponse(
  row: BotRow,
  hermesHome: string,
  notificationsEnabled: boolean,
  lastActivity: { last_message_at: string | null; last_message: string | null },
) {
  return {
    id: row.id,
    user_id: row.user_id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    soul: soulForResponse(row, hermesHome),
    responsibilities: row.responsibilities,
    icon: normalizeBotIcon(row.icon),
    color: row.color,
    runtime: normalizeBotRuntime(row.runtime),
    notifications_enabled: notificationsEnabled,
    last_message_at: lastActivity.last_message_at,
    last_message: lastActivity.last_message,
    is_default: row.is_default === 1,
    created_at: row.created_at,
  }
}

function parseCreateBody(body: unknown): CreateBotBody | null {
  if (!isRecord(body)) {
    return null
  }

  const name = parseBoundedString(body.name, MAX_NAME_CHARS)
  const role = parseBoundedString(body.role, MAX_ROLE_CHARS)
  if (!name || !role) {
    return null
  }

  const slug = slugifyBotName(name)
  if (!slug) {
    return null
  }

  let soul: string
  if (body.soul === undefined) {
    soul = defaultSoulFromRole(name, role)
  } else {
    const parsedSoul = parseBoundedString(body.soul, MAX_SOUL_CHARS)
    if (!parsedSoul) {
      return null
    }
    soul = parsedSoul
  }

  let icon: BotIcon = DEFAULT_BOT_ICON
  if (body.icon !== undefined) {
    if (!isBotIcon(body.icon)) {
      return null
    }
    icon = body.icon
  }

  let color: BotColor = DEFAULT_BOT_COLOR
  if (body.color !== undefined) {
    if (!isBotColor(body.color)) {
      return null
    }
    color = body.color
  }

  let runtime: BotRuntime = 'hermes'
  if (body.runtime !== undefined) {
    if (!isBotRuntime(body.runtime)) {
      return null
    }
    runtime = body.runtime
  }

  return { name, role, soul, slug, icon, color, runtime }
}

function parsePatchBody(body: unknown): PatchBotBody | null {
  if (!isRecord(body)) {
    return null
  }

  if ('runtime' in body) {
    return null
  }

  const patch: PatchBotBody = {}
  if (body.name !== undefined) {
    const name = parseBoundedString(body.name, MAX_NAME_CHARS)
    if (!name) {
      return null
    }
    patch.name = name
  }

  if (body.role !== undefined) {
    const role = parseBoundedString(body.role, MAX_ROLE_CHARS)
    if (!role) {
      return null
    }
    patch.role = role
  }

  if (body.soul !== undefined) {
    const soul = parseBoundedString(body.soul, MAX_SOUL_CHARS)
    if (!soul) {
      return null
    }
    patch.soul = soul
  }

  if (body.responsibilities !== undefined) {
    const responsibilities = parseBoundedString(body.responsibilities, MAX_BOT_RESPONSIBILITIES_CHARS)
    if (!responsibilities) {
      return null
    }
    patch.responsibilities = responsibilities
  }

  if (body.icon !== undefined) {
    if (!isBotIcon(body.icon)) {
      return null
    }
    patch.icon = body.icon
  }

  if (body.color !== undefined) {
    if (!isBotColor(body.color)) {
      return null
    }
    patch.color = body.color
  }

  if (body.notifications_enabled !== undefined) {
    if (typeof body.notifications_enabled !== 'boolean') {
      return null
    }
    patch.notifications_enabled = body.notifications_enabled
  }

  if (
    patch.name === undefined &&
    patch.role === undefined &&
    patch.soul === undefined &&
    patch.responsibilities === undefined &&
    patch.icon === undefined &&
    patch.color === undefined &&
    patch.notifications_enabled === undefined
  ) {
    return null
  }

  return patch
}

function parseBoundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxChars) {
    return null
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}
