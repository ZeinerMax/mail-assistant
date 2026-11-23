import { useEffect, useRef, useState } from 'react'

import { SEND_PERMISSION_MISSING, RELOGIN_REQUIRED } from '@shared/messages'

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
  onSent: (to: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(initialText)
  const [confirm, setConfirm] = useState<{ to: string; from: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [relogging, setRelogging] = useState(false)

  const latest = useRef(initialText)
  const saved = useRef(initialText)
  const sentRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  const relogin = async (): Promise<void> => {
    setRelogging(true)
    setInfo(null)
    try {
      const r = await window.api.accounts.relogin(accountId)
      if (r.ok) {
        setError(null)
        setInfo('Sending is enabled. Press Send… again.')
      } else {
        setError(r.error)
      }
    } catch {
      setError('Could not sign in. Please try again.')
    } finally {
      setRelogging(false)
    }
  }

  const send = async (): Promise<void> => {
    setSending(true)
    setError(null)
    setInfo(null)
    const to = confirm?.to ?? ''
    const r = await window.api.reply.send(emailId, text)
    setSending(false)
    if (r.ok) {
      sentRef.current = true
      if (timer.current) clearTimeout(timer.current)
      setConfirm(null)
      setSent(true)
      // Report right away: the page reloads after a send and may unmount this box before any timer fires.
      onSentRef.current(to)
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
          {(error === SEND_PERMISSION_MISSING || error === RELOGIN_REQUIRED) && (
            <>
              {' '}
              <button className="btn" disabled={relogging} onClick={() => void relogin()}>
                {relogging ? 'Waiting for sign-in…' : 'Sign in again'}
              </button>
            </>
          )}
        </div>
      )}
      {info && !error && <div className="msg ok">{info}</div>}
    </div>
  )
}
