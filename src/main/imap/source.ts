import type { gmail_v1 } from '@googleapis/gmail'
import type { GmailLike } from '../google/gmail'

// READ-ONLY IMAP access for non-Gmail mailboxes (e.g. Webglobe).
// Every mailbox is opened with { readOnly: true } (IMAP EXAMINE): the server then cannot change anything,
// not even the "seen" flag. Only connect/list/search/fetch/logout are used (see test/no-write-paths.test.ts).
//
// The adapter speaks the same small GmailLike interface the scanner already uses, so summaries, drafts and the
// "already answered" check work unchanged:
//   message id  = INBOX UID ("123"), or "sent:<uid>" for messages in the Sent folder
//   thread id   = root Message-ID of the conversation (first References entry, else In-Reply-To, else own Message-ID)
//   history id  = "<UIDVALIDITY>:<last seen UID>"
//   labels      = INBOX (+ ANSWERED when the \Answered flag is set) or SENT

/** The subset of imapflow's ImapFlow used here (lets tests fake the server). */
export interface ImapClientLike {
  connect(): Promise<void>
  logout(): Promise<void>
  getMailboxLock(path: string, opts: { readOnly: true }): Promise<{ release(): void }>
  mailbox: { uidValidity: bigint | number; uidNext: number } | false
  search(q: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false | undefined>
  fetchOne(
    uid: string,
    q: { uid: true; flags: true; internalDate: true; source: true },
    opts: { uid: true }
  ): Promise<{ uid: number; flags?: Set<string>; internalDate?: Date | string; source?: Buffer } | false>
  fetch(
    range: string,
    q: { uid: true; internalDate: true },
    opts: { uid: true }
  ): AsyncIterable<{ uid: number; internalDate?: Date | string }>
  list(): Promise<{ path: string; specialUse?: string; name?: string }[]>
}

/** What mailparser's simpleParser returns, reduced to the fields we read. */
export interface ParsedLike {
  from?: { value?: { name?: string; address?: string }[] }
  to?: { text?: string } | { text?: string }[]
  subject?: string
  date?: Date
  messageId?: string
  inReplyTo?: string
  references?: string | string[]
  replyTo?: { text?: string }
  text?: string
  html?: string | false
}

export type ParseFn = (source: Buffer) => Promise<ParsedLike>

const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'odeslané', 'odeslaná pošta', 'odeslane', 'inbox.sent']
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const notFound = (): Error => Object.assign(new Error('Requested entity was not found.'), { status: 404 })

export function threadRoot(p: ParsedLike, fallback: string): string {
  const refs = Array.isArray(p.references) ? p.references : p.references ? p.references.split(/\s+/) : []
  return refs.find((r) => r.trim()) ?? p.inReplyTo ?? p.messageId ?? fallback
}

export function toGmailMessage(
  id: string,
  p: ParsedLike,
  meta: { labels: string[]; internalDate: number }
): gmail_v1.Schema$Message {
  const f = p.from?.value?.[0]
  const from = f ? (f.name ? `${f.name} <${f.address ?? ''}>` : (f.address ?? '')) : ''
  const to = Array.isArray(p.to) ? p.to.map((t) => t.text ?? '').join(', ') : (p.to?.text ?? '')
  const refs = Array.isArray(p.references) ? p.references : p.references ? p.references.split(/\s+/) : []
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: p.subject ?? '' },
    { name: 'Date', value: p.date ? p.date.toUTCString() : '' },
    { name: 'Message-ID', value: p.messageId ?? '' },
    { name: 'In-Reply-To', value: p.inReplyTo ?? '' },
    { name: 'References', value: refs.join(' ') },
    { name: 'Reply-To', value: p.replyTo?.text ?? '' }
  ]
  const parts: gmail_v1.Schema$MessagePart[] = []
  if (p.text) parts.push({ mimeType: 'text/plain', body: { data: b64(p.text) } })
  if (p.html) parts.push({ mimeType: 'text/html', body: { data: b64(p.html) } })
  return {
    id,
    threadId: threadRoot(p, `uid:${id}`),
    internalDate: String(meta.internalDate),
    labelIds: meta.labels,
    payload: { mimeType: 'multipart/alternative', headers, parts }
  }
}

const ms = (d: Date | string | undefined): number => (d ? new Date(d).getTime() : 0)

/**
 * Wraps one IMAP connection as GmailLike. Connects lazily, serialises all commands, and logs out after
 * `idleMs` without use (each check gets a fresh adapter).
 */
