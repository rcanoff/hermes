export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface HalLink {
  href: string
}

export interface HalLinks {
  self: HalLink
  next?: HalLink
  prev?: HalLink
}

export type HalLinkStyle = 'newest-first' | 'chronological-tail'

export function parsePageLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
    return null
  }

  return parsed
}

export function isValidAnchor(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function parseListAnchors(query: {
  before?: string
  after?: string
}): { before?: string; after?: string } | null {
  const hasBefore = query.before !== undefined
  const hasAfter = query.after !== undefined

  if (hasBefore && hasAfter) {
    return null
  }

  if (hasBefore && !isValidAnchor(query.before)) {
    return null
  }

  if (hasAfter && !isValidAnchor(query.after)) {
    return null
  }

  return {
    before: query.before,
    after: query.after,
  }
}

export interface BuildHalLinksInput {
  basePath: string
  limit: number
  before?: string
  after?: string
  hasOlder: boolean
  hasNewer: boolean
  firstId?: string
  lastId?: string
  linkStyle?: HalLinkStyle
}

export function buildHalLinks(input: BuildHalLinksInput): HalLinks {
  const params = new URLSearchParams()
  params.set('limit', String(input.limit))
  if (input.before) {
    params.set('before', input.before)
  }
  if (input.after) {
    params.set('after', input.after)
  }

  const links: HalLinks = {
    self: { href: `${input.basePath}?${params.toString()}` },
  }

  const linkStyle = input.linkStyle ?? 'newest-first'

  if (linkStyle === 'newest-first') {
    if (input.hasOlder && input.lastId) {
      const nextParams = new URLSearchParams()
      nextParams.set('limit', String(input.limit))
      nextParams.set('before', input.lastId)
      links.next = { href: `${input.basePath}?${nextParams.toString()}` }
    }

    if (input.hasNewer && input.firstId) {
      const prevParams = new URLSearchParams()
      prevParams.set('limit', String(input.limit))
      prevParams.set('after', input.firstId)
      links.prev = { href: `${input.basePath}?${prevParams.toString()}` }
    }
  } else {
    if (input.hasOlder && input.firstId) {
      const prevParams = new URLSearchParams()
      prevParams.set('limit', String(input.limit))
      prevParams.set('before', input.firstId)
      links.prev = { href: `${input.basePath}?${prevParams.toString()}` }
    }

    if (input.hasNewer && input.lastId) {
      const nextParams = new URLSearchParams()
      nextParams.set('limit', String(input.limit))
      nextParams.set('after', input.lastId)
      links.next = { href: `${input.basePath}?${nextParams.toString()}` }
    }
  }

  return links
}