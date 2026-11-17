import { describe, it, expect } from 'vitest'
import type { gmail_v1 } from '@googleapis/gmail'
import { extractHeaders, extractText, stripQuotes, cleanBody, htmlToText } from '../src/main/google/clean'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

const msg = (payload: gmail_v1.Schema$MessagePart, extra: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message => ({
  id: 'm1',
  threadId: 't1',
  internalDate: '1700000000000',
  payload,
  ...extra
})

const headers = (h: Record<string, string>): gmail_v1.Schema$MessagePartHeader[] =>
  Object.entries(h).map(([name, value]) => ({ name, value }))

describe('extractHeaders', () => {
  it('"Name <a@b.c>" and bare "a@b.c" From headers parsed', () => {
    const a = extractHeaders(msg({ headers: headers({ From: '"Jana Nováková" <jana@example.cz>', Subject: 'Oběd' }) }))
    expect(a).toEqual({ fromName: 'Jana Nováková', fromEmail: 'jana@example.cz', subject: 'Oběd', receivedAt: 1700000000000 })
    const b = extractHeaders(msg({ headers: headers({ From: 'bob@example.com', Subject: 'Hi' }) }))
    expect(b.fromName).toBe('')
    expect(b.fromEmail).toBe('bob@example.com')
  })

  it('missing subject → "(no subject)"', () => {
    expect(extractHeaders(msg({ headers: headers({ From: 'a@b.c' }) })).subject).toBe('(no subject)')
  })
})

describe('extractText', () => {
  it('prefers text/plain', () => {
    const m = msg({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Plain hello') } },
        { mimeType: 'text/html', body: { data: b64('<p>HTML hello</p>') } }
      ]
    })
    expect(extractText(m)).toBe('Plain hello')
  })

  it('html-only becomes readable text without tags/scripts/styles', () => {
    const html =
      '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
      '<body><p>Hello&nbsp;Jana,</p><p>See you at <b>5</b> &amp; bring cake.</p><br>Bye</body></html>'
    const t = extractText(msg({ mimeType: 'text/html', body: { data: b64(html) } }))
    expect(t).toContain('Hello Jana,')
    expect(t).toContain('See you at 5 & bring cake.')
    expect(t).not.toMatch(/<|color:red|alert/)
  })

  it('attachments ignored', () => {
    const m = msg({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Body text') } },
        { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'att1', data: b64('SECRET ATTACHMENT') } },
        { mimeType: 'application/pdf', filename: 'x.pdf', body: { attachmentId: 'att2' } }
      ]
    })
    expect(extractText(m)).toBe('Body text')
  })

  it('nested multipart is walked', () => {
    const m = msg({
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Deep') } }] }]
    })
    expect(extractText(m)).toBe('Deep')
  })

  it('empty body → ""', () => {
    expect(extractText(msg({ mimeType: 'text/plain', body: { size: 0 } }))).toBe('')
  })
})

describe('stripQuotes', () => {
  it('strips "On <date>, <name> wrote:" block', () => {
    const t = 'Sounds good!\n\nOn Mon, 3 Nov 2026 at 10:00, Jana <jana@x.cz> wrote:\n> old text\n> more'
    expect(stripQuotes(t)).toBe('Sounds good!')
  })

  it('strips Czech "Dne … napsal(a):" block', () => {
    const t = 'Ano, platí.\n\nDne po 3. 11. 2026 10:00 uživatel Jana <jana@x.cz> napsal:\n> původní'
    expect(stripQuotes(t)).toBe('Ano, platí.')
  })

  it('strips "-----Original Message-----"', () => {
    const t = 'Thanks.\n-----Original Message-----\nFrom: Bob\nSent: Monday\nOld stuff'
    expect(stripQuotes(t)).toBe('Thanks.')
  })

  it('strips Outlook From:/Sent: header block', () => {
    const t = 'OK.\n\nFrom: Bob Smith <bob@x.com>\nSent: Monday, November 3, 2026 10:00\nTo: Me\nSubject: Re: x\n\nOld'
    expect(stripQuotes(t)).toBe('OK.')
  })

  it('strips leading ">" lines', () => {
    expect(stripQuotes('New line\n> quoted\n>> deeper\nAfter')).toBe('New line\nAfter')
  })

  it('keeps text when the whole message would be stripped', () => {
    expect(stripQuotes('> only quoted')).toBe('> only quoted')
  })
})

describe('cleanBody', () => {
  it('truncates at maxChars with marker', () => {
    const m = msg({ mimeType: 'text/plain', body: { data: b64('x'.repeat(5000)) } })
    const out = cleanBody(m, 1000)
    expect(out.length).toBeLessThanOrEqual(1000 + '\n[…truncated]'.length)
    expect(out.endsWith('\n[…truncated]')).toBe(true)
  })

  it('huge html newsletter stays within limit', () => {
    const html = '<table>' + '<tr><td>Deal of the day &mdash; 50% off</td></tr>'.repeat(2000) + '</table>'
    const out = cleanBody(msg({ mimeType: 'text/html', body: { data: b64(html) } }), 4000)
    expect(out.length).toBeLessThanOrEqual(4000 + 20)
    expect(out).toContain('Deal of the day')
  })

  it('collapses excessive blank lines', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })
})
