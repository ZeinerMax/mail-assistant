import type { gmail_v1 } from '@googleapis/gmail'

/** A reply ready to be sent: recipient, subject, threading headers and plain-text body. */
export interface Reply {
  to: string
  subject: string
  inReplyTo: string | null
  references: string[]
  text: string
}

/** Error whose message is safe to show to the user. */
export class ReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyError'
  }
}

function header(m: gmail_v1.Schema$Message, name: string): string {
  const h = m.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return (h?.value ?? '').trim()
}

const addressOf = (raw: string): string => (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase()

export function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`.trimEnd()
}

export function buildReply(original: gmail_v1.Schema$Message, ownerEmail: string, text: string): Reply {
  const body = text.trimEnd()
  if (!body.trim()) throw new ReplyError('Write a reply first.')

  const from = header(original, 'From')
  const to =
    from && addressOf(from) === ownerEmail.trim().toLowerCase()
      ? header(original, 'To')
      : header(original, 'Reply-To') || from
  if (!to) throw new ReplyError('Could not find who to reply to.')

  const messageId = header(original, 'Message-ID')
  const refs = header(original, 'References').split(/\s+/).filter(Boolean)
  return {
    to,
    subject: replySubject(header(original, 'Subject')),
    inReplyTo: messageId || null,
    references: messageId ? [...refs, messageId] : [],
    text: body
  }
}
