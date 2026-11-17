import type { Db } from './schema'
import type { Account, AccountStatus, DraftRow, EmailRow, EmailState, NewEmail, Tag, UsageRow } from '@shared/types'

type Row = Record<string, unknown>

const toAccount = (r: Row): Account => ({
  id: r.id as number,
  email: r.email as string,
  label: r.label as string,
  color: r.color as string,
  status: r.status as AccountStatus,
  lastHistoryId: (r.last_history_id as string | null) ?? null,
  lastCheckedAt: (r.last_checked_at as number | null) ?? null,
  createdAt: r.created_at as number
})

const toEmail = (r: Row): EmailRow => ({
  id: r.id as number,
  accountId: r.account_id as number,
  gmailMessageId: r.gmail_message_id as string,
  gmailThreadId: r.gmail_thread_id as string,
  receivedAt: r.received_at as number,
  fromName: r.from_name as string,
  fromEmail: r.from_email as string,
  subject: r.subject as string,
  tag: (r.tag as Tag | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  state: r.state as EmailState,
  attempts: r.attempts as number
})

const toDraft = (r: Row): DraftRow => ({
  id: r.id as number,
  emailId: r.email_id as number,
  body: r.body as string,
  createdAt: r.created_at as number,
  seenAt: (r.seen_at as number | null) ?? null,
  copiedAt: (r.copied_at as number | null) ?? null
})

export const MAX_ATTEMPTS = 2

export class Repo {
  constructor(
    private db: Db,
    private now: () => number = Date.now
  ) {}

  // ---- accounts
  addAccount(a: { email: string; label: string; color: string; lastHistoryId: string | null }): Account {
    const info = this.db
      .prepare('INSERT INTO accounts (email,label,color,last_history_id,created_at) VALUES (?,?,?,?,?)')
      .run(a.email, a.label, a.color, a.lastHistoryId, this.now())
    return this.getAccount(Number(info.lastInsertRowid))!
  }
  getAccount(id: number): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Row | undefined
    return r ? toAccount(r) : null
  }
  findAccountByEmail(email: string): Account | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE email=?').get(email) as Row | undefined
    return r ? toAccount(r) : null
  }
  listAccounts(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY id').all() as Row[]).map(toAccount)
  }
  setAccountStatus(id: number, status: AccountStatus): void {
    this.db.prepare('UPDATE accounts SET status=? WHERE id=?').run(status, id)
  }
  setAccountLabel(id: number, label: string): void {
    this.db.prepare('UPDATE accounts SET label=? WHERE id=?').run(label, id)
  }
  setCursor(id: number, historyId: string | null, checkedAt: number): void {
    this.db.prepare('UPDATE accounts SET last_history_id=?, last_checked_at=? WHERE id=?').run(historyId, checkedAt, id)
  }
  removeAccount(id: number): void {
    this.db.prepare('DELETE FROM accounts WHERE id=?').run(id)
  }

  // ---- emails
  insertEmailIfNew(e: NewEmail): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO emails
         (account_id,gmail_message_id,gmail_thread_id,received_at,from_name,from_email,subject)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(e.accountId, e.gmailMessageId, e.gmailThreadId, e.receivedAt, e.fromName, e.fromEmail, e.subject)
    return info.changes === 0 ? null : Number(info.lastInsertRowid)
  }
  getEmail(id: number): EmailRow | null {
    const r = this.db.prepare('SELECT * FROM emails WHERE id=?').get(id) as Row | undefined
    return r ? toEmail(r) : null
  }
  findEmail(accountId: number, gmailMessageId: string): EmailRow | null {
    const r = this.db
      .prepare('SELECT * FROM emails WHERE account_id=? AND gmail_message_id=?')
      .get(accountId, gmailMessageId) as Row | undefined
    return r ? toEmail(r) : null
  }
  setTriage(emailId: number, t: { summary: string; tag: Tag }): void {
    this.db.prepare("UPDATE emails SET summary=?, tag=?, state='triaged' WHERE id=?").run(t.summary, t.tag, emailId)
  }
  markAttemptFailed(emailId: number): { attempts: number; state: EmailState } {
    this.db.prepare("UPDATE emails SET attempts=attempts+1, state='failed' WHERE id=?").run(emailId)
    const r = this.db.prepare('SELECT attempts,state FROM emails WHERE id=?').get(emailId) as Row
    return { attempts: r.attempts as number, state: r.state as EmailState }
  }
  pendingRetries(accountId: number): EmailRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM emails WHERE account_id=? AND state IN ('failed','pending') AND attempts < ? ORDER BY received_at"
        )
        .all(accountId, MAX_ATTEMPTS) as Row[]
    ).map(toEmail)
  }
  listEmails(f: { tag?: Tag; accountId?: number; limit: number }): EmailRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (f.tag) {
      where.push('tag=?')
      args.push(f.tag)
    }
    if (f.accountId) {
      where.push('account_id=?')
      args.push(f.accountId)
    }
    const sql = `SELECT * FROM emails ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY received_at DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, f.limit) as Row[]).map(toEmail)
  }

  // ---- drafts
  addDraft(emailId: number, body: string): number {
    const info = this.db
      .prepare('INSERT INTO drafts (email_id, body, created_at) VALUES (?,?,?)')
      .run(emailId, body, this.now())
    return Number(info.lastInsertRowid)
  }
  hasDraft(emailId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM drafts WHERE email_id=?').get(emailId)
  }
  listDrafts(): DraftRow[] {
    return (this.db.prepare('SELECT * FROM drafts ORDER BY created_at DESC').all() as Row[]).map(toDraft)
  }
  getDraft(id: number): DraftRow | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id) as Row | undefined
    return r ? toDraft(r) : null
  }
  markDraftSeen(id: number): void {
    this.db.prepare('UPDATE drafts SET seen_at=COALESCE(seen_at, ?) WHERE id=?').run(this.now(), id)
  }
  markDraftCopied(id: number): void {
    this.db.prepare('UPDATE drafts SET copied_at=?, seen_at=COALESCE(seen_at, ?) WHERE id=?').run(this.now(), this.now(), id)
  }
  unseenDraftCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE seen_at IS NULL').get() as Row).n as number
  }

  // ---- runs + usage
  startRun(): number {
    return Number(this.db.prepare('INSERT INTO runs (started_at) VALUES (?)').run(this.now()).lastInsertRowid)
  }
  finishRun(id: number, r: { status: string; emailsSeen: number; stopReason: string }): void {
    this.db
      .prepare('UPDATE runs SET finished_at=?, status=?, emails_seen=?, stop_reason=? WHERE id=?')
      .run(this.now(), r.status, r.emailsSeen, r.stopReason, id)
  }
  addUsage(u: { runId: number | null; model: string; inputTokens: number; outputTokens: number; costUsd: number }): void {
    this.db
      .prepare('INSERT INTO usage (run_id,model,input_tokens,output_tokens,cost_usd,created_at) VALUES (?,?,?,?,?,?)')
      .run(u.runId, u.model, u.inputTokens, u.outputTokens, u.costUsd, this.now())
  }
  usageSummary(sinceMs?: number): UsageRow[] {
    return (
      this.db
        .prepare(
          `SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_usd) AS c
           FROM usage WHERE created_at >= ? GROUP BY model ORDER BY model`
        )
        .all(sinceMs ?? 0) as Row[]
    ).map((r) => ({
      model: r.model as string,
      inputTokens: r.i as number,
      outputTokens: r.o as number,
      costUsd: r.c as number
    }))
  }
}
