import { describe, it, expect } from 'vitest'
import { listNewMessageIds, type GmailLike } from '../src/main/google/gmail'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

function fake(opts: {
  historyPages?: { history?: unknown[]; nextPageToken?: string }[]
  history404?: boolean
  listPages?: { messages?: { id: string }[]; nextPageToken?: string }[]
  profileHistoryId?: string
}) {
  const calls: { history: Record<string, unknown>[]; list: Record<string, unknown>[] } = { history: [], list: [] }
  let h = 0
  let l = 0
  const g: GmailLike = {
    users: {
      getProfile: async () => ({ data: { historyId: opts.profileHistoryId ?? '999' } }),
      history: {
        list: async (p) => {
          calls.history.push(p as Record<string, unknown>)
          if (opts.history404) throw Object.assign(new Error('Requested entity was not found.'), { status: 404 })
          return { data: opts.historyPages?.[h++] ?? {} }
        }
      },
      messages: {
        list: async (p) => {
          calls.list.push(p as Record<string, unknown>)
          return { data: opts.listPages?.[l++] ?? {} }
        },
        get: async () => ({ data: {} })
      },
      threads: { get: async () => ({ data: {} }) }
    }
  }
  return { g, calls }
}

const added = (id: string, labels = ['INBOX']) => ({ messagesAdded: [{ message: { id, labelIds: labels } }] })

describe('listNewMessageIds', () => {
  it('uses history when cursor present', async () => {
    const { g, calls } = fake({ historyPages: [{ history: [added('a'), added('b')] }], profileHistoryId: '500' })
    const r = await listNewMessageIds(g, { historyId: '100', lastCheckedAt: NOW - 3600_000 }, NOW)
    expect(r).toEqual({ ids: ['a', 'b'], newHistoryId: '500' })
    expect(calls.history[0]).toMatchObject({
      userId: 'me',
      startHistoryId: '100',
      historyTypes: ['messageAdded'],
      labelId: 'INBOX'
    })
    expect(calls.list).toHaveLength(0)
  })

  it('dedupes ids across history pages and skips drafts/sent/spam', async () => {
    const { g } = fake({
      historyPages: [
        { history: [added('a'), added('b')], nextPageToken: 'p2' },
        { history: [added('a'), added('d', ['DRAFT']), added('s', ['SENT', 'INBOX']), added('c')] }
      ]
    })
    const r = await listNewMessageIds(g, { historyId: '1', lastCheckedAt: NOW }, NOW)
    expect(r.ids).toEqual(['a', 'b', 'c'])
  })

  it('404 → falls back to messages.list after lastCheckedAt', async () => {
    const last = NOW - 2 * 3600_000
    const { g, calls } = fake({ history404: true, listPages: [{ messages: [{ id: 'new2' }, { id: 'new1' }] }] })
    const r = await listNewMessageIds(g, { historyId: '1', lastCheckedAt: last }, NOW)
    expect(calls.list[0]).toMatchObject({ userId: 'me', q: `in:inbox after:${Math.floor(last / 1000)}` })
    expect(r.ids).toEqual(['new1', 'new2']) // oldest first
  })

  it('null cursor → last 24h', async () => {
    const { g, calls } = fake({ listPages: [{ messages: [{ id: 'x' }] }] })
    await listNewMessageIds(g, { historyId: null, lastCheckedAt: null }, NOW)
    expect(calls.list[0].q).toBe(`in:inbox after:${Math.floor((NOW - 24 * 3600_000) / 1000)}`)
  })

  it('follows messages.list pageToken', async () => {
    const { g, calls } = fake({
      listPages: [{ messages: [{ id: 'b' }], nextPageToken: 'n' }, { messages: [{ id: 'a' }] }]
    })
    const r = await listNewMessageIds(g, { historyId: null, lastCheckedAt: null }, NOW)
    expect(calls.list[1].pageToken).toBe('n')
    expect(r.ids).toEqual(['a', 'b'])
  })

  it('sinceMs → searches from that time even when a history cursor exists', async () => {
    const since = NOW - 3 * 24 * 3600_000
    const { g, calls } = fake({ listPages: [{ messages: [{ id: 'b' }, { id: 'a' }] }], profileHistoryId: '700' })
    const r = await listNewMessageIds(g, { historyId: '100', lastCheckedAt: NOW }, NOW, since)
    expect(calls.history).toHaveLength(0)
    expect(calls.list[0].q).toBe(`in:inbox after:${Math.floor(since / 1000)}`)
    expect(r).toEqual({ ids: ['a', 'b'], newHistoryId: '700' })
  })

  it('non-404 history errors propagate', async () => {
    const g = fake({}).g
    g.users.history.list = async () => {
      throw Object.assign(new Error('boom'), { status: 500 })
    }
    await expect(listNewMessageIds(g, { historyId: '1', lastCheckedAt: NOW }, NOW)).rejects.toThrow('boom')
  })
})
