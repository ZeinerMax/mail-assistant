import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { imapAsGmail, threadRoot, type ImapClientLike, type ParsedLike } from '../src/main/imap/source'
import { createImapAccounts, validateImapInput, ImapSetupError, imapKey } from '../src/main/imap/accounts'
import { listNewMessageIds } from '../src/main/google/gmail'
import { cleanBody, extractHeaders } from '../src/main/google/clean'
import { ReloginRequired } from '../src/main/google/accounts'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'
import type { SecretStore } from '../src/main/secrets'

interface FakeMsg {
  uid: number
  at: number
  flags?: string[]
  parsed: ParsedLike
}

/** In-memory IMAP server: folder → messages. "Parsing" returns the stored ParsedLike for a uid. */
function fakeServer(folders: Record<string, FakeMsg[]>, opts: { uidValidity?: number; failAuth?: boolean } = {}) {
  const log: { locks: { path: string; readOnly: unknown }[]; connects: number; logouts: number } = {
    locks: [],
    connects: 0,
    logouts: 0
  }
  let current = 'INBOX'
  const box = (): FakeMsg[] => folders[current] ?? []
  const make = (): ImapClientLike => {
    const c: ImapClientLike = {
      async connect() {
        log.connects++
        if (opts.failAuth) throw Object.assign(new Error('auth'), { authenticationFailed: true })
      },
      async logout() {
        log.logouts++
      },
      async getMailboxLock(path, o) {
        log.locks.push({ path, readOnly: o?.readOnly })
        current = path
        return { release: () => undefined }
      },
      get mailbox() {
        const max = Math.max(0, ...box().map((m) => m.uid))
        return { uidValidity: BigInt(opts.uidValidity ?? 7), uidNext: max + 1 }
      },
      async search(q) {
        if (typeof q.uid === 'string') {
          const from = Number(q.uid.split(':')[0])
          const all = box().map((m) => m.uid)
          const hits = all.filter((u) => u >= from)
          return hits.length ? hits : all.slice(-1) // IMAP "N:*" returns the last message even if N > max
        }
        if (q.since instanceof Date) return box().filter((m) => m.at >= (q.since as Date).getTime()).map((m) => m.uid)
        if (Array.isArray(q.or)) {
          const root = String(Object.values((q.or[0] as { header: Record<string, string> }).header)[0])
          return box()
            .filter((m) => {
              const refs = [m.parsed.messageId, m.parsed.inReplyTo, ...(Array.isArray(m.parsed.references) ? m.parsed.references : [m.parsed.references])]
              return refs.includes(root)
            })
            .map((m) => m.uid)
        }
        return []
      },
      async fetchOne(uid) {
        const m = box().find((x) => x.uid === Number(uid))
        return m ? { uid: m.uid, flags: new Set(m.flags ?? []), internalDate: new Date(m.at), source: Buffer.from(`${current}:${m.uid}`) } : false
      },
      async *fetch(range) {
        for (const u of range.split(',').map(Number)) {
          const m = box().find((x) => x.uid === u)
          if (m) yield { uid: m.uid, internalDate: new Date(m.at) }
        }
      },
      async list() {
        return [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }]
      }
    }
    return c
  }
  const parse = async (src: Buffer): Promise<ParsedLike> => {
    const [path, uid] = src.toString().split(':')
    return folders[path].find((m) => m.uid === Number(uid))!.parsed
  }
  return { make, parse, log }
}

const T0 = Date.UTC(2026, 10, 20, 8, 0, 0)
const msg = (uid: number, minutes: number, p: Partial<ParsedLike> = {}, flags?: string[]): FakeMsg => ({
  uid,
  at: T0 + minutes * 60_000,
  flags,
  parsed: {
    from: { value: [{ name: `Sender ${uid}`, address: `s${uid}@example.cz` }] },
    to: { text: 'me@firma.cz' },
    subject: `Subject ${uid}`,
    date: new Date(T0 + minutes * 60_000),
    messageId: `<m${uid}@example.cz>`,
    text: `Body of ${uid}`,
    ...p
  }
})

