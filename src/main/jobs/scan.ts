import Anthropic from '@anthropic-ai/sdk'
import type { gmail_v1 } from '@googleapis/gmail'
import type { Account, EmailRow, Settings, StatusEvent, Tag } from '@shared/types'
import type { Repo } from '../db/repo'
import { MAX_ATTEMPTS } from '../db/repo'
import { getMessage, getThread, listNewMessageIds, type GmailLike } from '../google/gmail'
import { cleanBody, extractHeaders } from '../google/clean'
import { ReloginRequired } from '../google/accounts'
import { costUsd, RunBudget } from '../ai/usage'
import type { TokenUsage } from '../ai/triage'
import { EtaTracker } from './status'
import { isAnswered, withTarget } from './thread'
import { log, redactError } from '../log'

/** The two model calls, injected so the scan can be tested without the network. */
export interface AiPort {
  triage(input: {
    fromName: string
    fromEmail: string
    subject: string
    body: string
    date?: number
  }): Promise<{ summary: string; tag: Tag; usage: TokenUsage }>
  /** Optional: when absent, no drafts are written. */
  draft?(input: {
    thread: gmail_v1.Schema$Thread
    targetMessageId: string
    ownerEmail?: string
  }): Promise<{ body: string; usage: TokenUsage }>
}

export interface ScanDeps {
  repo: Repo
  settings: Settings
  getGmail(accountId: number): Promise<GmailLike>
  /** null when no API key is configured */
  ai: AiPort | null
  emit(s: StatusEvent): void
  now(): number
  onDraftsReady?(count: number): void
}

export type StopReason = 'done' | 'cap_emails' | 'cap_tokens' | 'cap_drafts' | 'api_key_invalid'

export interface RunResult {
  status: 'done' | 'already_running' | 'no_api_key' | 'no_accounts'
  stopReason: StopReason
  triaged: number
  drafted: number
  offline: boolean
  reloginAccounts: string[]
}

