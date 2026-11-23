import { useEffect, useRef, useState } from 'react'

const RELOGIN_ERROR = 'Sign in again to enable sending from this account.'

/** Editable reply with debounced draft saving and a confirm step before anything is sent. */
export default function ReplyBox({
  emailId,
  accountId,
  initialText,
  onSent
}: {
  emailId: number
  accountId: number
  initialText: string
  onSent: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initialText)
  const [confirm, setConfirm] = useState<{ to: string; from: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const latest = useRef(initialText)
  const saved = useRef(initialText)
  const sentRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent

  const flush = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (sentRef.current || latest.current === saved.current) return
    const body = latest.current
    saved.current = body
    void window.api.drafts.save(emailId, body)
  }

  useEffect(
    () => () => {
      flush()
      if (sentTimer.current) clearTimeout(sentTimer.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emailId]
  )

  const edit = (v: string): void => {
    setText(v)
    latest.current = v
    setConfirm(null)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 800)
  }

  const preview = async (): Promise<void> => {
    setError(null)
    flush()
    const r = await window.api.reply.preview(emailId)
    if (r.ok) setConfirm({ to: r.value.to, from: r.value.from })
    else setError(r.error)
  }

  const send = async (): Promise<void> => {
    setSending(true)
    setError(null)
    const r = await window.api.reply.send(emailId, text)
    setSending(false)
    if (r.ok) {
      sentRef.current = true
      if (timer.current) clearTimeout(timer.current)
      setConfirm(null)
      setSent(true)
      sentTimer.current = setTimeout(() => onSentRef.current(), 1500)
    } else {
      setConfirm(null)
      setError(r.error)
    }
  }

  return (
    <div className="reply-box">
      <textarea
        value={text}
        onChange={(e) => edit(e.target.value)}
        disabled={sending || sent}
        rows={8}
        aria-label="Reply"
      />
      <div className="row" style={{ marginTop: 8 }}>
        {sent ? (
          <span className="msg ok" style={{ marginTop: 0 }}>
            Sent ✓
          </span>
        ) : confirm ? (
          <>
            <span>
              Send to <strong>{confirm.to}</strong> from <strong>{confirm.from}</strong>?
            </span>
            <button className="btn primary" disabled={sending} onClick={() => void send()}>
              {sending ? 'Sending…' : 'Send now'}
            </button>
            <button className="btn" disabled={sending} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!text.trim()} onClick={() => void preview()}>
            Send…
          </button>
        )}
      </div>
      {error && (
        <div className="msg err">
          {error}
          {error === RELOGIN_ERROR && (
            <>
              {' '}
              <button className="btn" onClick={() => void window.api.accounts.relogin(accountId)}>
                Sign in again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
