import { describe, expect, it } from 'vitest'
import { buildHalLinks, parseListAnchors, parsePageLimit } from '../src/lib/pagination.js'

describe('pagination helpers', () => {
  it('parses default limit', () => {
    expect(parsePageLimit(undefined)).toBe(20)
  })

  it('rejects both before and after', () => {
    expect(
      parseListAnchors({
        before: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        after: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).toBeNull()
  })

  it('builds self next and prev links for newest-first lists', () => {
    const links = buildHalLinks({
      basePath: '/conversations',
      limit: 20,
      before: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      hasOlder: true,
      hasNewer: true,
      firstId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      lastId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })

    expect(links.self.href).toBe('/conversations?limit=20&before=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(links.next?.href).toBe('/conversations?limit=20&before=dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    expect(links.prev?.href).toBe('/conversations?limit=20&after=cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  })

  it('builds prev and next links for chronological-tail lists', () => {
    const links = buildHalLinks({
      basePath: '/conversations/c1/messages',
      limit: 20,
      hasOlder: true,
      hasNewer: true,
      firstId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      lastId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      linkStyle: 'chronological-tail',
    })

    expect(links.prev?.href).toBe(
      '/conversations/c1/messages?limit=20&before=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )
    expect(links.next?.href).toBe(
      '/conversations/c1/messages?limit=20&after=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
  })

  it('omits next and prev when no further pages exist', () => {
    const links = buildHalLinks({
      basePath: '/conversations',
      limit: 20,
      hasOlder: false,
      hasNewer: false,
      firstId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      lastId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })

    expect(links.next).toBeUndefined()
    expect(links.prev).toBeUndefined()
  })
})