import { z } from 'zod'

export const typingPostBodySchema = z.object({
  active: z.boolean(),
})

export const typingEventDataSchema = z.object({
  conversationId: z.uuid(),
  actorId: z.uuid(),
  active: z.boolean(),
})

export type TypingEventData = z.infer<typeof typingEventDataSchema>