describe('IMAP adapter (read-only, GmailLike)', () => {
  it('opens every mailbox read-only', async () => {
    const s = fakeServer({ INBOX: [msg(1, 0)], Sent: [] })
    const g = imapAsGmail(s.make, s.parse, { idleMs: 5 })
    await g.users.getProfile({})
    await g.users.messages.get({ id: '1' })
    await g.users.threads.get({ id: '<m1@example.cz>' })
    expect(s.log.locks.length).toBeGreaterThan(0)
    expect(s.log.locks.every((l) => l.readOnly === true)).toBe(true)
    await g.close()
  })

  it('cursor = uidvalidity:last uid; history lists only newer uids', async () => {
    const s = fakeServer({ INBOX: [msg(5, 0), msg(6, 1), msg(9, 2)] })
    const g = imapAsGmail(s.make, s.parse)
    expect((await g.users.getProfile({})).data.historyId).toBe('7:9')
    const r = await listNewMessageIds(g, { historyId: '7:5', lastCheckedAt: T0 }, T0 + 3600_000)
    expect(r).toEqual({ ids: ['6', '9'], newHistoryId: '7:9' })
    const none = await listNewMessageIds(g, { historyId: '7:9', lastCheckedAt: T0 }, T0 + 3600_000)
    expect(none.ids).toEqual([]) // "10:*" returns uid 9 on a real server; it must be filtered out
    await g.close()
  })

  it('changed UIDVALIDITY falls back to a time search', async () => {
    const s = fakeServer({ INBOX: [msg(1, -120), msg(2, 30)] }, { uidValidity: 8 })
    const g = imapAsGmail(s.make, s.parse)
    const r = await listNewMessageIds(g, { historyId: '7:1', lastCheckedAt: T0 }, T0 + 3600_000)
    expect(r.ids).toEqual(['2'])
    expect(r.newHistoryId).toBe('8:2')
    await g.close()
  })

  it('"since" lists exactly the mail at or after that time, oldest first', async () => {
    const s = fakeServer({ INBOX: [msg(1, -10), msg(2, 0), msg(3, 45)] })
    const g = imapAsGmail(s.make, s.parse)
    const r = await listNewMessageIds(g, { historyId: '7:3', lastCheckedAt: T0 }, T0 + 3600_000, T0)
    expect(r.ids).toEqual(['2', '3'])
    await g.close()
  })

  it('a fetched message looks like a Gmail message (headers, body, labels)', async () => {
    const s = fakeServer({ INBOX: [msg(4, 0, { html: '<p>Hi <b>there</b></p>', text: undefined }, ['\\Seen', '\\Answered'])] })
    const g = imapAsGmail(s.make, s.parse)
    const m = (await g.users.messages.get({ id: '4' })).data
    expect(extractHeaders(m)).toMatchObject({ fromName: 'Sender 4', fromEmail: 's4@example.cz', subject: 'Subject 4', receivedAt: T0 })
    expect(cleanBody(m, 1000)).toBe('Hi there')
    expect(m.labelIds).toEqual(['INBOX', 'ANSWERED'])
    expect(m.threadId).toBe('<m4@example.cz>')
    await g.close()
  })

  it('conversation = inbox + sent messages of the same root, oldest first', async () => {
    const s = fakeServer({
      INBOX: [
        msg(1, 0, { messageId: '<root@x>' }),
        msg(2, 20, { messageId: '<c@x>', inReplyTo: '<r1@me>', references: ['<root@x>', '<r1@me>'] }),
        msg(3, 5, { messageId: '<other@x>' })
      ],
      Sent: [msg(11, 10, { messageId: '<r1@me>', inReplyTo: '<root@x>', references: '<root@x>' })]
    })
    const g = imapAsGmail(s.make, s.parse)
    const t = (await g.users.threads.get({ id: '<root@x>' })).data
    expect(t.messages!.map((m) => m.id)).toEqual(['1', 'sent:11', '2'])
    expect(t.messages![1].labelIds).toEqual(['SENT'])
    await g.close()
  })

  it('thread root prefers the first References entry', () => {
    expect(threadRoot({ references: ['<a>', '<b>'], inReplyTo: '<b>', messageId: '<c>' }, 'x')).toBe('<a>')
    expect(threadRoot({ inReplyTo: '<b>', messageId: '<c>' }, 'x')).toBe('<b>')
    expect(threadRoot({}, 'x')).toBe('x')
  })

  it('wrong password → onAuthFailed error', async () => {
    const s = fakeServer({ INBOX: [] }, { failAuth: true })
    const g = imapAsGmail(s.make, s.parse, { onAuthFailed: () => new ReloginRequired(3) })
    await expect(g.users.getProfile({})).rejects.toBeInstanceOf(ReloginRequired)
  })

  it('logs out after being idle', async () => {
    const s = fakeServer({ INBOX: [msg(1, 0)] })
    const g = imapAsGmail(s.make, s.parse, { idleMs: 5 })
    await g.users.getProfile({})
    await new Promise((r) => setTimeout(r, 30))
    expect(s.log.logouts).toBe(1)
  })
})

function memSecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), delete: (k) => void map.delete(k) }
}

