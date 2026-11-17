import type { Settings } from '@shared/types'
import type { TokenUsage } from './triage'
import { log } from '../log'

/** Estimated cost in USD from the editable price table (USD per million tokens). */
export function costUsd(model: string, u: TokenUsage, prices: Settings['prices']): number {
  const p = prices[model]
  if (!p) {
    log.warn('price_missing', { model })
    return 0
  }
  return (u.input_tokens * p.in + u.output_tokens * p.out) / 1_000_000
}

/** Hard per-run token cap (input + output, all models). */
export class RunBudget {
  private total = 0
  constructor(private maxTokens: number) {}
  add(u: TokenUsage): void {
    this.total += u.input_tokens + u.output_tokens
  }
  get used(): number {
    return this.total
  }
  get exhausted(): boolean {
    return this.total >= this.maxTokens
  }
}
