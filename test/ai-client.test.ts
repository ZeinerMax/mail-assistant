import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { testApiKey, createAnthropic } from '../src/main/ai/client'

const fakeClient = (impl: () => Promise<unknown>): Anthropic =>
  ({ messages: { create: impl } }) as unknown as Anthropic

describe('anthropic client helpers', () => {
  it('createAnthropic uses maxRetries 1', () => {
    const c = createAnthropic('sk-ant-test')
    expect(c.maxRetries).toBe(1)
  })

  it('testApiKey success → ok', async () => {
    let params: Record<string, unknown> | undefined
    const c = fakeClient(async (...args: unknown[]) => {
      params = args[0] as Record<string, unknown>
      return { content: [] }
    })
    expect(await testApiKey(c as Anthropic, 'claude-haiku-5-5')).toEqual({ ok: true })
    expect(params).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16 })
  })

  it('testApiKey 401 → Invalid API key', async () => {
    const c = fakeClient(async () => {
      throw new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers())
    })
    expect(await testApiKey(c, 'm')).toEqual({ ok: false, error: 'Invalid API key' })
  })

  it('testApiKey other errors → Could not reach Anthropic', async () => {
    const c = fakeClient(async () => {
      throw new Anthropic.APIConnectionError({ message: 'offline' })
    })
    expect(await testApiKey(c, 'm')).toEqual({ ok: false, error: 'Could not reach Anthropic' })
  })
})
