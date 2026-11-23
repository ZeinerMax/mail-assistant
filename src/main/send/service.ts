import type { Repo } from '../db/repo'
import type { Account } from '@shared/types'
import type { ReplyPreview } from '@shared/ipc'
import { getMessage, type GmailLike } from '../google/gmail'
import { log, redactError } from '../log'
import { buildReply, ReplyError } from './compose'
import { buildMime } from './mime'
import { SEND_PERMISSION_MISSING } from '@shared/messages'
import { sendViaGmail, type GmailSendLike } from './gmail-send'
import { sendViaSmtp, smtpErrorMessage, type SmtpTransportLike } from './smtp'

export class SendPermissionMissing extends Error {
  constructor(public accountId: number) {
    super(SEND_PERMISSION_MISSING)
    this.name = 'SendPermissionMissing'
  }
}

/**
 * Missing send scope: Gmail answers 403 with "insufficient authentication scopes".
 * PARTLY VERIFIED: status + message wording match the Gmail API error docs; not yet confirmed against a live account.
 */
function isMissingScope(e: unknown): boolean {
  const x = e as { status?: number; code?: number; message?: string; response?: { data?: { error?: { message?: string } } } } | null
  const status = x?.status ?? x?.code
  if (status !== 403) return false
  return /insufficient/i.test(x?.message ?? '') || /insufficient/i.test(x?.response?.data?.error?.message ?? '')
}

export interface ReplyServiceDeps {
  repo: Repo
  openMailbox(id: number): Promise<GmailLike>
  gmailSender(id: number): Promise<GmailSendLike>
  smtpFor(account: Account): SmtpTransportLike
}

export function createReplyService(deps: ReplyServiceDeps) {
  const { repo } = deps
  const sending = new Set<number>()

  async function original(emailId: number, text: string) {
    const row = repo.getEmail(emailId)
    const account = row ? repo.getAccount(row.accountId) : null
    if (!row || !account) throw new ReplyError('That email is no longer available.')
    const msg = await getMessage(await deps.openMailbox(account.id), row.gmailMessageId)
    return { row, account, reply: buildReply(msg, account.email, text) }
  }

  async function preview(emailId: number): Promise<ReplyPreview> {
    const { account, reply } = await original(emailId, 'preview')
    return { to: reply.to, from: account.email, subject: reply.subject }
  }

  async function send(emailId: number, text: string): Promise<{ sentAt: number }> {
    if (sending.has(emailId)) throw new ReplyError('This reply is already being sent.')
    sending.add(emailId)
    try {
      const { row, account, reply } = await original(emailId, text)
      if (row.repliedAt != null) throw new ReplyError('You already replied to this email from the app.')
      const raw = await buildMime(account.email, reply)
      try {
        if (account.kind === 'gmail') {
          await sendViaGmail(await deps.gmailSender(account.id), raw, row.gmailThreadId)
        } else {
          await sendViaSmtp(deps.smtpFor(account), account.email, reply.to, raw)
        }
      } catch (e) {
        if (e instanceof ReplyError) throw e
        if (account.kind === 'gmail') {
          if (isMissingScope(e)) throw new SendPermissionMissing(account.id)
          throw e
        }
        if ((e as Error)?.name === 'ReloginRequired') throw e
        throw new ReplyError(smtpErrorMessage(e))
      }
      repo.markReplied(emailId)
      log.info('reply_sent', { emailId, kind: account.kind })
      return { sentAt: repo.getEmail(emailId)?.repliedAt ?? Date.now() }
    } catch (e) {
      if (!(e instanceof ReplyError)) log.error('reply_failed', redactError(e))
      throw e
    } finally {
      sending.delete(emailId)
    }
  }

  return { preview, send }
}

export type ReplyService = ReturnType<typeof createReplyService>
