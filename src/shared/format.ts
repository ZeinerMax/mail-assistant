import type { StatusEvent } from './types'

/** Times are approximate on purpose: the spec asks to show ETA as an estimate. */
export function formatEta(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec)) return ''
  if (sec < 60) return 'less than a minute left'
  return `about ${Math.round(sec / 60)} min left`
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatStatus(e: StatusEvent): string {
  const who = e.accountLabel ? `${e.accountLabel}: ` : ''
  const of = e.index !== undefined && e.total !== undefined ? ` ${e.index} of ${e.total}` : ''
  const eta = formatEta(e.etaSec)
  const withEta = (s: string): string => (eta ? `${s}, ${eta}` : s)
  switch (e.phase) {
    case 'listing':
      return `${who}checking for new email…`
    case 'summarizing':
      return withEta(`${who}reading email${of}`)
    case 'drafting':
      return withEta(`${who}writing draft${of}`)
    case 'error':
    case 'offline':
      return e.message ?? (e.phase === 'offline' ? 'Offline' : 'Something went wrong')
    case 'idle': {
      const parts: string[] = []
      if (e.message) parts.push(e.message)
      if (e.lastRunAt) parts.push(`Last checked ${formatClock(e.lastRunAt)}`)
      if (e.nextRunAt) parts.push(`next at ${formatClock(e.nextRunAt)}`)
      return parts.length ? parts.join(' · ') : 'Idle'
    }
  }
}

export function relativeDay(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return formatClock(ms)
  const y = new Date(now - 86_400_000)
  if (d.toDateString() === y.toDateString()) return `Yesterday ${formatClock(ms)}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
