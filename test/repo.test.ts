import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'
import type { NewEmail } from '@shared/types'

let repo: Repo
let db: ReturnType<typeof openDb>

const email = (accountId: number, id: string, extra: Partial<NewEmail> = {}): NewEmail => ({
  accountId,
  gmailMessageId: id,
  gmailThreadId: 't-' + id,
  receivedAt: 1_700_000_000_000,
  fromName: 'Jana',
  fromEmail: 'jana@example.com',
  subject: 'Lunch',
  ...extra
})

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'ma-db-')), 'mail.sqlite'))
  repo = new Repo(db)
})

describe('schema + repo', () => {
  it('schema creates 5 tables', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'))
    expect(names).toEqual(['accounts', 'drafts', 'emails', 'runs', 'usage'])
  })

  it('emails table has no body column', () => {
    const cols = (db.prepare('PRAGMA table_info(emails)').all() as { name: string }[]).map((c) => c.name)
    const allowed = [
      'id', 'account_id', 'gmail_message_id', 'gmail_thread_id', 'received_at',
      'from_name', 'from_email', 'subject', 'tag', 'summary', 'state', 'attempts',
      'answered', 'thread_size', 'replied_at' // flags about the conversation, no text
    ]
    expect(cols.every((c) => allowed.includes(c))).toBe(true)
  })

  it('addAccount / listAccounts / status / cursor', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#2563eb', lastHistoryId: '100' })
    repo.setAccountStatus(a.id, 'needs_relogin')
    repo.setCursor(a.id, '200', 5)
    const [got] = repo.listAccounts()
    expect(got).toMatchObject({ email: 'a@x.com', status: 'needs_relogin', lastHistoryId: '200', lastCheckedAt: 5 })
  })

  it('insertEmailIfNew returns null on duplicate (account_id, gmail_message_id)', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    expect(repo.insertEmailIfNew(email(a.id, 'm1'))).toBeTypeOf('number')
    expect(repo.insertEmailIfNew(email(a.id, 'm1'))).toBeNull()
  })

  it('setTriage stores summary + tag; listEmails filters by tag', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    const id1 = repo.insertEmailIfNew(email(a.id, 'm1'))!
    const id2 = repo.insertEmailIfNew(email(a.id, 'm2'))!
    repo.setTriage(id1, { summary: 'Asks about lunch', tag: 'needs_reply' })
    repo.setTriage(id2, { summary: 'Newsletter', tag: 'newsletter_junk' })
    const rows = repo.listEmails({ tag: 'needs_reply', limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ summary: 'Asks about lunch', tag: 'needs_reply', state: 'triaged', fromName: 'Jana' })
  })

  it('markAttemptFailed sets state failed; pendingRetries excludes attempts>=2', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    const id = repo.insertEmailIfNew(email(a.id, 'm1'))!
    expect(repo.markAttemptFailed(id)).toEqual({ attempts: 1, state: 'failed' })
    expect(repo.pendingRetries(a.id).map((r) => r.id)).toEqual([id])
    expect(repo.markAttemptFailed(id)).toEqual({ attempts: 2, state: 'failed' })
    expect(repo.pendingRetries(a.id)).toEqual([])
  })

  it('drafts: add, hasDraft, list, seen, copied, unseen count', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    const e = repo.insertEmailIfNew(email(a.id, 'm1'))!
    expect(repo.hasDraft(e)).toBe(false)
    const d = repo.addDraft(e, 'Hi Jana, yes!')
    expect(repo.hasDraft(e)).toBe(true)
    expect(repo.unseenDraftCount()).toBe(1)
    repo.markDraftSeen(d)
    repo.markDraftCopied(d)
    expect(repo.unseenDraftCount()).toBe(0)
    expect(repo.listDrafts()[0]).toMatchObject({ id: d, emailId: e, body: 'Hi Jana, yes!' })
  })

  it('removeAccount cascades', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    const e = repo.insertEmailIfNew(email(a.id, 'm1'))!
    repo.addDraft(e, 'x')
    repo.removeAccount(a.id)
    expect(repo.listEmails({ limit: 10 })).toEqual([])
    expect(repo.listDrafts()).toEqual([])
  })

  it('runs + usageSummary sums per model', () => {
    const run = repo.startRun()
    repo.addUsage({ runId: run, model: 'm-a', inputTokens: 10, outputTokens: 5, costUsd: 0.1 })
    repo.addUsage({ runId: run, model: 'm-a', inputTokens: 20, outputTokens: 5, costUsd: 0.2 })
    repo.addUsage({ runId: run, model: 'm-b', inputTokens: 1, outputTokens: 1, costUsd: 1 })
    repo.finishRun(run, { status: 'done', emailsSeen: 3, stopReason: 'done' })
    const sum = repo.usageSummary()
    expect(sum.find((u) => u.model === 'm-a')).toMatchObject({ inputTokens: 30, outputTokens: 10 })
    expect(sum.find((u) => u.model === 'm-a')!.costUsd).toBeCloseTo(0.3)
    expect(repo.usageSummary(Date.now() + 60_000)).toEqual([])
  })

  it('IMAP account smtp defaults from the imap host, can be set; Gmail has none', () => {
    const g = repo.addAccount({ email: 'g@x.com', label: 'G', color: '#000', lastHistoryId: null })
    expect(g.smtp).toBeNull()
    const i = repo.addImapAccount({ email: 'a@seznam.cz', label: 'S', color: '#111', host: 'imap.seznam.cz', port: 993, user: 'a@seznam.cz' })
    expect(i.smtp).toEqual({ host: 'smtp.seznam.cz', port: 465 })
    repo.setSmtpSettings(i.id, { host: 'smtp.x.cz', port: 587 })
    expect(repo.getAccount(i.id)!.smtp).toEqual({ host: 'smtp.x.cz', port: 587 })
  })

  it('markReplied sets repliedAt and answered', () => {
    let t = 1000
    const r = new Repo(db, () => t)
    const a = r.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    const id = r.insertEmailIfNew(email(a.id, 'm1'))!
    expect(r.getEmail(id)).toMatchObject({ repliedAt: null, answered: false })
    t = 2000
    r.markReplied(id)
    expect(r.getEmail(id)).toMatchObject({ repliedAt: 2000, answered: true })
  })

  it('saveDraftBody replaces an existing draft body or creates a seen draft', () => {
    const a = repo.addAccount({ email: 'a@x.com', label: 'A', color: '#000', lastHistoryId: null })
    const e1 = repo.insertEmailIfNew(email(a.id, 'm1'))!
    const e2 = repo.insertEmailIfNew(email(a.id, 'm2'))!
    const d = repo.addDraft(e1, 'old')
    repo.saveDraftBody(e1, 'new')
    expect(repo.getDraft(d)!.body).toBe('new')
    expect(repo.listDrafts()).toHaveLength(1)
    repo.saveDraftBody(e2, 'fresh')
    const created = repo.listDrafts().find((x) => x.emailId === e2)!
    expect(created.body).toBe('fresh')
    expect(created.seenAt).not.toBeNull()
  })
})
