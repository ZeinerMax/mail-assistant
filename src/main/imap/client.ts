import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { ImapSettings } from '@shared/types'
import type { ImapClientLike, ParsedLike } from './source'

// VERIFIED against imapflow 2.10 types.d.ts: host, port, secure, doSTARTTLS, auth {user, pass}, logger,
// connectionTimeout, greetingTimeout, socketTimeout, disableAutoIdle. TLS certificates are verified (Node default).
export function makeImapClient(s: ImapSettings, password: string): ImapClientLike {
  const secure = s.port === 993
  return new ImapFlow({
    host: s.host,
    port: s.port,
    secure,
    // On other ports require STARTTLS, so the password never travels unencrypted.
    ...(secure ? {} : { doSTARTTLS: true }),
    auth: { user: s.user, pass: password },
    logger: false, // imapflow logs would contain addresses and subjects
    disableAutoIdle: true,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000
  }) as unknown as ImapClientLike
}

/** Parses a raw message in memory. Images/attachments are not converted or kept. */
export async function parseMail(source: Buffer): Promise<ParsedLike> {
  const p = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true })
  return {
    from: p.from ? { value: p.from.value.map((v) => ({ name: v.name, address: v.address })) } : undefined,
    to: Array.isArray(p.to) ? p.to.map((t) => ({ text: t.text })) : p.to ? { text: p.to.text } : undefined,
    subject: p.subject,
    date: p.date,
    messageId: p.messageId,
    inReplyTo: p.inReplyTo,
    references: p.references,
    text: p.text,
    html: p.html
  }
}
