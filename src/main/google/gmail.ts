import type { gmail_v1 } from '@googleapis/gmail'

// READ-ONLY Gmail access. Only list/get methods are used (see test/no-write-paths.test.ts).
// Params verified against @googleapis/gmail 22 v1.d.ts:
//   users.history.list { userId, startHistoryId, historyTypes, labelId, pageToken }
//   users.messages.list { userId, q, maxResults, pageToken }
//   users.messages.get / users.threads.get { userId, id, format }
//   users.getProfile { userId } → { emailAddress, historyId }

type Resp<T> = Promise<{ data: T }>
type P = Record<string, unknown>

/** Minimal structural subset of gmail_v1.Gmail so tests can fake it. */
export interface GmailLike {
  users: {
    getProfile(p: P): Resp<{ historyId?: string | null }>
    history: { list(p: P): Resp<{ history?: unknown[] | null; nextPageToken?: string | null }> }
    messages: {
      list(p: P): Resp<{ messages?: { id?: string | null }[] | null; nextPageToken?: string | null }>
      get(p: P): Resp<gmail_v1.Schema$Message>
    }
    threads: { get(p: P): Resp<gmail_v1.Schema$Thread> }
  }
}

const DAY = 24 * 3600_000
const SKIP_LABELS = new Set(['DRAFT', 'SENT', 'SPAM', 'TRASH', 'CHAT'])
const MAX_PAGES = 10

const statusOf = (e: unknown): number | undefined => {
  const err = e as { status?: unknown; code?: unknown; response?: { status?: unknown } }
  const s = err?.status ?? err?.response?.status ?? err?.code
  return typeof s === 'number' ? s : typeof s === 'string' && /^\d+$/.test(s) ? Number(s) : undefined
}

async function viaHistory(g: GmailLike, startHistoryId: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await g.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      ...(pageToken ? { pageToken } : {})
    })
    for (const h of (data.history ?? []) as gmail_v1.Schema$History[]) {
      for (const a of h.messagesAdded ?? []) {
        const m = a.message
        if (m?.id && !(m.labelIds ?? []).some((l) => SKIP_LABELS.has(l))) ids.push(m.id)
      }
    }
    pageToken = data.nextPageToken ?? undefined
    if (!pageToken) break
  }
  return ids
}

async function viaSearch(g: GmailLike, afterMs: number): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await g.users.messages.list({
      userId: 'me',
      q: `in:inbox after:${Math.floor(afterMs / 1000)}`,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {})
    })
    for (const m of data.messages ?? []) if (m.id) ids.push(m.id)
    pageToken = data.nextPageToken ?? undefined
    if (!pageToken) break
  }
  return ids.reverse() // messages.list is newest-first; we process oldest-first
}

/**
 * New inbox message ids since the cursor, oldest first, de-duplicated.
 * history.list is cheap and exact; if the cursor is too old Gmail answers 404 and we fall back to search.
 * First run (no cursor) covers the last 24 hours.
 */
export async function listNewMessageIds(
  g: GmailLike,
  cursor: { historyId: string | null; lastCheckedAt: number | null },
  now: number
): Promise<{ ids: string[]; newHistoryId: string }> {
  const profile = await g.users.getProfile({ userId: 'me' })
  let ids: string[]
  if (cursor.historyId) {
    try {
      ids = await viaHistory(g, cursor.historyId)
    } catch (e) {
      if (statusOf(e) !== 404) throw e
      ids = await viaSearch(g, cursor.lastCheckedAt ?? now - DAY)
    }
  } else {
    ids = await viaSearch(g, cursor.lastCheckedAt ?? now - DAY)
  }
  return { ids: [...new Set(ids)], newHistoryId: profile.data.historyId ?? cursor.historyId ?? '' }
}

export async function getMessage(g: GmailLike, id: string): Promise<gmail_v1.Schema$Message> {
  return (await g.users.messages.get({ userId: 'me', id, format: 'full' })).data
}

export async function getThread(g: GmailLike, threadId: string): Promise<gmail_v1.Schema$Thread> {
  return (await g.users.threads.get({ userId: 'me', id: threadId, format: 'full' })).data
}
