import nodemailer from 'nodemailer'

export interface SmtpSettings { host: string; port: number; user: string }

export function defaultSmtp(imapHost: string): { host: string; port: number } {
  return { host: imapHost.replace(/^imap\./i, 'smtp.'), port: 465 }
}

export interface SmtpTransportLike {
  sendMail(m: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<unknown>
  close(): void
}

export function makeSmtpTransport(s: SmtpSettings, password: string): SmtpTransportLike {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.port === 465,
    requireTLS: s.port !== 465,
    auth: { user: s.user, pass: password },
    logger: false,
    connectionTimeout: 20_000,
    socketTimeout: 60_000
  })
}

function bareAddresses(to: string): string[] {
  const out: string[] = []
  // split on commas outside quotes and angle brackets
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of to) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if (ch === ',' && !quoted && !angle) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
    .map((p) => (p.match(/<([^<>]+)>\s*$/)?.[1] ?? p).trim())
    .filter(Boolean)
}

export async function sendViaSmtp(t: SmtpTransportLike, from: string, to: string, raw: Buffer): Promise<void> {
  try {
    await t.sendMail({ envelope: { from, to: bareAddresses(to) }, raw })
  } finally {
    t.close()
  }
}

export function smtpErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  if (code === 'EAUTH') return 'The outgoing mail server rejected the user name or password.'
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ENOTFOUND')
    return 'Could not connect to the outgoing mail server. Check its address and port in Accounts.'
  return 'The outgoing mail server did not accept the email.'
}
