import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { gmail_v1 } from '@googleapis/gmail'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'
import { DEFAULT_SETTINGS } from '../src/main/config'
import { createScanner, type ScanDeps, type AiPort } from '../src/main/jobs/scan'
import type { GmailLike } from '../src/main/google/gmail'
import { ReloginRequired } from '../src/main/google/accounts'
import { TriageFailed } from '../src/main/ai/triage'
import type { Settings, StatusEvent } from '@shared/types'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const BODY = (id: string): string => `Secret body text of ${id}`

function message(id: string, labels: string[] = ['INBOX']): gmail_v1.Schema$Message {
  return {
    id,
    threadId: 't-' + id,
    internalDate: String(1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0)),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Sender ${id} <s${id}@example.com>` },
        { name: 'Subject', value: `Subject ${id}` }
      ],
      body: { data: b64(BODY(id)) }
    }
  }
}

function fakeGmail(ids: string[], opts: { labels?: Record<string, string[]>; failGet?: (id: string) => Error | null } = {}) {
  const g: GmailLike = {
    users: {
      getProfile: async () => ({ data: { historyId: 'H2' } }),
      history: {
        list: async () => ({ data: { history: ids.map((id) => ({ messagesAdded: [{ message: { id, labelIds: ['INBOX'] } }] })) } })
      },
      messages: {
        list: async () => ({ data: { messages: [] } }),
        get: async (p) => {
          const id = p.id as string
          const err = opts.failGet?.(id)
          if (err) throw err
          return { data: message(id, opts.labels?.[id]) }
        }
      },
      threads: { get: async (p) => ({ data: { id: p.id as string, messages: [message((p.id as string).slice(2))] } }) }
    }
  }
  return g
}

let repo: Repo
let statuses: StatusEvent[]
let triageCalls: { body: string }[]

const okTriage = (tag: 'needs_reply' | 'info' = 'info'): AiPort['triage'] => async (input) => {
  triageCalls.push({ body: input.body })
  return { summary: `Summary of ${input.subject}`, tag, usage: { input_tokens: 100, output_tokens: 20 } }
}

function deps(
  over: Omit<Partial<ScanDeps>, 'settings'> & { gmails?: Record<number, GmailLike>; settings?: Partial<Settings> } = {}
): ScanDeps {
  const { gmails, settings, ...rest } = over
  return {
    repo,
    getGmail: async (id) => {
      const g = gmails?.[id]
      if (!g) throw new ReloginRequired(id)
      return g
    },
    ai: { triage: okTriage() },
    emit: (s) => statuses.push(s),
    now: () => 1_800_000_000_000,
    ...rest,
    settings: { ...DEFAULT_SETTINGS, ...settings }
  }
}

function addAccount(email = 'a@gmail.com') {
  return repo.addAccount({ email, label: email.split('@')[0], color: '#000', lastHistoryId: 'H1' })
}

const ids = (n: number, prefix = 'm'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

beforeEach(() => {
  repo = new Repo(openDb(join(mkdtempSync(join(tmpdir(), 'ma-scan-')), 'db.sqlite')))
  statuses = []
  triageCalls = []
})

describe('runScan', () => {
  it('triages new mail, stores summary + headers, advances cursor', async () => {
    const a = addAccount()
    const r = await createScanner(deps({ gmails: { [a.id]: fakeGmail(['m1', 'm2']) } })).run()
    expect(r).toMatchObject({ status: 'done', stopReason: 'done', triaged: 2 })
    const rows = repo.listEmails({ limit: 10 })
    expect(rows.map((e) => e.subject).sort()).toEqual(['Subject m1', 'Subject m2'])
    expect(rows[0]).toMatchObject({ state: 'triaged', tag: 'info', fromEmail: expect.stringContaining('@example.com') })
    expect(repo.getAccount(a.id)!.lastHistoryId).toBe('H2')
    expect(repo.usageSummary()[0]).toMatchObject({ model: 'claude-haiku-5-5', inputTokens: 200, outputTokens: 40 })
    expect(statuses.some((s) => s.phase === 'summarizing' && s.total === 2)).toBe(true)
  })

  it('stops at maxEmailsPerRun with stopReason cap_emails and cursor not advanced', async () => {
    const a = addAccount()
    const r = await createScanner(deps({ gmails: { [a.id]: fakeGmail(ids(60)) }, settings: { maxEmailsPerRun: 50 } })).run()
    expect(r.stopReason).toBe('cap_emails')
    expect(r.triaged).toBe(50)
    expect(triageCalls).toHaveLength(50)
    expect(repo.getAccount(a.id)!.lastHistoryId).toBe('H1')
  })

  it('run({ sinceMs }) lists by search from that time and skips mail already known', async () => {
    const a = addAccount()
    const g = fakeGmail([])
    const queries: unknown[] = []
    g.users.messages.list = async (p) => {
      queries.push(p.q)
      return { data: { messages: [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }] } }
    }
    const s = createScanner(deps({ gmails: { [a.id]: g } }))
    await s.run({ sinceMs: 1_799_000_000_000 })
    expect(queries[0]).toBe('in:inbox after:1799000000')
    expect(triageCalls).toHaveLength(3)
    const again = await s.run({ sinceMs: 1_799_000_000_000 })
    expect(again.triaged).toBe(0)
    expect(triageCalls).toHaveLength(3)
  })

  it('stops when token budget exhausted', async () => {
    const a = addAccount()
    const r = await createScanner(deps({ gmails: { [a.id]: fakeGmail(ids(10)) }, settings: { maxTokensPerRun: 250 } })).run()
    expect(r.stopReason).toBe('cap_tokens')
    expect(triageCalls).toHaveLength(3) // 120 tokens each: 120, 240, 360 ≥ 250 after the 3rd
  })

  it('second concurrent call returns already_running', async () => {
    const a = addAccount()
    const scanner = createScanner(deps({ gmails: { [a.id]: fakeGmail(['m1']) } }))
    const [r1, r2] = await Promise.all([scanner.run(), scanner.run()])
    expect([r1.status, r2.status].sort()).toEqual(['already_running', 'done'])
  })

  it('duplicate id is triaged once (same run and next run)', async () => {
    const a = addAccount()
    const scanner = createScanner(deps({ gmails: { [a.id]: fakeGmail(['m1', 'm1', 'm2']) } }))
    await scanner.run()
    await scanner.run()
    expect(triageCalls).toHaveLength(2)
    expect(repo.listEmails({ limit: 10 })).toHaveLength(2)
  })

  it('promotions prefiltered without API call', async () => {
    const a = addAccount()
    const g = fakeGmail(['m1', 'm2'], { labels: { m1: ['INBOX', 'CATEGORY_PROMOTIONS'] } })
    await createScanner(deps({ gmails: { [a.id]: g } })).run()
    expect(triageCalls).toHaveLength(1)
    const promo = repo.listEmails({ tag: 'newsletter_junk', limit: 10 })
    expect(promo).toHaveLength(1)
    expect(promo[0].summary).toContain('Sender m1')
  })

  it('prefilter off → promotions go to the model', async () => {
    const a = addAccount()
    const g = fakeGmail(['m1'], { labels: { m1: ['INBOX', 'CATEGORY_SOCIAL'] } })
    await createScanner(deps({ gmails: { [a.id]: g }, settings: { prefilterPromotions: false } })).run()
    expect(triageCalls).toHaveLength(1)
  })

  it('401 stops whole run, no emails marked failed', async () => {
    const a = addAccount('a@gmail.com')
    const b = addAccount('b@gmail.com')
    const ai: AiPort = {
      triage: async () => {
        throw new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
      }
    }
    const r = await createScanner(deps({ ai, gmails: { [a.id]: fakeGmail(['m1']), [b.id]: fakeGmail(['m9']) } })).run()
    expect(r.stopReason).toBe('api_key_invalid')
    expect(repo.listEmails({ limit: 10 }).every((e) => e.attempts === 0)).toBe(true)
    expect(statuses.at(-1)).toMatchObject({ phase: 'error', message: 'Check your API key in Settings' })
  })

  it('network error → offline, attempts unchanged, other accounts continue', async () => {
    const a = addAccount('a@gmail.com')
    const b = addAccount('b@gmail.com')
    const net = Object.assign(new Error('getaddrinfo ENOTFOUND gmail.googleapis.com'), { code: 'ENOTFOUND' })
    const gA = fakeGmail(['m1'], { failGet: () => net })
    const r = await createScanner(deps({ gmails: { [a.id]: gA, [b.id]: fakeGmail(['m2']) } })).run()
    expect(r.offline).toBe(true)
    expect(r.triaged).toBe(1)
    expect(repo.listEmails({ accountId: a.id, limit: 10 }).every((e) => e.attempts === 0)).toBe(true)
    expect(repo.getAccount(a.id)!.lastHistoryId).toBe('H1')
  })

  it('anthropic connection error → offline, attempts unchanged', async () => {
    const a = addAccount()
    const ai: AiPort = {
      triage: async () => {
        throw new Anthropic.APIConnectionError({ message: 'Connection error.' })
      }
    }
    const r = await createScanner(deps({ ai, gmails: { [a.id]: fakeGmail(['m1']) } })).run()
    expect(r.offline).toBe(true)
    expect(repo.listEmails({ limit: 10 }).every((e) => e.attempts === 0)).toBe(true)
  })

  it('email failing twice ends in state failed and is not retried a 3rd time', async () => {
    const a = addAccount()
    let calls = 0
    const ai: AiPort = {
      triage: async () => {
        calls++
        throw new TriageFailed('bad_output', { input_tokens: 10, output_tokens: 1 })
      }
    }
    const scanner = createScanner(deps({ ai, gmails: { [a.id]: fakeGmail(['m1']) } }))
    await scanner.run()
    await scanner.run()
    await scanner.run()
    expect(calls).toBe(2)
    expect(repo.listEmails({ limit: 10 })[0]).toMatchObject({ state: 'failed', attempts: 2 })
    expect(repo.usageSummary()[0].inputTokens).toBe(20) // failed calls still cost money and are counted
  })

  it('needs_relogin account skipped, others processed', async () => {
    const a = addAccount('a@gmail.com')
    const b = addAccount('b@gmail.com')
    const r = await createScanner(deps({ gmails: { [b.id]: fakeGmail(['m2']) } })).run()
    expect(r.triaged).toBe(1)
    expect(r.reloginAccounts).toEqual([a.label])
  })

  it('no API key → no_api_key; no accounts → no_accounts', async () => {
    expect((await createScanner(deps({ ai: null })).run()).status).toBe('no_api_key')
    expect((await createScanner(deps()).run()).status).toBe('no_accounts')
  })

  describe('drafts', () => {
    const drafter = (calls: string[]): NonNullable<AiPort['draft']> => async ({ targetMessageId }) => {
      calls.push(targetMessageId)
      return { body: `Draft for ${targetMessageId}`, usage: { input_tokens: 500, output_tokens: 100 } }
    }

    it('drafts every needs_reply email, records sonnet usage, notifies once', async () => {
      const a = addAccount()
      const calls: string[] = []
      const notified: number[] = []
      const r = await createScanner(
        deps({
          ai: { triage: okTriage('needs_reply'), draft: drafter(calls) },
          gmails: { [a.id]: fakeGmail(['m1', 'm2']) },
          onDraftsReady: (n) => notified.push(n)
        })
      ).run()
      expect(r.drafted).toBe(2)
      expect(calls.sort()).toEqual(['m1', 'm2'])
      expect(repo.listDrafts().map((d) => d.body).sort()).toEqual(['Draft for m1', 'Draft for m2'])
      expect(notified).toEqual([2])
      expect(repo.usageSummary().find((u) => u.model === 'claude-sonnet-5-5')).toMatchObject({ inputTokens: 1000 })
      expect(statuses.some((s) => s.phase === 'drafting')).toBe(true)
    })

    it('already answered → no draft, email marked answered with its conversation size', async () => {
      const a = addAccount()
      const calls: string[] = []
      const g = fakeGmail(['m1', 'm2'])
      // m1's conversation contains a later reply sent by the owner; m2 stands alone.
      g.users.threads.get = async (p) => {
        const id = (p.id as string).slice(2)
        const own = { ...message('r' + id), labelIds: ['SENT'], internalDate: String(1_900_000_000_000) }
        return { data: { id: p.id as string, messages: id === 'm1' ? [message(id), own] : [message(id)] } }
      }
      const r = await createScanner(
        deps({ ai: { triage: okTriage('needs_reply'), draft: drafter(calls) }, gmails: { [a.id]: g } })
      ).run()
      expect(calls).toEqual(['m2'])
      expect(r.drafted).toBe(1)
      const m1 = repo.findEmail(a.id, 'm1')!
      expect(m1).toMatchObject({ answered: true, threadSize: 2, tag: 'needs_reply' })
      expect(repo.hasDraft(m1.id)).toBe(false)
      expect(repo.findEmail(a.id, 'm2')).toMatchObject({ answered: false, threadSize: 1 })
    })

    it('older open needs_reply mail is re-checked each run; once answered its draft is hidden', async () => {
      const a = addAccount()
      const calls: string[] = []
      let replied = false
      const g = fakeGmail(['m1'])
      g.users.threads.get = async (p) => {
        const id = (p.id as string).slice(2)
        const own = { ...message('r' + id), labelIds: ['SENT'], internalDate: String(1_900_000_000_000) }
        return { data: { id: p.id as string, messages: replied ? [message(id), own] : [message(id)] } }
      }
      const s = createScanner(
        deps({
          ai: { triage: okTriage('needs_reply'), draft: drafter(calls) },
          gmails: { [a.id]: g },
          now: () => 1_700_000_000_000 + 3600_000 // the test mail arrived an hour ago (within the re-check window)
        })
      )
      await s.run()
      const m1 = repo.findEmail(a.id, 'm1')!
      expect(repo.hasDraft(m1.id)).toBe(true)
      expect(repo.unseenDraftCount()).toBe(1)
      // The owner replies in Gmail; the next check (no new mail) notices it.
      replied = true
      g.users.history.list = async () => ({ data: { history: [] } })
      await s.run()
      expect(repo.getEmail(m1.id)).toMatchObject({ answered: true, threadSize: 2 })
      expect(repo.unseenDraftCount()).toBe(0)
      expect(calls).toEqual(['m1'])
    })

    it('draftOne refuses an email that was already answered', async () => {
      const a = addAccount()
      const g = fakeGmail(['m1'])
      g.users.threads.get = async (p) => ({
        data: { id: p.id as string, messages: [message('m1'), { ...message('r1'), labelIds: ['SENT'], internalDate: String(1_900_000_000_000) }] }
      })
      const calls: string[] = []
      const s = createScanner(deps({ ai: { triage: okTriage('info'), draft: drafter(calls) }, gmails: { [a.id]: g } }))
      await s.run()
      const m1 = repo.findEmail(a.id, 'm1')!
      expect(await s.draftOne(m1.id)).toBe('answered')
      expect(calls).toEqual([])
      expect(repo.getEmail(m1.id)!.answered).toBe(true)
    })

    it('stops drafting at maxDraftsPerRun with cap_drafts', async () => {
      const a = addAccount()
      const calls: string[] = []
      const r = await createScanner(
        deps({
          ai: { triage: okTriage('needs_reply'), draft: drafter(calls) },
          gmails: { [a.id]: fakeGmail(ids(5)) },
          settings: { maxDraftsPerRun: 2 }
        })
      ).run()
      expect(r.stopReason).toBe('cap_drafts')
      expect(calls).toHaveLength(2)
    })

    it('never drafts the same email twice across runs', async () => {
      const a = addAccount()
      const calls: string[] = []
      const scanner = createScanner(
        deps({ ai: { triage: okTriage('needs_reply'), draft: drafter(calls) }, gmails: { [a.id]: fakeGmail(['m1']) } })
      )
      await scanner.run()
      await scanner.run()
      expect(calls).toEqual(['m1'])
    })

    it("draft failure doesn't mark triage failed and nothing is notified", async () => {
      const a = addAccount()
      const notified: number[] = []
      const r = await createScanner(
        deps({
          ai: {
            triage: okTriage('needs_reply'),
            draft: async () => {
              throw Object.assign(new Error('draft failed: refusal'), { name: 'DraftFailed', usage: { input_tokens: 3, output_tokens: 0 } })
            }
          },
          gmails: { [a.id]: fakeGmail(['m1']) },
          onDraftsReady: (n) => notified.push(n)
        })
      ).run()
      expect(r.drafted).toBe(0)
      expect(repo.listEmails({ limit: 5 })[0]).toMatchObject({ state: 'triaged', tag: 'needs_reply' })
      expect(notified).toEqual([])
    })

    it('draftOne writes a draft for one needs_reply email on request', async () => {
      const a = addAccount()
      const calls: string[] = []
      const scanner = createScanner(deps({ ai: { triage: okTriage('needs_reply') }, gmails: { [a.id]: fakeGmail(['m1']) } }))
      await scanner.run() // no draft port → no drafts
      const email = repo.listEmails({ limit: 1 })[0]
      expect(repo.hasDraft(email.id)).toBe(false)
      const s2 = createScanner(
        deps({ ai: { triage: okTriage('needs_reply'), draft: drafter(calls) }, gmails: { [a.id]: fakeGmail([]) } })
      )
      expect(await s2.draftOne(email.id)).toBe('ok')
      expect(repo.hasDraft(email.id)).toBe(true)
      expect(await s2.draftOne(email.id)).toBe('exists')
      expect(calls).toEqual(['m1'])
    })

    it('draftOne without API key → no_api_key', async () => {
      expect(await createScanner(deps({ ai: null })).draftOne(1)).toBe('no_api_key')
    })

    it('info mail is never drafted', async () => {
      const a = addAccount()
      const calls: string[] = []
      await createScanner(deps({ ai: { triage: okTriage('info'), draft: drafter(calls) }, gmails: { [a.id]: fakeGmail(['m1']) } })).run()
      expect(calls).toEqual([])
    })
  })

  it('email text never passed to repo', async () => {
    const a = addAccount()
    const seen: string[] = []
    const spy = new Proxy(repo, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv)
        return typeof v === 'function'
          ? (...args: unknown[]) => {
              seen.push(JSON.stringify(args))
              return v.apply(target, args)
            }
          : v
      }
    })
    await createScanner(deps({ repo: spy, gmails: { [a.id]: fakeGmail(['m1']) } })).run()
    expect(triageCalls[0].body).toContain(BODY('m1'))
    expect(seen.join('\n')).not.toContain('Secret body text')
  })
})
