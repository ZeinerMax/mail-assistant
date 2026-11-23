import { describe, it, expect, vi } from 'vitest'
import { simpleParser } from 'mailparser'
import { buildMime } from '../src/main/send/mime'
import { sendViaGmail } from '../src/main/send/gmail-send'
import { defaultSmtp, sendViaSmtp, smtpErrorMessage, type SmtpTransportLike } from '../src/main/send/smtp'

const reply = {
  to: 'Jana <jana@x.cz>',
  subject: 'Re: Schůzka v pátek',
  inReplyTo: '<a@x.cz>',
  references: ['<0@x.cz>', '<a@x.cz>'],
  text: 'Dobrý den, děkuji.'
}

describe('buildMime', () => {
  it('round-trips subject, text and threading headers', async () => {
    const p = await simpleParser(await buildMime('me@x.cz', reply))
    expect(p.subject).toBe(reply.subject)
    expect(p.text?.trim()).toBe(reply.text)
    expect(p.inReplyTo).toBe('<a@x.cz>')
    expect(p.references).toEqual(['<0@x.cz>', '<a@x.cz>'])
  })
  it('does not let CR/LF in the subject create a header', async () => {
    const raw = (await buildMime('me@x.cz', { ...reply, subject: 'Hi\r\nBcc: evil@x.cz' })).toString()
    const head = raw.split('\r\n\r\n')[0]
    expect(head.split('\r\n').some((l) => /^Bcc:/i.test(l))).toBe(false)
  })
})

describe('sendViaGmail', () => {
  it('sends the raw message on the thread', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'm1' } })
    const raw = Buffer.from('hello\r\nworld')
    await sendViaGmail({ users: { messages: { send } } }, raw, 't1')
    expect(send).toHaveBeenCalledTimes(1)
    const arg = send.mock.calls[0][0]
    expect(arg.userId).toBe('me')
    expect(arg.requestBody.threadId).toBe('t1')
    expect(Buffer.from(arg.requestBody.raw, 'base64url')).toEqual(raw)
  })
})

describe('smtp', () => {
  it('defaults', () => {
    expect(defaultSmtp('imap.seznam.cz')).toEqual({ host: 'smtp.seznam.cz', port: 465 })
    expect(defaultSmtp('mail.webglobe.cz')).toEqual({ host: 'mail.webglobe.cz', port: 465 })
  })
  it('uses the bare address in the envelope and always closes', async () => {
    const t: SmtpTransportLike = { sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() }
    await sendViaSmtp(t, 'me@x.cz', 'Jana <jana@x.cz>', Buffer.from('x'))
    expect(t.sendMail).toHaveBeenCalledWith({ envelope: { from: 'me@x.cz', to: ['jana@x.cz'] }, raw: Buffer.from('x') })
    expect(t.close).toHaveBeenCalled()
  })
  it('handles several recipients', async () => {
    const t: SmtpTransportLike = { sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() }
    await sendViaSmtp(t, 'me@x.cz', 'Jana <jana@x.cz>, pavel@x.cz', Buffer.from('x'))
    expect((t.sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0].envelope.to).toEqual(['jana@x.cz', 'pavel@x.cz'])
  })
  it('closes when sendMail rejects', async () => {
    const t: SmtpTransportLike = { sendMail: vi.fn().mockRejectedValue(new Error('no')), close: vi.fn() }
    await expect(sendViaSmtp(t, 'me@x.cz', 'a@x.cz', Buffer.from('x'))).rejects.toThrow('no')
    expect(t.close).toHaveBeenCalled()
  })
  it('maps errors to messages', () => {
    expect(smtpErrorMessage({ code: 'EAUTH' })).toBe('The outgoing mail server rejected the user name or password.')
    expect(smtpErrorMessage({ code: 'ETIMEDOUT' })).toBe('Could not connect to the outgoing mail server. Check its address and port in Accounts.')
    expect(smtpErrorMessage(new Error('x'))).toBe('The outgoing mail server did not accept the email.')
  })
})
