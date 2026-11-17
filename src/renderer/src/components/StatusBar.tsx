import { useEffect, useState } from 'react'
import type { StatusEvent } from '@shared/types'
import { formatStatus } from '@shared/format'

export default function StatusBar(): React.JSX.Element {
  const [s, setS] = useState<StatusEvent>({ phase: 'idle' })
  useEffect(() => window.api.onStatus(setS), [])
  // Re-render every 30s so relative texts stay fresh.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const busy = ['listing', 'summarizing', 'drafting'].includes(s.phase)
  const cls = busy ? 'busy' : s.phase === 'error' ? 'error' : s.phase === 'offline' ? 'offline' : ''
  return (
    <div className={`statusbar ${cls}`} role="status" aria-live="polite">
      <span className="dot" />
      <span>{formatStatus(s)}</span>
    </div>
  )
}
