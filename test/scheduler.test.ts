import { describe, it, expect } from 'vitest'
import { createScheduler } from '../src/main/jobs/scheduler'

/** Manual fake clock: timers fire only when advance() passes them. */
function clock() {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const target = t + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        t = next[1].at
        next[1].fn()
        await new Promise((r) => setTimeout(r, 0))
      }
      t = target
    },
    pending: () => timers.size
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('scheduler', () => {
  it('runs on start then every interval', async () => {
    const c = clock()
    let runs = 0
    const s = createScheduler({ run: async () => void runs++, intervalMin: () => 15, ...c })
    s.start()
    await flush()
    expect(runs).toBe(1)
    expect(s.nextRunAt()).toBe(15 * 60_000)
    await c.advance(15 * 60_000)
    expect(runs).toBe(2)
    await c.advance(15 * 60_000)
    expect(runs).toBe(3)
  })

  it('runNow runs immediately and restarts the interval', async () => {
    const c = clock()
    let runs = 0
    const s = createScheduler({ run: async () => void runs++, intervalMin: () => 10, ...c })
    s.start()
    await flush()
    await c.advance(5 * 60_000)
    await s.runNow()
    expect(runs).toBe(2)
    expect(s.nextRunAt()).toBe(15 * 60_000)
    expect(c.pending()).toBe(1)
  })

  it('interval change reschedules', async () => {
    const c = clock()
    let runs = 0
    let interval = 15
    const s = createScheduler({ run: async () => void runs++, intervalMin: () => interval, ...c })
    s.start()
    await flush()
    interval = 5
    s.reschedule()
    expect(s.nextRunAt()).toBe(5 * 60_000)
    await c.advance(5 * 60_000)
    expect(runs).toBe(2)
  })

  it('a throwing run does not stop the schedule', async () => {
    const c = clock()
    let runs = 0
    const s = createScheduler({
      run: async () => {
        runs++
        throw new Error('boom')
      },
      intervalMin: () => 15,
      ...c
    })
    s.start()
    await flush()
    await c.advance(15 * 60_000)
    expect(runs).toBe(2)
  })

  it('resume re-arms the timer without running at once', async () => {
    const c = clock()
    let runs = 0
    const s = createScheduler({ run: async () => void runs++, intervalMin: () => 15, ...c })
    s.start()
    await flush()
    s.stop()
    s.resume()
    await flush()
    expect(runs).toBe(1)
    expect(s.nextRunAt()).toBe(15 * 60_000)
    await c.advance(15 * 60_000)
    expect(runs).toBe(2)
  })

  it('stop cancels timers', async () => {
    const c = clock()
    const s = createScheduler({ run: async () => {}, intervalMin: () => 15, ...c })
    s.start()
    await flush()
    s.stop()
    expect(c.pending()).toBe(0)
    expect(s.nextRunAt()).toBeNull()
  })
})
