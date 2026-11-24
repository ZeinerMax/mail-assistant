import type { Account } from '@shared/types'
import { getMessage, type GmailLike } from '../google/gmail'
import { extractText } from '../google/clean'
import { log, redactError } from '../log'
import { ReplyError } from '../send/compose'
import { buildSimpleMime } from '../send/mime'
import { sendViaGmail, type GmailSendLike } from '../send/gmail-send'
import { sendViaSmtp, type SmtpTransportLike } from '../send/smtp'
import type { Repo } from '../db/repo'
import { parseUnsubscribe } from './parse'
import type { UnsubscribeFinder } from './find'

export type UnsubMethod = 'one-click' | 'email' | 'web' | 'web-ai'
export interface UnsubResult {
  method: UnsubMethod
  /** The address emailed, or the URL contacted (shown back to the user). */
  target: string
}

const TIMEOUT_MS = 15_000

export interface UnsubscribeDeps {
  repo: Repo
  openMailbox(id: number): Promise<GmailLike>
  gmailSender(id: number): Promise<GmailSendLike>
  smtpFor(account: Account): SmtpTransportLike
  /** AI fallback to locate a link when there is no List-Unsubscribe header; null if no API key. */
  finder: UnsubscribeFinder | null
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export function createUnsubscribeService(deps: UnsubscribeDeps) {
  const { repo } = deps
  const doFetch = deps.fetchImpl ?? globalThis.fetch
  const inFlight = new Set<number>()

  async function call(url: string, init: RequestInit): Promise<void> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await doFetch(url, { ...init, redirect: 'follow', signal: ctrl.signal })
      if (!res.ok) throw new ReplyError('The sender refused the unsubscribe request. Try the unsubscribe link in the email itself.')
    } catch (e) {
      if (e instanceof ReplyError) throw e
      throw new ReplyError('Could not reach the unsubscribe address. Check your internet connection and try again.')
    } finally {
      clearTimeout(timer)
    }
  }

  async function sendMail(account: Account, to: string, subject: string, body: string): Promise<void> {
    const raw = await buildSimpleMime({
      from: account.email,
      to,
      subject,
      text: body || 'Please unsubscribe this address.'
    })
    if (account.kind === 'gmail') {
      await sendViaGmail(await deps.gmailSender(account.id), raw)
    } else {
      await sendViaSmtp(deps.smtpFor(account), account.email, to, raw)
    }
  }

  async function unsubscribe(emailId: number): Promise<UnsubResult> {
    if (inFlight.has(emailId)) throw new ReplyError('This unsubscribe is already running.')
    inFlight.add(emailId)
    try {
      const row = repo.getEmail(emailId)
      const account = row ? repo.getAccount(row.accountId) : null
      if (!row || !account) throw new ReplyError('That email is no longer available.')

      const msg = await getMessage(await deps.openMailbox(account.id), row.gmailMessageId)
      const t = parseUnsubscribe(msg)

      let result: UnsubResult
      if (t.oneClick) {
        await call(t.oneClick, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click'
        })
        result = { method: 'one-click', target: t.oneClick }
      } else if (t.mailto) {
        await sendMail(account, t.mailto.to, t.mailto.subject, t.mailto.body)
        result = { method: 'email', target: t.mailto.to }
      } else if (t.http) {
        await call(t.http, { method: 'GET' })
        result = { method: 'web', target: t.http }
      } else {
        const url = deps.finder ? await deps.finder(extractText(msg)) : null
        if (!url) throw new ReplyError('Could not find an unsubscribe option in this email.')
        await call(url, { method: 'GET' })
        result = { method: 'web-ai', target: url }
      }

      // Handled: mark it done so it leaves the active list.
      repo.setFinished(emailId, true)
      log.info('unsubscribed', { emailId, method: result.method, kind: account.kind })
      return result
    } catch (e) {
      if (!(e instanceof ReplyError)) log.error('unsubscribe_failed', redactError(e))
      throw e
    } finally {
      inFlight.delete(emailId)
    }
  }

  return { unsubscribe }
}

export type UnsubscribeService = ReturnType<typeof createUnsubscribeService>
