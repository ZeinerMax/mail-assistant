import { describe, it, expect } from 'vitest'
import type { gmail_v1 } from '@googleapis/gmail'
import { buildReply, replySubject, ReplyError } from '../src/main/send/compose'

const msg = (h: Record<string, string>): gmail_v1.Schema$Message => ({
  payload: { headers: Object.entries(h).map(([name, value]) => ({ name, value })) }
})

describe('replySubject', () => {
  it.each([
    ['Lunch', 'Re: Lunch'],
    ['Re: Lunch', 'Re: Lunch'],
    ['RE: Lunch', 'RE: Lunch'],
    ['AW: Lunch', 'Re: AW: Lunch'],
    ['', 'Re:']
  ])('%j -> %j', (a, b) => expect(replySubject(a)).toBe(b))
})

describe('buildReply', () => {
  it('uses Reply-To when present', () => {
    expect(buildReply(msg({ From: 'a@x.cz', 'Reply-To': 'list@x.cz' }), 'me@x.cz', 'hi').to).toBe('list@x.cz')
  })
  it('falls back to From', () => {
    expect(buildReply(msg({ From: 'Jana Nová <jana@x.cz>' }), 'me@x.cz', 'hi').to).toBe('Jana Nová <jana@x.cz>')
  })
  it('replies to To when the owner sent the message', () => {
    expect(buildReply(msg({ From: 'me@x.cz', To: 'bob@y.cz' }), 'ME@x.cz', 'hi').to).toBe('bob@y.cz')
  })
  it('builds threading headers', () => {
    const r = buildReply(msg({ From: 'a@x.cz', 'Message-ID': '<m2@x>', References: '<m0@x> <m1@x>' }), 'me@x.cz', 'hi')
    expect(r.inReplyTo).toBe('<m2@x>')
    expect(r.references).toEqual(['<m0@x>', '<m1@x>', '<m2@x>'])
  })
  it('has empty threading without Message-ID', () => {
    const r = buildReply(msg({ From: 'a@x.cz' }), 'me@x.cz', 'hi')
    expect(r.inReplyTo).toBeNull()
    expect(r.references).toEqual([])
  })
  it('sets the subject', () => {
    expect(buildReply(msg({ From: 'a@x.cz', Subject: 'Lunch' }), 'me@x.cz', 'hi').subject).toBe('Re: Lunch')
  })
  it('trims text at the end only', () => {
    expect(buildReply(msg({ From: 'a@x.cz' }), 'me@x.cz', '  hi\n\n ').text).toBe('  hi')
  })
  it('rejects empty text', () => {
    expect(() => buildReply(msg({ From: 'a@x.cz' }), 'me@x.cz', ' \n ')).toThrow(new ReplyError('Write a reply first.'))
  })
  it('rejects a missing recipient', () => {
    expect(() => buildReply(msg({}), 'me@x.cz', 'hi')).toThrow('Could not find who to reply to.')
    expect(() => buildReply(msg({}), 'me@x.cz', 'hi')).toThrow(ReplyError)
  })
})
