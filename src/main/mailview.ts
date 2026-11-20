import type { gmail_v1 } from '@googleapis/gmail'
import type { FullMessage } from '@shared/ipc'
import type { EmailRow } from '@shared/types'
import { extractHeaders, extractText, stripQuotes } from './google/clean'
import { getMessage, type GmailLike } from './google/gmail'
import { loadThread } from './jobs/scan'

// Full email text for the reader view. Fetched live from Gmail/IMAP when the user opens it,
// returned to the window and never written to the database or logs.

const MAX_CHARS = 200_000

function header(m: gmail_v1.Schema$Message, name: string): string {
  return (m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '').trim()
}

function toFull(m: gmail_v1.Schema$Message, opts: { ownerEmail?: string; targetId: string; stripQuoted: boolean }): FullMessage {
  const h = extractHeaders(m)
  const raw = extractText(m)
  const text = (opts.stripQuoted ? stripQuotes(raw) : raw).slice(0, MAX_CHARS)
  const owner = opts.ownerEmail?.toLowerCase()
  return {
    id: m.id ?? '',
    fromName: h.fromName,
    fromEmail: h.fromEmail,
    to: header(m, 'To'),
    date: h.receivedAt,
    subject: h.subject,
    text: text || '(This email has no text content.)',
    fromOwner: (m.labelIds ?? []).includes('SENT') || (!!owner && h.fromEmail.toLowerCase() === owner),
    isTarget: m.id === opts.targetId
  }
}

export async function readMessage(gmail: GmailLike, row: EmailRow, ownerEmail?: string): Promise<FullMessage> {
  const m = await getMessage(gmail, row.gmailMessageId)
  return toFull(m, { ownerEmail, targetId: row.gmailMessageId, stripQuoted: false })
}

/** Whole conversation, oldest first; quoted earlier messages are removed from each message to avoid repeats. */
export async function readConversation(gmail: GmailLike, row: EmailRow, ownerEmail?: string): Promise<FullMessage[]> {
  const thread = await loadThread(gmail, row)
  return (thread.messages ?? []).map((m) => toFull(m, { ownerEmail, targetId: row.gmailMessageId, stripQuoted: true }))
}

/**
 * Gmail web links. PARTLY VERIFIED: Gmail opens "#all/<id>" for both a message id and a thread id
 * (the hex ids the Gmail API returns); `authuser` selects the right signed-in Google account.
 */
export function gmailWebUrl(accountEmail: string, id: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail)}#all/${encodeURIComponent(id)}`
}
