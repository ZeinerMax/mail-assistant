import { useEffect, useState } from 'react'
import type { FullMessage, MailItem } from '@shared/ipc'
import { relativeDay } from '@shared/format'
import ReplyBox from './ReplyBox'

export type ViewMode = 'message' | 'thread'

const fmt = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Reader for one email or its whole conversation. Text is fetched live and only kept while the panel is open. */
export default function MailViewer({
  item,
  mode,
  onMode,
  onClose
}: {
  item: MailItem
  mode: ViewMode
  onMode: (m: ViewMode) => void
  onClose: () => void
}): React.JSX.Element {
  const [msgs, setMsgs] = useState<FullMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setMsgs(null)
    setError(null)
    const p =
      mode === 'message'
        ? window.api.mail.message(item.id).then((r) => (r.ok ? { ok: true as const, value: [r.value] } : r))
        : window.api.mail.thread(item.id)
    void p.then((r) => {
      if (!alive) return
      if (r.ok) setMsgs(r.value)
      else setError(r.error)
    })
    return () => {
      alive = false
    }
  }, [item.id, mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openReply = async (): Promise<void> => {
    const d = (await window.api.drafts.list()).find((x) => x.emailId === item.id)
    setReply(d?.body ?? '')
  }

  const count = mode === 'thread' && msgs ? msgs.length : item.threadSize

  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <div className="viewer" role="dialog" aria-modal="true" aria-label="Email" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <div className="grow">
            <div className="viewer-subj">{item.subject}</div>
            <div className="note">
              {item.fromName || item.fromEmail} · {item.accountLabel}
            </div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="row viewer-tabs">
          <button className={`chip ${mode === 'message' ? 'active' : ''}`} onClick={() => onMode('message')}>
            This email
          </button>
          <button className={`chip ${mode === 'thread' ? 'active' : ''}`} onClick={() => onMode('thread')}>
            Whole conversation{count && count > 1 ? <span className="n">{count}</span> : null}
          </button>
          <span className="grow" />
          {item.repliedAt ? (
            <span className="note">Replied {relativeDay(item.repliedAt)}</span>
          ) : (
            reply === null && (
              <button className="btn" onClick={() => void openReply()}>
                Reply
              </button>
            )
          )}
          {item.webUrl && (
            <a className="link" href={item.webUrl} target="_blank" rel="noreferrer">
              Open in Gmail ↗
            </a>
          )}
        </div>
        <div className="viewer-body">
          {error && <div className="msg err">{error}</div>}
          {!error && !msgs && <div className="note">Loading…</div>}
          {msgs?.map((m) => (
            <article key={m.id} className={`viewer-msg ${m.isTarget && mode === 'thread' ? 'target' : ''} ${m.fromOwner ? 'own' : ''}`}>
              <header>
                <strong>{m.fromOwner ? `You (${m.fromEmail})` : m.fromName || m.fromEmail}</strong>
                {m.fromName && !m.fromOwner && <span className="note"> &lt;{m.fromEmail}&gt;</span>}
                <span className="note viewer-date">{fmt(m.date)}</span>
                {m.to && <div className="note">To: {m.to}</div>}
              </header>
              <pre className="viewer-text">{m.text}</pre>
            </article>
          ))}
          {reply !== null && !item.repliedAt && (
            <ReplyBox
              key={item.id}
              emailId={item.id}
              accountId={item.accountId}
              initialText={reply}
              onSent={() => setReply(null)}
            />
          )}
          {mode === 'thread' && msgs && msgs.length <= 1 && (
            <div className="note">This email is not part of a longer conversation.</div>
          )}
        </div>
      </div>
    </div>
  )
}
