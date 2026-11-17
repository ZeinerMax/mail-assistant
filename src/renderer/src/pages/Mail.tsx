import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Account, Tag } from '@shared/types'
import type { MailItem } from '@shared/ipc'
import { relativeDay } from '@shared/format'
import type { Page } from '../App'

const TAG_LABEL: Record<Tag, string> = {
  needs_reply: 'Needs reply',
  info: 'Info',
  newsletter_junk: 'Newsletter / junk'
}

type Filter = Tag | 'all'

export default function MailPage({ goTo }: { goTo: (p: Page) => void }): React.JSX.Element {
  const [items, setItems] = useState<MailItem[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [filter, setFilter] = useState<Filter>('needs_reply')
  const [acct, setAcct] = useState<number | 0>(0)
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [m, a] = await Promise.all([window.api.mail.list({}), window.api.accounts.list()])
    setItems(m)
    setAccounts(a)
  }, [])

  useEffect(() => {
    void load()
    return window.api.onDataChanged(() => void load())
  }, [load])

  const scoped = useMemo(() => (acct ? items.filter((i) => i.accountId === acct) : items), [items, acct])
  const counts = useMemo(() => {
    const c = { needs_reply: 0, info: 0, newsletter_junk: 0, all: scoped.length }
    for (const i of scoped) if (i.tag) c[i.tag]++
    return c
  }, [scoped])
  const shown = filter === 'all' ? scoped : scoped.filter((i) => i.tag === filter)
  const reloginNeeded = accounts.filter((a) => a.status === 'needs_relogin')

  const [drafting, setDrafting] = useState<number | null>(null)
  const writeDraft = async (id: number): Promise<void> => {
    setDrafting(id)
    setNote(null)
    const r = await window.api.drafts.create(id)
    setDrafting(null)
    if (!r.ok) setNote(r.error ?? 'Could not write a draft.')
    await load()
  }

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    setNote(null)
    const r = await window.api.scan.runNow()
    setChecking(false)
    if (r.status === 'no_api_key') setNote('Add your Anthropic API key in Settings first.')
    else if (r.status === 'no_accounts') setNote('Add a Gmail account first.')
    else if (r.status === 'already_running') setNote('A check is already running.')
    await load()
  }

  return (
    <>
      <div className="page-head">
        <h1>Mail</h1>
        <div className="row">
          {accounts.length > 1 && (
            <select value={acct} onChange={(e) => setAcct(Number(e.target.value))} aria-label="Account">
              <option value={0}>All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn primary" onClick={checkNow} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>

      {reloginNeeded.map((a) => (
        <div key={a.id} className="msg err">
          {a.label} ({a.email}) needs you to sign in again.{' '}
          <button className="link" onClick={() => goTo('accounts')}>
            Go to Accounts
          </button>
        </div>
      ))}
      {note && <div className="msg warn">{note}</div>}

      <div className="stats" style={{ marginTop: 12 }}>
        {(['needs_reply', 'info', 'newsletter_junk'] as Tag[]).map((t) => (
          <button key={t} className="stat" onClick={() => setFilter(t)}>
            <div className="num">{counts[t]}</div>
            <div className="lbl">{TAG_LABEL[t]}</div>
          </button>
        ))}
        <button className="stat" onClick={() => goTo('drafts')}>
          <div className="num">{scoped.filter((i) => i.hasDraft).length}</div>
          <div className="lbl">Drafts ready</div>
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        {(['needs_reply', 'info', 'newsletter_junk', 'all'] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : TAG_LABEL[f]}
            <span className="n">{counts[f]}</span>
          </button>
        ))}
      </div>

      {accounts.length === 0 ? (
        <div className="empty">
          <div className="big">No accounts yet</div>
          <button className="btn primary" onClick={() => goTo('accounts')}>
            Add a Gmail account
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="big">Nothing here</div>
          <div>New mail is checked automatically. You can also press “Check now”.</div>
        </div>
      ) : (
        <div className="mail-list">
          {shown.map((m) => (
            <div className="mail" key={m.id}>
              <div className="dotcol">
                <span className="acct-dot" style={{ background: m.color }} title={m.accountLabel} />
              </div>
              <div className="meta">
                <span className="who" title={m.fromEmail}>
                  {m.fromName || m.fromEmail}
                </span>
                {m.state === 'failed' ? (
                  <span className="tag failed">Couldn&apos;t summarize</span>
                ) : (
                  m.tag && <span className={`tag ${m.tag}`}>{TAG_LABEL[m.tag]}</span>
                )}
                {m.hasDraft ? (
                  <button className="link" onClick={() => goTo('drafts')}>
                    Draft ready →
                  </button>
                ) : (
                  m.tag === 'needs_reply' && (
                    <button className="link" disabled={drafting === m.id} onClick={() => writeDraft(m.id)}>
                      {drafting === m.id ? 'Writing draft…' : 'Write draft'}
                    </button>
                  )
                )}
              </div>
              <div className="when">{relativeDay(m.receivedAt)}</div>
              <div className="subj" style={{ gridColumn: '2 / 4' }}>
                {m.subject}
              </div>
              {m.summary && <div className="sum">{m.summary}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
