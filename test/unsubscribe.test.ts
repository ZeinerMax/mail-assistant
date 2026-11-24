import { describe, it, expect, vi } from 'vitest'
import type { gmail_v1 } from '@googleapis/gmail'
import { parseUnsubscribe, splitEntries } from '../src/main/unsubscribe/parse'
import { createUnsubscribeService } from '../src/main/unsubscribe/service'

function msg(headers: Record<string, string>, textBody = ''): gmail_v1.Schema$Message {
  return {
    id: 'm1',
    threadId: 't1',
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      ...(textBody ? { parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(textBody).toString('base64url') } }] } : {})
    }
  }
}

describe('parseUnsubscribe', () => {
  it('splits angle-bracket entries', () => {
    expect(splitEntries('<https://a.test/u>, <mailto:u@a.test>')).toEqual(['https://a.test/u', 'mailto:u@a.test'])
  })

  it('reports one-click only when List-Unsubscribe-Post says so', () => {
    const withPost = parseUnsubscribe(
      msg({ 'List-Unsubscribe': '<https://a.test/u>, <mailto:u@a.test>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    )
    expect(withPost.oneClick).toBe('https://a.test/u')
    expect(withPost.mailto).toEqual({ to: 'u@a.test', subject: 'unsubscribe', body: '' })

    const noPost = parseUnsubscribe(msg({ 'List-Unsubscribe': '<https://a.test/u>' }))
    expect(noPost.oneClick).toBeNull()
    expect(noPost.http).toBe('https://a.test/u')
  })

  it('parses mailto subject/body from the query', () => {
    const t = parseUnsubscribe(msg({ 'List-Unsubscribe': '<mailto:leave@a.test?subject=STOP&body=remove%20me>' }))
    expect(t.mailto).toEqual({ to: 'leave@a.test', subject: 'STOP', body: 'remove me' })
  })

  it('returns all-null when there is no header', () => {
    expect(parseUnsubscribe(msg({}))).toEqual({ oneClick: null, http: null, mailto: null })
  })
})

describe('createUnsubscribeService', () => {
  function harness(message: gmail_v1.Schema$Message, opts: { finder?: (b: string) => Promise<string | null> } = {}) {
    const finished: Array<[number, boolean]> = []
    const repo = {
      getEmail: () => ({ id: 1, accountId: 7, gmailMessageId: 'm1', gmailThreadId: 't1' }),
      getAccount: () => ({ id: 7, kind: 'gmail', email: 'me@a.test' }),
      setFinished: (id: number, v: boolean) => finished.push([id, v])
    }
    const sent: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)
    const svc = createUnsubscribeService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: repo as any,
      openMailbox: async () => ({ users: { messages: { get: async () => ({ data: message }) } } }) as never,
      gmailSender: async () => ({ users: { messages: { send: async (p: Record<string, unknown>) => { sent.push(p); return { data: {} } } } } }) as never,
      smtpFor: () => ({ sendMail: async () => undefined, close: () => undefined }),
      finder: opts.finder ?? null,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    return { svc, fetchImpl, sent, finished }
  }

  it('one-click: POSTs and marks the email done', async () => {
    const { svc, fetchImpl, finished } = harness(
      msg({ 'List-Unsubscribe': '<https://a.test/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    )
    const r = await svc.unsubscribe(1)
    expect(r).toEqual({ method: 'one-click', target: 'https://a.test/u' })
    expect(fetchImpl).toHaveBeenCalledWith('https://a.test/u', expect.objectContaining({ method: 'POST', body: 'List-Unsubscribe=One-Click' }))
    expect(finished).toEqual([[1, true]])
  })

  it('mailto: sends an email from the account', async () => {
    const { svc, sent, finished } = harness(msg({ 'List-Unsubscribe': '<mailto:leave@a.test>' }))
    const r = await svc.unsubscribe(1)
    expect(r).toEqual({ method: 'email', target: 'leave@a.test' })
    expect(sent).toHaveLength(1)
    expect(finished).toEqual([[1, true]])
  })

  it('http only: GETs the link in the background', async () => {
    const { svc, fetchImpl } = harness(msg({ 'List-Unsubscribe': '<https://a.test/u>' }))
    const r = await svc.unsubscribe(1)
    expect(r.method).toBe('web')
    expect(fetchImpl).toHaveBeenCalledWith('https://a.test/u', expect.objectContaining({ method: 'GET' }))
  })

  it('no header: uses the AI finder, then GETs the found link', async () => {
    const finder = vi.fn(async () => 'https://a.test/found')
    const { svc, fetchImpl } = harness(msg({}, 'click here to unsubscribe'), { finder })
    const r = await svc.unsubscribe(1)
    expect(finder).toHaveBeenCalled()
    expect(r).toEqual({ method: 'web-ai', target: 'https://a.test/found' })
    expect(fetchImpl).toHaveBeenCalledWith('https://a.test/found', expect.objectContaining({ method: 'GET' }))
  })

  it('throws a friendly error when nothing is found', async () => {
    const { svc } = harness(msg({}))
    await expect(svc.unsubscribe(1)).rejects.toThrow(/unsubscribe/i)
  })
})
