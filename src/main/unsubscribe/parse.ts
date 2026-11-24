import type { gmail_v1 } from '@googleapis/gmail'

// Reads the standard unsubscribe headers (RFC 2369 List-Unsubscribe and RFC 8058
// List-Unsubscribe-Post) off a message. Pure: no network, no storage.

export interface UnsubTargets {
  /** An https URL that supports one-click unsubscribe (RFC 8058): POST to it, no user step. */
  oneClick: string | null
  /** A plain https(s) link to open/GET when one-click is not offered. */
  http: string | null
  /** A mailto unsubscribe: send a short email here. */
  mailto: { to: string; subject: string; body: string } | null
}

function header(m: gmail_v1.Schema$Message, name: string): string {
  const h = m.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return (h?.value ?? '').trim()
}

/** Pull the `<...>` entries out of a List-Unsubscribe header value. */
export function splitEntries(listUnsubscribe: string): string[] {
  const out: string[] = []
  const re = /<([^>]+)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(listUnsubscribe))) out.push(m[1].trim())
  return out
}

function parseMailto(entry: string): { to: string; subject: string; body: string } | null {
  if (!/^mailto:/i.test(entry)) return null
  const rest = entry.slice('mailto:'.length)
  const [addr, query = ''] = rest.split('?')
  const to = decodeURIComponent(addr).trim()
  if (!to) return null
  const params = new URLSearchParams(query)
  return {
    to,
    subject: (params.get('subject') ?? 'unsubscribe').trim() || 'unsubscribe',
    body: (params.get('body') ?? '').trim()
  }
}

export function parseUnsubscribe(m: gmail_v1.Schema$Message): UnsubTargets {
  const entries = splitEntries(header(m, 'List-Unsubscribe'))
  const oneClickAllowed = /one-?click/i.test(header(m, 'List-Unsubscribe-Post'))

  let http: string | null = null
  let mailto: UnsubTargets['mailto'] = null
  for (const e of entries) {
    if (/^https?:\/\//i.test(e)) {
      if (!http) http = e
    } else {
      const mt = parseMailto(e)
      if (mt && !mailto) mailto = mt
    }
  }
  return { oneClick: oneClickAllowed ? http : null, http, mailto }
}
