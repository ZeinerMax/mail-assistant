import type { gmail_v1 } from '@googleapis/gmail'

// Turns a Gmail message into the minimum text worth sending to the model:
// plain text only, no attachments, no quoted reply chain, no signature, truncated.
// Output lives in memory only — never stored.

export const TRUNCATION_MARK = '\n[…truncated]'

type Part = gmail_v1.Schema$MessagePart

function header(m: gmail_v1.Schema$Message, name: string): string {
  const h = m.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return (h?.value ?? '').trim()
}

export function parseFrom(raw: string): { fromName: string; fromEmail: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { fromName: m[1].trim(), fromEmail: m[2].trim() }
  return { fromName: '', fromEmail: raw.trim() }
}

export function extractHeaders(m: gmail_v1.Schema$Message): {
  fromName: string
  fromEmail: string
  subject: string
  receivedAt: number
} {
  const subject = header(m, 'Subject') || '(no subject)'
  const internal = Number(m.internalDate)
  const receivedAt = Number.isFinite(internal) && internal > 0 ? internal : Date.parse(header(m, 'Date')) || Date.now()
  return { ...parseFrom(header(m, 'From')), subject, receivedAt }
}

const decode = (data?: string | null): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '')
const isAttachment = (p: Part): boolean => !!p.filename || !!p.body?.attachmentId

function findPart(p: Part | undefined, mime: string): Part | undefined {
  if (!p || isAttachment(p)) return undefined
  if (p.mimeType === mime && p.body?.data) return p
  for (const child of p.parts ?? []) {
    const hit = findPart(child, mime)
    if (hit) return hit
  }
  return undefined
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', euro: '€', zwnj: ''
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function htmlToText(html: string): string {
  const t = html
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Gmail puts the quoted thread in a gmail_quote container at the end.
    .replace(/<div[^>]*class="?[^">]*gmail_quote[\s\S]*$/i, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|section|article)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  return tidy(decodeEntities(t))
}

export function extractText(m: gmail_v1.Schema$Message): string {
  const plain = findPart(m.payload, 'text/plain')
  if (plain) return tidy(decode(plain.body?.data))
  const html = findPart(m.payload, 'text/html')
  if (html) return htmlToText(decode(html.body?.data))
  return ''
}

const CUT_MARKERS: RegExp[] = [
  /^On\b.{3,300}\bwrote:\s*$/i, // Gmail/Apple: "On Mon, 3 Nov 2026, Jana <…> wrote:"
  /^Dne\b.{3,300}\bnapsal(a|\(a\))?:\s*$/i, // Czech Gmail/Seznam
  /^Am\b.{3,300}\bschrieb\b.*:\s*$/i, // German
  /^-{2,}\s*(Original Message|Původní zpráva|Forwarded message|Přeposlaná zpráva)\s*-{2,}/i,
  /^_{10,}\s*$/, // Outlook separator line
  /^-- $/ // standard signature delimiter
]

function isOutlookHeaderBlock(lines: string[], i: number): boolean {
  if (!/^(From|Od):\s/i.test(lines[i])) return false
  return lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date|Odesláno|Datum):\s/i.test(l))
}

export function stripQuotes(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line
    if (CUT_MARKERS.some((re) => re.test(line) || (/^(On|Dne|Am)\b/i.test(line) && re.test(joined))) || isOutlookHeaderBlock(lines, i)) {
      cut = i
      break
    }
  }
  const kept = lines
    .slice(0, cut)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim()
  return kept || text.trim()
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd() + TRUNCATION_MARK
}

export function cleanBody(m: gmail_v1.Schema$Message, maxChars: number): string {
  return truncate(tidy(stripQuotes(extractText(m))), maxChars)
}
