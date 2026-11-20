import { describe, it, expect } from 'vitest'
import type { gmail_v1 } from '@googleapis/gmail'
import { isAnswered, withTarget } from '../src/main/jobs/thread'
import { gmailWebUrl } from '../src/main/mailview'

const m = (id: string, at: number, from: string, labels: string[] = ['INBOX']): gmail_v1.Schema$Message => ({
  id,
  internalDate: String(at),
  labelIds: labels,
  payload: { headers: [{ name: 'From', value: `X <${from}>` }] }
})

describe('isAnswered', () => {
  it('a later message sent by the owner means answered', () => {
    const t = { messages: [m('a', 1, 'jana@x.cz'), m('b', 2, 'me@gmail.com', ['SENT'])] }
    expect(isAnswered(t, 'a', 'me@gmail.com')).toBe(true)
  })

  it('owner address match also counts (no SENT label)', () => {
    const t = { messages: [m('a', 1, 'jana@x.cz'), m('b', 2, 'ME@gmail.com')] }
    expect(isAnswered(t, 'a', 'me@gmail.com')).toBe(true)
  })

  it('an owner message BEFORE the target is not an answer to it', () => {
    const t = { messages: [m('b', 1, 'me@gmail.com', ['SENT']), m('a', 2, 'jana@x.cz')] }
    expect(isAnswered(t, 'a', 'me@gmail.com')).toBe(false)
  })

  it('IMAP \\Answered flag counts', () => {
    expect(isAnswered({ messages: [m('a', 1, 'jana@x.cz', ['INBOX', 'ANSWERED'])] }, 'a')).toBe(true)
  })

  it('only other people writing → not answered', () => {
    const t = { messages: [m('a', 1, 'jana@x.cz'), m('b', 2, 'petr@x.cz')] }
    expect(isAnswered(t, 'a', 'me@gmail.com')).toBe(false)
  })

  it('withTarget adds a missing target in date order', () => {
    const t = withTarget({ messages: [m('a', 1, 'x@x'), m('c', 3, 'x@x')] }, m('b', 2, 'y@y'))
    expect(t.messages!.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('gmailWebUrl', () => {
  it('selects the account and opens the message', () => {
    expect(gmailWebUrl('me@gmail.com', '18c2f')).toBe('https://mail.google.com/mail/?authuser=me%40gmail.com#all/18c2f')
  })
})
