import { useCallback, useEffect, useState } from 'react'
import type { Account } from '@shared/types'
import type { ImapAccountForm } from '@shared/ipc'

const EMPTY_IMAP: ImapAccountForm = { email: '', host: '', port: 993, user: '', password: '' }

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
  const [imapForm, setImapForm] = useState<ImapAccountForm | null>(null)
  const [pw, setPw] = useState<{ id: number; password: string } | null>(null)
  const field = (k: keyof ImapAccountForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setImapForm((f) => (f ? { ...f, [k]: k === 'port' ? Number(e.target.value) : e.target.value } : f))

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
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => setImapForm(imapForm ? null : { ...EMPTY_IMAP })}>
            Add other email (IMAP)
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => run(() => window.api.accounts.add() as never, 'Account added.')}
          >
            {busy && !imapForm ? 'Waiting for browser…' : 'Add Gmail account'}
          </button>
        </div>
      </div>
      <p className="note" style={{ marginTop: -8 }}>
        Gmail sign-in happens in your web browser. Mail Assistant only <strong>reads</strong> your mail and calendar —
        it can never send, change or delete anything. Other mailboxes (e.g. Webglobe) are opened read-only over IMAP.
      </p>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      {imapForm && (
        <form
          className="card"
          style={{ marginTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              const r = await window.api.accounts.addImap(imapForm)
              if (r.ok) setImapForm(null)
              return r
            }, 'Mailbox connected.')
          }}
        >
          <h3 style={{ marginTop: 0 }}>Add other email (IMAP)</h3>
          <p className="note">
            Find these in your mail provider&apos;s settings (for Webglobe: the customer administration, mailbox settings).
            The password is stored encrypted on this computer.
          </p>
          <div className="imap-form">
            <label htmlFor="imap-email">Email address</label>
            <input id="imap-email" type="text" value={imapForm.email} onChange={field('email')} placeholder="you@yourdomain.cz" autoFocus />
            <label htmlFor="imap-host">IMAP server</label>
            <input id="imap-host" type="text" value={imapForm.host} onChange={field('host')} placeholder="mail.webglobe.cz" />
            <label htmlFor="imap-port">Port</label>
            <input id="imap-port" type="number" value={imapForm.port} onChange={field('port')} style={{ width: 100 }} />
            <label htmlFor="imap-user">User name</label>
            <input id="imap-user" type="text" value={imapForm.user} onChange={field('user')} placeholder="usually the full email address" />
            <label htmlFor="imap-pass">Password</label>
            <input id="imap-pass" type="password" value={imapForm.password} onChange={field('password')} autoComplete="off" />
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button className="btn" type="button" onClick={() => setImapForm(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        {accounts.length === 0 && <p className="note">No accounts yet. Click “Add Gmail account” or “Add other email (IMAP)”.</p>}
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
                  <div className="note">
                    {a.email}
                    {a.imap && ` · IMAP ${a.imap.host}:${a.imap.port}`}
                  </div>
                  {pw?.id === a.id && (
                    <form
                      className="row"
                      style={{ marginTop: 6 }}
                      onSubmit={(e) => {
                        e.preventDefault()
                        void run(async () => {
                          const r = await window.api.accounts.setImapPassword(a.id, pw.password)
                          if (r.ok) setPw(null)
                          return r
                        }, 'Password saved.')
                      }}
                    >
                      <input
                        type="password"
                        value={pw.password}
                        onChange={(e) => setPw({ id: a.id, password: e.target.value })}
                        placeholder="Mailbox password"
                        aria-label="Mailbox password"
                        autoComplete="off"
                        autoFocus
                      />
                      <button className="btn primary" type="submit" disabled={busy}>
                        Save
                      </button>
                      <button className="btn" type="button" onClick={() => setPw(null)}>
                        Cancel
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>
            <span className={`status-pill ${a.status}`}>{STATUS_TEXT[a.status]}</span>
            {a.kind === 'imap' ? (
              <button className={`btn ${a.status !== 'ok' ? 'primary' : ''}`} disabled={busy} onClick={() => setPw({ id: a.id, password: '' })}>
                {a.status !== 'ok' ? 'Enter password again' : 'Change password'}
              </button>
            ) : (
              a.status !== 'ok' && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => run(() => window.api.accounts.relogin(a.id) as never, 'Signed in again.')}
                >
                  Sign in again
                </button>
              )
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
