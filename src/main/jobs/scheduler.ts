import { log, redactError } from '../log'

export interface SchedulerDeps<R, O = undefined> {
  run: (opts?: O) => Promise<R>
  intervalMin: () => number
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
}

/** Runs once at start, then every intervalMin minutes. runNow() restarts the interval. Never overlaps (the scanner has its own lock). */
export function createScheduler<R, O = undefined>(deps: SchedulerDeps<R, O>) {
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

  async function tick(opts?: O): Promise<R | undefined> {
    schedule()
    try {
      return await deps.run(opts)
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
    /** Re-arms the timer after stop() without running now (e.g. an app update was refused). */
    resume(): void {
      schedule()
    },
    /** Re-arms the timer with the current interval (after Settings change). */
    reschedule(): void {
      if (next !== null) schedule()
    },
    runNow: (opts?: O): Promise<R | undefined> => tick(opts),
    nextRunAt: (): number | null => next
  }
}