export function imapAsGmail(
  makeClient: () => ImapClientLike,
  parse: ParseFn,
  opts: { idleMs?: number; onAuthFailed?: (e: unknown) => Error } = {}
): GmailLike & { close(): Promise<void> } {
  let client: ImapClientLike | null = null
  let connecting: Promise<ImapClientLike> | null = null
  let sentPath: string | null | undefined
  let idle: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<unknown> = Promise.resolve()

  async function close(): Promise<void> {
    if (idle) clearTimeout(idle)
    idle = null
    const c = client
    client = null
    connecting = null
    sentPath = undefined
    if (c) await c.logout().catch(() => undefined)
  }

  async function conn(): Promise<ImapClientLike> {
    if (client) return client
    if (!connecting) {
      connecting = (async () => {
        const c = makeClient()
        try {
          await c.connect()
        } catch (e) {
          connecting = null
          if ((e as { authenticationFailed?: boolean })?.authenticationFailed && opts.onAuthFailed) throw opts.onAuthFailed(e)
          throw e
        }
        client = c
        return c
      })()
    }
    return connecting
  }

  /** Runs fn with `path` opened read-only; one command sequence at a time. */
  function withBox<T>(path: string, fn: (c: ImapClientLike) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (idle) clearTimeout(idle)
      const c = await conn()
      const lock = await c.getMailboxLock(path, { readOnly: true })
      try {
        return await fn(c)
      } finally {
        lock.release()
        idle = setTimeout(() => void close(), opts.idleMs ?? 20_000)
      }
    }
    const p = queue.then(run, run)
    queue = p.catch(() => undefined)
    return p
  }

  async function findSent(): Promise<string | null> {
    if (sentPath !== undefined) return sentPath
    const c = await conn()
    const boxes = await c.list()
    const hit =
      boxes.find((b) => b.specialUse === '\\Sent') ??
      boxes.find((b) => SENT_NAMES.includes((b.name ?? b.path).toLowerCase()) || SENT_NAMES.includes(b.path.toLowerCase()))
    sentPath = hit?.path ?? null
    return sentPath
  }

  const uidValidity = (c: ImapClientLike): string => (c.mailbox ? String(c.mailbox.uidValidity) : '0')

  async function readOne(c: ImapClientLike, uid: number, sent: boolean): Promise<gmail_v1.Schema$Message | null> {
    const m = await c.fetchOne(String(uid), { uid: true, flags: true, internalDate: true, source: true }, { uid: true })
    if (!m || !m.source) return null
    const p = await parse(m.source)
    const labels = sent ? ['SENT'] : ['INBOX', ...(m.flags?.has('\\Answered') ? ['ANSWERED'] : [])]
    return toGmailMessage(sent ? `sent:${uid}` : String(uid), p, { labels, internalDate: ms(m.internalDate) || p.date?.getTime() || 0 })
  }

  async function threadIn(c: ImapClientLike, root: string, sent: boolean): Promise<gmail_v1.Schema$Message[]> {
    const uids =
      (await c.search(
        { or: [{ header: { 'message-id': root } }, { header: { references: root } }, { header: { 'in-reply-to': root } }] },
        { uid: true }
      )) || []
    const out: gmail_v1.Schema$Message[] = []
    for (const uid of uids.slice(-50)) {
      const m = await readOne(c, uid, sent)
      if (m) out.push(m)
    }
    return out
  }

  const g: GmailLike & { close(): Promise<void> } = {
    close,
    users: {
      getProfile: () =>
        withBox('INBOX', async (c) => ({
          data: { historyId: `${uidValidity(c)}:${c.mailbox ? c.mailbox.uidNext - 1 : 0}` }
        })),
      history: {
        list: (p) =>
          withBox('INBOX', async (c) => {
            const [validity, last] = String(p.startHistoryId ?? '').split(':')
            if (validity !== uidValidity(c) || !/^\d+$/.test(last ?? '')) throw notFound()
            const from = Number(last) + 1
            const uids = ((await c.search({ uid: `${from}:*` }, { uid: true })) || []).filter((u) => u >= from)
            return {
              data: { history: uids.map((u) => ({ messagesAdded: [{ message: { id: String(u), labelIds: ['INBOX'] } }] })) }
            }
          })
      },
      messages: {
        list: (p) =>
          withBox('INBOX', async (c) => {
            const after = Number(/after:(\d+)/.exec(String(p.q ?? ''))?.[1] ?? 0) * 1000
            const since = new Date(after)
            since.setHours(0, 0, 0, 0) // IMAP SINCE has day granularity; filter exactly below
            const uids = (await c.search({ since }, { uid: true })) || []
            const hits: { uid: number; at: number }[] = []
            if (uids.length) {
              for await (const m of c.fetch(uids.join(','), { uid: true, internalDate: true }, { uid: true })) {
                const at = ms(m.internalDate)
                if (at >= after) hits.push({ uid: m.uid, at })
              }
            }
            hits.sort((a, b) => b.at - a.at) // newest first, like Gmail
            return { data: { messages: hits.map((h) => ({ id: String(h.uid) })) } }
          }),
        get: async (p) => {
          const id = String(p.id)
          const sent = id.startsWith('sent:')
          const uid = Number(sent ? id.slice(5) : id)
          if (!Number.isInteger(uid) || uid <= 0) throw notFound()
          const path = sent ? await withBox('INBOX', () => findSent()) : 'INBOX'
          if (!path) throw notFound()
          const m = await withBox(path, (c) => readOne(c, uid, sent))
          if (!m) throw notFound()
          return { data: m }
        }
      },
      threads: {
        get: async (p) => {
          const root = String(p.id)
          if (root.startsWith('uid:')) {
            const m = await g.users.messages.get({ id: root.slice(4) })
            return { data: { id: root, messages: [m.data] } }
          }
          const inbox = await withBox('INBOX', (c) => threadIn(c, root, false))
          const sentBox = await withBox('INBOX', () => findSent())
          const sent = sentBox ? await withBox(sentBox, (c) => threadIn(c, root, true)) : []
          const messages = [...inbox, ...sent].sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
          return { data: { id: root, messages } }
        }
      }
    }
  }
  return g
}