const RECHECK_DAYS = 14
const RECHECK_LIMIT = 100
const DAY_MS = 24 * 3600_000
const PROMO_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']
const NET_CODES = new Set(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED'])

export function isNetworkError(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true
  const code = (e as { code?: unknown; cause?: { code?: unknown } })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code
  return typeof code === 'string' && NET_CODES.has(code)
}

export function isAuthError(e: unknown): boolean {
  return e instanceof Anthropic.AuthenticationError
}

class StopRun extends Error {
  constructor(public reason: StopReason) {
    super(reason)
  }
}
class AccountOffline extends Error {}

const empty = (status: RunResult['status']): RunResult => ({
  status,
  stopReason: 'done',
  triaged: 0,
  drafted: 0,
  offline: false,
  reloginAccounts: []
})

export interface RunOptions {
  /** Check all inbox mail received since this time (ms) instead of only mail new since the last check. */
  sinceMs?: number
}

/** The conversation of an email, always including the email itself. */
export async function loadThread(gmail: GmailLike, row: Pick<EmailRow, 'gmailThreadId' | 'gmailMessageId'>): Promise<gmail_v1.Schema$Thread> {
  const thread = await getThread(gmail, row.gmailThreadId)
  if ((thread.messages ?? []).some((m) => m.id === row.gmailMessageId)) return thread
  return withTarget(thread, await getMessage(gmail, row.gmailMessageId))
}

export function createScanner(deps: ScanDeps): {
  run(opts?: RunOptions): Promise<RunResult>
  draftOne(emailId: number): Promise<'ok' | 'exists' | 'answered' | 'busy' | 'no_api_key' | 'not_found' | 'failed'>
  isRunning(): boolean
  /** Blocks new checks and manual drafts (an app update is installing); returns the release function. */
  hold(): () => void
} {
  let running = false
  let held = 0

  async function runInner(opts: RunOptions = {}): Promise<RunResult> {
    const { repo, settings, emit, now } = deps
    if (!deps.ai) return empty('no_api_key')
    const ai = deps.ai
    const accounts = repo.listAccounts()
    if (accounts.length === 0) return empty('no_accounts')

    const result = empty('done')
    const budget = new RunBudget(settings.maxTokensPerRun)
    const eta = new EtaTracker()
    const runId = repo.startRun()
    const needsReply: { emailId: number; accountId: number; gmail: GmailLike; row: EmailRow }[] = []
    const mailboxes = new Map<number, GmailLike>()
    // A reply from any of the owner's connected addresses counts as "answered".
    const owners = accounts.map((a) => a.email)

    const record = (model: string, u: TokenUsage): void => {
      budget.add(u)
      repo.addUsage({ runId, model, inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: costUsd(model, u, settings.prices) })
    }

    const checkCaps = (): void => {
      if (result.triaged >= settings.maxEmailsPerRun) throw new StopRun('cap_emails')
      if (budget.exhausted) throw new StopRun('cap_tokens')
    }

    async function scanAccount(acc: Account): Promise<void> {
      emit({ phase: 'listing', accountLabel: acc.label })
      let gmail: GmailLike
      let listing: { ids: string[]; newHistoryId: string }
      try {
        gmail = await deps.getGmail(acc.id)
        mailboxes.set(acc.id, gmail)
        listing = await listNewMessageIds(
          gmail,
          { historyId: acc.lastHistoryId, lastCheckedAt: acc.lastCheckedAt },
          now(),
          opts.sinceMs
        )
      } catch (e) {
        if (isNetworkError(e)) throw new AccountOffline()
        throw e
      }

      // Queue: earlier failures/pending first (max 2 attempts), then new ids not yet known.
      const retries = repo.pendingRetries(acc.id)
      const known = new Set(retries.map((r) => r.gmailMessageId))
      const fresh = listing.ids.filter((id) => !known.has(id) && !repo.findEmail(acc.id, id))
      const queue: { gmailId: string; row?: EmailRow }[] = [
        ...retries.map((r) => ({ gmailId: r.gmailMessageId, row: r })),
        ...fresh.map((gmailId) => ({ gmailId }))
      ]

      for (let i = 0; i < queue.length; i++) {
        checkCaps()
        const item = queue[i]
        const started = Date.now()
        let msg: gmail_v1.Schema$Message
        try {
          msg = await getMessage(gmail, item.gmailId)
        } catch (e) {
          if (isNetworkError(e)) throw new AccountOffline()
          log.warn('gmail_get_failed', { account: acc.id, ...redactError(e) })
          continue
        }
        const h = extractHeaders(msg)
        let emailId = item.row?.id ?? null
        if (emailId === null) {
          emailId = repo.insertEmailIfNew({
            accountId: acc.id,
            gmailMessageId: item.gmailId,
            gmailThreadId: msg.threadId ?? item.gmailId,
            receivedAt: h.receivedAt,
            fromName: h.fromName,
            fromEmail: h.fromEmail,
            subject: h.subject
          })
          if (emailId === null) continue // duplicate
        }

        if (settings.prefilterPromotions && (msg.labelIds ?? []).some((l) => PROMO_LABELS.includes(l))) {
          repo.setTriage(emailId, {
            tag: 'newsletter_junk',
            summary: `Promotion/social update from ${h.fromName || h.fromEmail}.`
          })
          continue
        }

        emit({
          phase: 'summarizing',
          accountLabel: acc.label,
          index: i + 1,
          total: queue.length,
          etaSec: eta.etaSec(queue.length - i)
        })
        const body = cleanBody(msg, settings.triageBodyChars) // in memory only
        try {
          const t = await ai.triage({ ...h, body, date: h.receivedAt })
          record(settings.triageModel, t.usage)
          repo.setTriage(emailId, { summary: t.summary, tag: t.tag })
          result.triaged++
          if (t.tag === 'needs_reply') needsReply.push({ emailId, accountId: acc.id, gmail, row: repo.getEmail(emailId)! })
        } catch (e) {
          if (isAuthError(e)) throw new StopRun('api_key_invalid')
          if (isNetworkError(e)) throw new AccountOffline()
          const usage = (e as { usage?: TokenUsage }).usage
          if (usage) record(settings.triageModel, usage)
          const r = repo.markAttemptFailed(emailId)
          log.warn('triage_failed', { account: acc.id, attempts: r.attempts, max: MAX_ATTEMPTS, ...redactError(e) })
        }
        eta.record(Date.now() - started)
      }
      repo.setCursor(acc.id, listing.newHistoryId, now())
    }

    async function draftAll(): Promise<void> {
      if (!ai.draft || needsReply.length === 0) return
      const todo = needsReply.filter((n) => !repo.hasDraft(n.emailId) && !repo.getEmail(n.emailId)?.answered)
      const draftEta = new EtaTracker()
      for (let i = 0; i < todo.length; i++) {
        if (result.drafted >= settings.maxDraftsPerRun) throw new StopRun('cap_drafts')
        if (budget.exhausted) throw new StopRun('cap_tokens')
        const n = todo[i]
        const acc = repo.getAccount(n.accountId)
        emit({ phase: 'drafting', accountLabel: acc?.label, index: i + 1, total: todo.length, etaSec: draftEta.etaSec(todo.length - i) })
        const started = Date.now()
        try {
          const thread = await loadThread(n.gmail, n.row)
          const answered = isAnswered(thread, n.row.gmailMessageId, owners)
          repo.setThreadInfo(n.emailId, { answered, size: thread.messages?.length ?? 1 })
          if (answered) {
            // Important, but the owner already replied: note it instead of drafting.
            draftEta.record(Date.now() - started)
            continue
          }
          const d = await ai.draft({ thread, targetMessageId: n.row.gmailMessageId, ownerEmail: acc?.email })
          record(settings.draftModel, d.usage)
          repo.addDraft(n.emailId, d.body)
          result.drafted++
        } catch (e) {
          if (isAuthError(e)) throw new StopRun('api_key_invalid')
          if (isNetworkError(e)) {
            result.offline = true
            return
          }
          const usage = (e as { usage?: TokenUsage }).usage
          if (usage) record(settings.draftModel, usage)
          log.warn('draft_failed', { email: n.emailId, ...redactError(e) })
        }
        draftEta.record(Date.now() - started)
      }
    }

    /**
     * Re-checks older open "needs reply" mail: the owner may have answered since the last check.
     * Answered mail is then labelled as such (and its draft is hidden), never drafted again.
     */
    async function recheckAnswered(): Promise<void> {
      const fresh = new Set(needsReply.map((n) => n.emailId))
      for (const e of repo.openNeedsReply(now() - RECHECK_DAYS * DAY_MS, RECHECK_LIMIT)) {
        const gmail = mailboxes.get(e.accountId)
        if (fresh.has(e.id) || !gmail) continue
        try {
          const thread = await loadThread(gmail, e)
          repo.setThreadInfo(e.id, { answered: isAnswered(thread, e.gmailMessageId, owners), size: thread.messages?.length ?? 1 })
        } catch (err) {
          if (isNetworkError(err)) return
          log.warn('answered_check_failed', { email: e.id, ...redactError(err) })
        }
      }
    }

    try {
      for (const acc of accounts) {
        if (acc.status !== 'ok') {
          result.reloginAccounts.push(acc.label)
          continue
        }
        try {
          await scanAccount(acc)
        } catch (e) {
          if (e instanceof StopRun) throw e
          if (e instanceof AccountOffline) {
            result.offline = true
            continue
          }
          if (e instanceof ReloginRequired) {
            result.reloginAccounts.push(acc.label)
            continue
          }
          log.error('account_scan_failed', { account: acc.id, ...redactError(e) })
        }
      }
      await recheckAnswered()
      await draftAll()
    } catch (e) {
      if (!(e instanceof StopRun)) throw e
      result.stopReason = e.reason
      // A cap stop still lets drafts for already-triaged mail be written (they have their own cap).
      if (e.reason === 'cap_emails') {
        try {
          await recheckAnswered()
          await draftAll()
        } catch (e2) {
          if (!(e2 instanceof StopRun)) throw e2
          if (e2.reason === 'api_key_invalid') result.stopReason = e2.reason
        }
      }
    } finally {
      repo.finishRun(runId, { status: result.status, emailsSeen: result.triaged, stopReason: result.stopReason })
    }

    if (result.drafted > 0) deps.onDraftsReady?.(result.drafted)
    if (result.stopReason === 'api_key_invalid') emit({ phase: 'error', message: 'Check your API key in Settings' })
    log.info('run_done', { triaged: result.triaged, drafted: result.drafted, stop: result.stopReason, offline: result.offline })
    return result
  }

  /** Manual "Write draft" for one email (e.g. after a cap or a failed draft). Shares the run lock. */
  async function draftOne(
    emailId: number
  ): Promise<'ok' | 'exists' | 'answered' | 'busy' | 'no_api_key' | 'not_found' | 'failed'> {
    if (!deps.ai?.draft) return 'no_api_key'
    if (running || held > 0) return 'busy'
    const { repo, settings } = deps
    const e = repo.getEmail(emailId)
    if (!e) return 'not_found'
    if (repo.hasDraft(emailId)) return 'exists'
    if (e.answered) return 'answered'
    running = true
    try {
      deps.emit({ phase: 'drafting', index: 1, total: 1 })
      const gmail = await deps.getGmail(e.accountId)
      const thread = await loadThread(gmail, e)
      const answered = isAnswered(
        thread,
        e.gmailMessageId,
        repo.listAccounts().map((a) => a.email)
      )
      repo.setThreadInfo(emailId, { answered, size: thread.messages?.length ?? 1 })
      if (answered) return 'answered'
      const d = await deps.ai.draft({
        thread,
        targetMessageId: e.gmailMessageId,
        ownerEmail: repo.getAccount(e.accountId)?.email
      })
      repo.addUsage({
        runId: null,
        model: settings.draftModel,
        inputTokens: d.usage.input_tokens,
        outputTokens: d.usage.output_tokens,
        costUsd: costUsd(settings.draftModel, d.usage, settings.prices)
      })
      repo.addDraft(emailId, d.body)
      return 'ok'
    } catch (err) {
      log.warn('draft_one_failed', { email: emailId, ...redactError(err) })
      return 'failed'
    } finally {
      running = false
      deps.emit({ phase: 'idle' })
    }
  }

  return {
    draftOne,
    isRunning: () => running,
    hold() {
      held++
      let done = false
      return () => {
        if (!done) held--
        done = true
      }
    },
    async run(opts?: RunOptions) {
      if (running || held > 0) return empty('already_running')
      running = true
      try {
        return await runInner(opts)
      } finally {
        running = false
      }
    }
  }
}
