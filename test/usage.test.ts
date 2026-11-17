import { describe, it, expect } from 'vitest'
import { costUsd, RunBudget } from '../src/main/ai/usage'
import { DEFAULT_SETTINGS } from '../src/main/config'

const prices = DEFAULT_SETTINGS.prices

describe('usage', () => {
  it('haiku 1M in + 1M out = 0.60', () => {
    expect(costUsd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, prices)).toBeCloseTo(0.6)
  })

  it('sonnet 1000 in / 1000 out = 0.012', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 1000 }, prices)).toBeCloseTo(0.012)
  })

  it('unknown model costs 0', () => {
    expect(costUsd('mystery', { input_tokens: 5, output_tokens: 5 }, prices)).toBe(0)
  })

  it('budget exhausted at >= maxTokens', () => {
    const b = new RunBudget(100)
    b.add({ input_tokens: 60, output_tokens: 30 })
    expect(b.exhausted).toBe(false)
    expect(b.used).toBe(90)
    b.add({ input_tokens: 10, output_tokens: 0 })
    expect(b.exhausted).toBe(true)
  })
})
