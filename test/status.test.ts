import { describe, it, expect } from 'vitest'
import { formatEta, formatStatus, formatClock } from '@shared/format'
import { EtaTracker } from '../src/main/jobs/status'

describe('EtaTracker', () => {
  it('undefined until first sample', () => {
    expect(new EtaTracker().etaSec(10)).toBeUndefined()
  })

  it('eta = mean * remaining', () => {
    const t = new EtaTracker()
    t.record(2000)
    t.record(4000)
    expect(t.etaSec(10)).toBe(30)
  })

  it('window keeps last 10', () => {
    const t = new EtaTracker()
    for (let i = 0; i < 10; i++) t.record(100_000)
    for (let i = 0; i < 10; i++) t.record(1000)
    expect(t.etaSec(1)).toBe(1)
  })
})

describe('formatEta', () => {
  it('boundaries 59/60/90', () => {
    expect(formatEta(undefined)).toBe('')
    expect(formatEta(59)).toBe('less than a minute left')
    expect(formatEta(60)).toBe('about 1 min left')
    expect(formatEta(90)).toBe('about 2 min left')
  })
})

describe('formatStatus', () => {
  it('summarizing with eta', () => {
    expect(
      formatStatus({ phase: 'summarizing', accountLabel: 'Account 2', index: 14, total: 40, etaSec: 70 })
    ).toBe('Account 2: reading email 14 of 40, about 1 min left')
  })

  it('drafting', () => {
    expect(formatStatus({ phase: 'drafting', accountLabel: 'Work', index: 1, total: 3 })).toBe(
      'Work: writing draft 1 of 3'
    )
  })

  it('idle with last/next', () => {
    const last = new Date(2026, 10, 17, 10, 42).getTime()
    const next = new Date(2026, 10, 17, 10, 57).getTime()
    expect(formatStatus({ phase: 'idle', lastRunAt: last, nextRunAt: next })).toBe(
      `Last checked ${formatClock(last)} · next at ${formatClock(next)}`
    )
    expect(formatClock(last)).toBe('10:42')
  })

  it('error / offline show message', () => {
    expect(formatStatus({ phase: 'error', message: 'Check your API key in Settings' })).toBe(
      'Check your API key in Settings'
    )
    expect(formatStatus({ phase: 'idle' })).toBe('Idle')
  })
})
