import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/ipc'

const RELEASES_PAGE = 'https://github.com/ZeinerMax/mail-assistant/releases/latest'

/** Slim bar above every page when a new version is available, downloading, or just installed. */
export default function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' })
  const [justUpdated, setJustUpdated] = useState<string | null>(null)
  const [showNotes, setShowNotes] = useState(false)

  useEffect(() => {
    void window.api.update.state().then((i) => {
      setState(i.state)
      setJustUpdated(i.justUpdated)
    })
    return window.api.onUpdate(setState)
  }, [])

  const install = (): void => void window.api.update.install()

  if (state.phase === 'available')
    return (
      <div className="update-bar">
        <div className="row">
          <span className="grow">New version {state.version} is available.</span>
          {state.notes && (
            <button className="link" onClick={() => setShowNotes(!showNotes)}>
              What&apos;s new
            </button>
          )}
          <button className="btn primary" onClick={install}>
            Update and restart
          </button>
        </div>
        {showNotes && state.notes && <div className="update-notes">{state.notes}</div>}
      </div>
    )
  if (state.phase === 'waiting')
    return <div className="update-bar">Waiting for the current check…</div>
  if (state.phase === 'downloading')
    return (
      <div className="update-bar">
        Downloading update… {state.percent}%
        <div className="update-progress">
          <div style={{ width: `${state.percent}%` }} />
        </div>
      </div>
    )
  if (state.phase === 'installing') return <div className="update-bar">Installing version {state.version}…</div>
  if (state.phase === 'error' && state.version)
    return (
      <div className="update-bar err">
        <div className="row">
          <span className="grow">{state.message}</span>
          <button className="btn" onClick={install}>
            Try again
          </button>
          <a className="link" href={RELEASES_PAGE} target="_blank" rel="noreferrer">
            Download manually
          </a>
        </div>
      </div>
    )
  if (justUpdated)
    return (
      <div className="update-bar ok">
        <div className="row">
          <span className="grow">Updated to {justUpdated}.</span>
          <button className="link" onClick={() => setJustUpdated(null)}>
            Dismiss
          </button>
        </div>
      </div>
    )
  return null
}
