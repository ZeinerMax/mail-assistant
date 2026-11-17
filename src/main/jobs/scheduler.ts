import { log, redactError } from '../log'

export interface SchedulerDeps<R> {
  run: () => Promise<R>
  intervalMin: () => number
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
}

/** Runs once at start, then every intervalMin minutes. runNow() restarts the interval. Never overlaps (the scanner has its own lock). */
export function createScheduler<R>(deps: SchedulerDeps<R>) {
  let timer: unknown = null
  let next: number | null = null

  function schedule(): void {
    if (timer !== null) deps.clearTimer(timer)
    const ms = deps.intervalMin() * 60_000
    next = deps.now() + ms
    timer = deps.setTimer(() => {
      timer = null
      void tick()
    }, ms)
  }

  async function tick(): Promise<R | undefined> {
    schedule()
    try {
      return await deps.run()
    } catch (e) {
      log.error('scheduled_run_failed', redactError(e))
      return undefined
    }
  }

  return {
    start(): void {
      void tick()
    },
    stop(): void {
      if (timer !== null) deps.clearTimer(timer)
      timer = null
      next = null
    },
    /** Re-arms the timer with the current interval (after Settings change). */
    reschedule(): void {
      if (next !== null) schedule()
    },
    runNow: (): Promise<R | undefined> => tick(),
    nextRunAt: (): number | null => next
  }
}
