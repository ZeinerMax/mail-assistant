import MailComposer from 'nodemailer/lib/mail-composer'
import type { Reply } from './compose'

const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ')

/** Plain-text reply MIME; threading headers set when present. */
export async function buildMime(from: string, r: Reply): Promise<Buffer> {
  const headers: Record<string, string> = {}
  if (r.inReplyTo) headers['In-Reply-To'] = clean(r.inReplyTo)
  if (r.references.length) headers['References'] = r.references.map(clean).join(' ')
  const mail = new MailComposer({ from: clean(from), to: clean(r.to), subject: clean(r.subject), text: r.text, headers })
  return mail.compile().build()
}

/** A one-off plain-text message (e.g. a mailto unsubscribe); not part of any thread. */
export async function buildSimpleMime(m: { from: string; to: string; subject: string; text: string }): Promise<Buffer> {
  const mail = new MailComposer({ from: clean(m.from), to: clean(m.to), subject: clean(m.subject), text: m.text })
  return mail.compile().build()
}