describe('IMAP accounts', () => {
  const form = { email: 'zdenek@firma.cz', host: 'Mail.Webglobe.cz', port: 993, user: 'zdenek@firma.cz', password: 'pw' }
  const setup = (failAuth = false) => {
    const repo = new Repo(openDb(join(mkdtempSync(join(tmpdir(), 'ma-imap-')), 'db.sqlite')))
    const secrets = memSecrets()
    const s = fakeServer({ INBOX: [] }, { failAuth })
    const svc = createImapAccounts({ repo, secrets, makeClient: () => s.make(), parse: s.parse })
    return { repo, secrets, svc }
  }

  it('validates the form', () => {
    expect(validateImapInput(form)).toMatchObject({ host: 'mail.webglobe.cz', port: 993 })
    expect(() => validateImapInput({ ...form, host: 'nope' })).toThrow(ImapSetupError)
    expect(() => validateImapInput({ ...form, password: '' })).toThrow('password')
  })

  it('adds an IMAP account after a successful login; password only in secure storage', async () => {
    const { repo, secrets, svc } = setup()
    const a = await svc.addAccount(form)
    expect(a).toMatchObject({ kind: 'imap', email: 'zdenek@firma.cz', imap: { host: 'mail.webglobe.cz', port: 993, user: 'zdenek@firma.cz' } })
    expect(secrets.map.get(imapKey(a.id))).toBe('pw')
    expect(JSON.stringify(repo.listAccounts())).not.toContain('"pw"')
  })

  it('a rejected login adds nothing and says why', async () => {
    const { repo, svc } = setup(true)
    await expect(svc.addAccount(form)).rejects.toThrow('rejected the user name or password')
    expect(repo.listAccounts()).toHaveLength(0)
  })

  it('setSmtp stores valid settings and rejects bad ones', async () => {
    const { repo, svc } = setup()
    const a = await svc.addAccount(form)
    expect(svc.setSmtp(a.id, { host: 'smtp.x.cz', port: 587 }).smtp).toEqual({ host: 'smtp.x.cz', port: 587 })
    expect(svc.setSmtp(a.id, { host: ' SMTP.X.CZ ', port: 465 }).smtp).toEqual({ host: 'smtp.x.cz', port: 465 })
    expect(() => svc.setSmtp(a.id, { host: 'bad', port: 0 })).toThrow(ImapSetupError)
    expect(() => svc.setSmtp(a.id, { host: 'smtp.x.cz', port: 0 })).toThrow('outgoing port')
    expect(() => svc.setSmtp(999, { host: 'smtp.x.cz', port: 587 })).toThrow('Account not found.')
    const g = repo.addAccount({ email: 'g@x.com', label: 'G', color: '#000', lastHistoryId: null })
    expect(() => svc.setSmtp(g.id, { host: 'smtp.x.cz', port: 587 })).toThrow('Account not found.')
  })

  it('missing password → needs sign-in', async () => {
    const { repo, secrets, svc } = setup()
    const a = await svc.addAccount(form)
    secrets.delete(imapKey(a.id))
    expect(() => svc.open(a.id)).toThrow(ReloginRequired)
    expect(repo.getAccount(a.id)!.status).toBe('needs_relogin')
  })
})

describe('toGmailMessage reply headers', () => {
  it('exposes References, In-Reply-To and Reply-To', async () => {
    const { toGmailMessage } = await import('../src/main/imap/source')
    const m = toGmailMessage('1', { references: ['<a@x>', '<b@x>'], inReplyTo: '<b@x>', replyTo: { text: 'r@x.cz' } }, { labels: [], internalDate: 1 })
    const h = Object.fromEntries((m.payload?.headers ?? []).map((x) => [x.name, x.value]))
    expect(h['References']).toBe('<a@x> <b@x>')
    expect(h['In-Reply-To']).toBe('<b@x>')
    expect(h['Reply-To']).toBe('r@x.cz')
  })
})

describe('parseMail (real mailparser)', () => {
  it('reads headers, Czech text and references from a raw message', async () => {
    const { parseMail } = await import('../src/main/imap/client')
    const { toGmailMessage } = await import('../src/main/imap/source')
    const raw = [
      'From: =?UTF-8?Q?Jana_Nov=C3=A1kov=C3=A1?= <jana@firma.cz>',
      'To: zdenek@firma.cz',
      'Subject: =?UTF-8?Q?Sch=C5=AFzka_v_p=C3=A1tek?=',
      'Date: Thu, 19 Nov 2026 10:00:00 +0100',
      'Message-ID: <abc@firma.cz>',
      'In-Reply-To: <root@firma.cz>',
      'References: <root@firma.cz> <mid@firma.cz>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      'Dobrý den, můžeme se sejít v pátek?',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Dobrý den, můžeme se sejít v <b>pátek</b>?</p>',
      '--b1--',
      ''
    ].join('\r\n')
    const p = await parseMail(Buffer.from(raw, 'utf8'))
    const m = toGmailMessage('42', p, { labels: ['INBOX'], internalDate: 1 })
    expect(extractHeaders(m)).toMatchObject({ fromName: 'Jana Nováková', fromEmail: 'jana@firma.cz', subject: 'Schůzka v pátek' })
    expect(cleanBody(m, 1000)).toBe('Dobrý den, můžeme se sejít v pátek?')
    expect(m.threadId).toBe('<root@firma.cz>')
  }, 30_000) // first load of mailparser is slow when all test files run in parallel
})
