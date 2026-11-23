import { useCallback, useEffect, useState } from 'react'
import type { DraftItem } from '@shared/ipc'
import { relativeDay } from '@shared/format'
import ReplyBox from '../components/ReplyBox'

export default function DraftsPage(): React.JSX.Element {
  const [drafts, setDrafts] = useState<DraftItem[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => setDrafts(await window.api.drafts.list()), [])
  useEffect(() => {
    void load()
    return window.api.onDataChanged(() => void load())
  }, [load])

  const current = drafts.find((d) => d.id === selected) ?? drafts[0]

  // Pin the selection to what is actually shown, so new drafts arriving in the background never switch it.
  useEffect(() => {
    if (current && current.id !== selected) setSelected(current.id)
  }, [current, selected])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const handleSent = (to: string): void => {
    setNotice(`Reply sent to ${to}.`)
    const i = drafts.findIndex((d) => d.id === current?.id)
    const next = drafts[i + 1] ?? drafts[i - 1]
    setSelected(next ? next.id : null)
    void load()
  }

  useEffect(() => {
    if (current && !current.seen) {
      void window.api.drafts.markSeen(current.id).then(load)
    }
  }, [current, load])

  const copy = async (id: number): Promise<void> => {
    await window.api.drafts.copy(id)
    setCopied(id)
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 2500)
    void load()
  }

  return (
    <>
      <div className="page-head">
        <h1>Drafts</h1>
      </div>
      <p className="note" style={{ marginTop: -8, marginBottom: 16 }}>
        Edit a draft and send it from here, or copy it.
      </p>
      {notice && (
        <div className="msg ok" role="status" style={{ marginTop: 0, marginBottom: 16 }}>
          {notice}{' '}
          <button className="btn" onClick={() => setNotice(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
      {drafts.length === 0 || !current ? (
        <div className="empty">
          <div className="big">No drafts yet</div>
          <div>When an email needs a reply, a draft will appear here.</div>
        </div>
      ) : (
        <div className="drafts">
          <div className="draft-list" role="listbox" aria-label="Drafts">
            {drafts.map((d) => (
              <button
                key={d.id}
                role="option"
                aria-selected={d.id === current.id}
                className={`draft-item ${d.id === current.id ? 'active' : ''} ${d.seen ? '' : 'unseen'}`}
                onClick={() => setSelected(d.id)}
              >
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                  <span className="row" style={{ gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
                    <span className="acct-dot" style={{ background: d.color }} />
                    <span className="who" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {d.fromName || d.fromEmail}
                    </span>
                  </span>
                  <span className="note">{relativeDay(d.createdAt)}</span>
                </div>
                <div className="note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.subject}
                </div>
              </button>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600 }}>Re: {current.subject}</div>
                <div className="note">
                  To {current.fromName ? `${current.fromName} <${current.fromEmail}>` : current.fromEmail} · from{' '}
                  {current.accountLabel}
                </div>
              </div>
              <button className="btn primary big" onClick={() => copy(current.id)}>
                {copied === current.id ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            {current.summary && (
              <p className="note" style={{ marginBottom: 0 }}>
                <strong>Their email:</strong> {current.summary}
              </p>
            )}
            <ReplyBox
              key={current.emailId}
              emailId={current.emailId}
              accountId={current.accountId}
              initialText={current.body}
              onSent={handleSent}
            />
            <p className="note" style={{ margin: 0 }}>
              Check anything in [brackets] before sending — those are details only you know.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
