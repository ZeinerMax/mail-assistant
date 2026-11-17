import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { gmail_v1 } from '@googleapis/gmail'
import { buildDraftContext, draftReply, DraftFailed } from '../src/main/ai/draft'
import { DRAFT_SYSTEM } from '../src/main/ai/prompts'
import { DEFAULT_SETTINGS } from '../src/main/config'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const m = (id: string, from: string, text: string, t: number): gmail_v1.Schema$Message => ({
  id,
  internalDate: String(t),
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Trip' }], body: { data: b64(text) } }
})

const thread: gmail_v1.Schema$Thread = {
  id: 't1',
  messages: [
    m('m1', 'Jana <jana@x.cz>', 'OLDEST ' + 'a'.repeat(3000), 1),
    m('m2', 'Me <me@gmail.com>', 'MIDDLE ' + 'b'.repeat(3000), 2),
    m('m3', 'Jana <jana@x.cz>', 'TARGETTEXT Can you come on Saturday?', 3)
  ]
}

describe('buildDraftContext', () => {
  it('keeps target + newest earlier messages within maxChars', () => {
    const ctx = buildDraftContext(thread, 'm3', 4000, 'me@gmail.com')
    expect(ctx).toContain('TARGETTEXT')
    expect(ctx).toContain('MIDDLE')
    expect(ctx).not.toContain('OLDEST')
  })

  it('each message wrapped with its own nonce, target marked, owner marked, oldest first', () => {
    const ctx = buildDraftContext(thread, 'm3', 20000, 'me@gmail.com')
    const nonces = [...ctx.matchAll(/<email_([0-9a-f]{16})>/g)].map((x) => x[1])
    expect(nonces).toHaveLength(3)
    expect(new Set(nonces).size).toBe(3)
    expect(ctx.indexOf('OLDEST')).toBeLessThan(ctx.indexOf('TARGETTEXT'))
    expect(ctx).toMatch(/TARGET — reply to this message[\s\S]*TARGETTEXT/)
    expect(ctx).toContain('(the account owner)')
  })

  it('throws if target not in thread', () => {
    expect(() => buildDraftContext(thread, 'nope', 1000)).toThrow()
  })
})

function client(response: Record<string, unknown>) {
  const seen: Record<string, unknown>[] = []
  const c = {
    beta: {
      messages: {
        create: async (p: Record<string, unknown>) => {
          seen.push(p)
          return response
        }
      }
    }
  } as unknown as Anthropic
  return { c, seen }
}

describe('draftReply', () => {
  it('request params: draft model, adaptive thinking, effort medium, fallback beta, no tools, max_tokens 16000', async () => {
    const { c, seen } = client({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Ahoj Jano,\n\nsobota ' },
        { type: 'text', text: '[confirm time].\n\nMěj se' }
      ],
      usage: { input_tokens: 900, output_tokens: 200 }
    })
    const r = await draftReply(c, 'CTX', DEFAULT_SETTINGS)
    expect(r).toEqual({ body: 'Ahoj Jano,\n\nsobota [confirm time].\n\nMěj se', usage: { input_tokens: 900, output_tokens: 200 } })
    const p = seen[0]
    expect(p).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: DRAFT_SYSTEM
    })
    expect(p.tools).toBeUndefined()
  })

  it('refusal → DraftFailed(refusal)', async () => {
    const { c } = client({ stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } })
    await expect(draftReply(c, 'CTX', DEFAULT_SETTINGS)).rejects.toMatchObject({ name: 'DraftFailed', reason: 'refusal' })
  })

  it('no text → DraftFailed(empty)', async () => {
    const { c } = client({ stop_reason: 'end_turn', content: [{ type: 'text', text: '  ' }], usage: { input_tokens: 5, output_tokens: 1 } })
    const e = await draftReply(c, 'CTX', DEFAULT_SETTINGS).catch((x) => x)
    expect(e).toBeInstanceOf(DraftFailed)
    expect(e.reason).toBe('empty')
  })
})
