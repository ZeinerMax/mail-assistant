import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'
import { buildMailItems, buildDraftItems, finalStatus } from '../src/main/views'

let repo: Repo
beforeEach(() => {
  repo = new Repo(openDb(join(mkdtempSync(join(tmpdir(), 'ma-views-')), 'db.sqlite')))
})

const seed = () => {
  const a = repo.addAccount({ email: 'a@gmail.com', label: 'Home', color: '#2563eb', lastHistoryId: null })
  const e1 = repo.insertEmailIfNew({ accountId: a.id, gmailMessageId: 'm1', gmailThreadId: 't1', receivedAt: 2, fromName: 'Jana', fromEmail: 'j@x', subject: 'Lunch' })!
  const e2 = repo.insertEmailIfNew({ accountId: a.id, gmailMessageId: 'm2', gmailThreadId: 't2', receivedAt: 1, fromName: '', fromEmail: 'n@x', subject: 'News' })!
  repo.setTriage(e1, { summary: 'Asks about lunch', tag: 'needs_reply' })
  repo.setTriage(e2, { summary: 'Newsletter', tag: 'newsletter_junk' })
  const d = repo.addDraft(e1, 'Hi Jana')
  return { a, e1, e2, d }
}

describe('views', () => {
  it('mail items carry account label/color and hasDraft', () => {
    const { a, e1 } = seed()
    const items = buildMailItems(repo, {})
    expect(items[0]).toMatchObject({ id: e1, accountId: a.id, accountLabel: 'Home', color: '#2563eb', hasDraft: true, tag: 'needs_reply' })
    expect(items[1].hasDraft).toBe(false)
    expect(buildMailItems(repo, { tag: 'newsletter_junk' })).toHaveLength(1)
  })

  it('draft items join email + account', () => {
    const { d } = seed()
    expect(buildDraftItems(repo)[0]).toMatchObject({
      id: d,
      fromName: 'Jana',
      subject: 'Lunch',
      summary: 'Asks about lunch',
      accountLabel: 'Home',
      body: 'Hi Jana',
      seen: false,
      copied: false
    })
  })

  it('finalStatus: idle with last/next', () => {
    expect(finalStatus({ offline: false, stopReason: 'done', reloginAccounts: [] }, 10, 20)).toEqual({ phase: 'idle', lastRunAt: 10, nextRunAt: 20 })
  })

  it('finalStatus: offline names the next try', () => {
    const s = finalStatus({ offline: true, stopReason: 'done', reloginAccounts: [] }, 10, new Date(2026, 0, 1, 9, 5).getTime())
    expect(s).toMatchObject({ phase: 'offline', message: 'Offline — will try again at 09:05' })
  })

  it('finalStatus: api key problem wins', () => {
    expect(finalStatus({ offline: true, stopReason: 'api_key_invalid', reloginAccounts: [] }, 1, 2)).toMatchObject({
      phase: 'error',
      message: 'Check your API key in Settings'
    })
  })

  it('finalStatus: relogin and caps are mentioned while idle', () => {
    const s = finalStatus({ offline: false, stopReason: 'cap_emails', reloginAccounts: ['Work'] }, 1, 2)
    expect(s.phase).toBe('idle')
    expect(s.message).toContain('Work needs sign-in')
    expect(s.message).toContain('limit')
  })

  it('repliedAt passes through; replied email drops out of drafts', () => {
    const { e1 } = seed()
    expect(buildMailItems(repo, {}).find((m) => m.id === e1)!.repliedAt).toBeNull()
    expect(buildDraftItems(repo)[0].repliedAt).toBeNull()
    repo.markReplied(e1)
    expect(buildMailItems(repo, {}).find((m) => m.id === e1)!.repliedAt).toBeTypeOf('number')
    expect(buildDraftItems(repo)).toHaveLength(0)
  })
})
