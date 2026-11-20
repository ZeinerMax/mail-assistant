import type { DraftItem, MailItem } from '@shared/ipc'
import type { StatusEvent, Tag } from '@shared/types'
import { formatClock } from '@shared/format'
import type { Repo } from './db/repo'
import type { RunResult } from './jobs/scan'
import { gmailWebUrl } from './mailview'

const LIST_LIMIT = 500

export function buildMailItems(repo: Repo, f: { tag?: Tag; accountId?: number }): MailItem[] {
  const accounts = new Map(repo.listAccounts().map((a) => [a.id, a]))
  return repo.listEmails({ ...f, limit: LIST_LIMIT }).map((e) => {
    const a = accounts.get(e.accountId)
    return {
      id: e.id,
      accountId: e.accountId,
      accountLabel: a?.label ?? '',
      color: a?.color ?? '#888',
      fromName: e.fromName,
      fromEmail: e.fromEmail,
      subject: e.subject,
      receivedAt: e.receivedAt,
      summary: e.summary,
      tag: e.tag,
      state: e.state,
      hasDraft: repo.hasDraft(e.id),
      accountKind: a?.kind ?? 'gmail',
      answered: e.answered,
      threadSize: e.threadSize,
      webUrl: a && a.kind === 'gmail' ? gmailWebUrl(a.email, e.gmailMessageId) : null
    }
  })
}

export function buildDraftItems(repo: Repo): DraftItem[] {
  const accounts = new Map(repo.listAccounts().map((a) => [a.id, a]))
  return repo.listDrafts().flatMap((d) => {
    const e = repo.getEmail(d.emailId)
    if (!e || e.answered) return [] // already answered: the draft is no longer useful
    const a = accounts.get(e.accountId)
    return [
      {
        id: d.id,
        emailId: e.id,
        accountId: e.accountId,
        accountLabel: a?.label ?? '',
        color: a?.color ?? '#888',
        fromName: e.fromName,
        fromEmail: e.fromEmail,
        subject: e.subject,
        summary: e.summary,
        receivedAt: e.receivedAt,
        body: d.body,
        createdAt: d.createdAt,
        seen: d.seenAt !== null,
        copied: d.copiedAt !== null
      }
    ]
  })
}

/** Status bar text after a run. */
export function finalStatus(
  r: Pick<RunResult, 'offline' | 'stopReason' | 'reloginAccounts'>,
  lastRunAt: number,
  nextRunAt: number | null
): StatusEvent {
  if (r.stopReason === 'api_key_invalid') return { phase: 'error', message: 'Check your API key in Settings' }
  if (r.offline)
    return {
      phase: 'offline',
      message: nextRunAt ? `Offline — will try again at ${formatClock(nextRunAt)}` : 'Offline',
      lastRunAt
    }
  const notes: string[] = []
  for (const label of r.reloginAccounts) notes.push(`${label} needs sign-in`)
  if (r.stopReason === 'cap_emails' || r.stopReason === 'cap_tokens' || r.stopReason === 'cap_drafts')
    notes.push('Per-check limit reached; the rest comes next check')
  return {
    phase: 'idle',
    ...(notes.length ? { message: notes.join(' · ') } : {}),
    lastRunAt,
    ...(nextRunAt ? { nextRunAt } : {})
  }
}
