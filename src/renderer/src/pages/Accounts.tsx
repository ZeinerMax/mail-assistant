import { useCallback, useEffect, useState } from 'react'
import type { Account } from '@shared/types'

const STATUS_TEXT: Record<Account['status'], string> = {
  ok: 'Connected',
  needs_relogin: 'Sign-in expired',
  error: 'Problem'
}

export default function AccountsPage(): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [editing, setEditing] = useState<{ id: number; label: string } | null>(null)

  const load = useCallback(async () => setAccounts(await window.api.accounts.list()), [])
  useEffect(() => {
    void load()
    return window.api.onDataChanged(() => void load())
  }, [load])

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await fn()
    setBusy(false)
    setMsg(r.ok ? { kind: 'ok', text: okText } : { kind: 'err', text: r.error ?? 'Failed' })
    await load()
  }

  return (
    <>
      <div className="page-head">
        <h1>Accounts</h1>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => run(() => window.api.accounts.add() as never, 'Account added.')}
        >
          {busy ? 'Waiting for browser…' : 'Add account'}
        </button>
      </div>
      <p className="note" style={{ marginTop: -8 }}>
        Sign-in happens in your web browser. Mail Assistant only asks to <strong>read</strong> your mail and calendar —
        it can never send, change or delete anything.
      </p>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      <div className="card" style={{ marginTop: 14 }}>
        {accounts.length === 0 && <p className="note">No accounts yet. Click “Add account” to connect Gmail.</p>}
        {accounts.map((a) => (
          <div className="acct-row" key={a.id}>
            <span className="acct-dot" style={{ background: a.color, width: 14, height: 14 }} />
            <div className="grow">
              {editing?.id === a.id ? (
                <div className="row">
                  <input
                    type="text"
                    value={editing.label}
                    onChange={(e) => setEditing({ id: a.id, label: e.target.value })}
                    aria-label="Account name"
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      await window.api.accounts.rename(a.id, editing.label)
                      setEditing(null)
                      await load()
                    }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ fontWeight: 600 }}>
                    {a.label}{' '}
                    <button className="link note" onClick={() => setEditing({ id: a.id, label: a.label })}>
                      rename
                    </button>
                  </div>
                  <div className="note">{a.email}</div>
                </>
              )}
            </div>
            <span className={`status-pill ${a.status}`}>{STATUS_TEXT[a.status]}</span>
            {a.status !== 'ok' && (
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => run(() => window.api.accounts.relogin(a.id) as never, 'Signed in again.')}
              >
                Sign in again
              </button>
            )}
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Remove ${a.email} from Mail Assistant? Its summaries and drafts will be deleted.`))
                  void run(() => window.api.accounts.remove(a.id) as never, 'Account removed.')
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
