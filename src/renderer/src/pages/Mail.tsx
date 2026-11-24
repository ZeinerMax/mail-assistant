import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Account, Tag } from '@shared/types'
import type { MailItem } from '@shared/ipc'
import { relativeDay } from '@shared/format'
import type { Page } from '../App'
import MailViewer, { type ViewMode } from '../components/MailViewer'

const TAG_LABEL: Record<Tag, string> = {
  needs_reply: 'Important',
  info: 'Info',
  newsletter_junk: 'Newsletter / junk'
}

type Filter = Tag | 'all' | 'done'

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local time as the value of <input type="datetime-local" step="1"> (YYYY-MM-DDTHH:MM:SS). */
const toLocalInput = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const startOfToday = (): string => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return toLocalInput(d)
}

export default function MailPage({ goTo }: { goTo: (p: Page) => void }): React.JSX.Element {
  const [items, setItems] = useState<MailItem[]>([])
  const [doneItems, setDoneItems] = useState<MailItem[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [filter, setFilter] = useState<Filter>('needs_reply')
  const [acct, setAcct] = useState<number | 0>(0)
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [since, setSince] = useState<string>(startOfToday)
  const [view, setView] = useState<{ id: number; mode: ViewMode } | null>(null)
  const viewing = view ? [...items, ...doneItems].find((i) => i.id === view.id) : undefined

  const load = useCallback(async () => {
    const [m, done, a] = await Promise.all([
      window.api.mail.list({}),
      window.api.mail.list({ view: 'done' }),
      window.api.accounts.list()
    ])
    setItems(m)
    setDoneItems(done)
    setAccounts(a)
  }, [])

  useEffect(() => {
    void load()
    return window.api.onDataChanged(() => void load())
  }, [load])

  const setFinished = async (id: number, finished: boolean): Promise<void> => {
    await window.api.mail.setFinished(id, finished)
    await load()
  }

  const scoped = useMemo(() => (acct ? items.filter((i) => i.accountId === acct) : items), [items, acct])
  const scopedDone = useMemo(
    () => (acct ? doneItems.filter((i) => i.accountId === acct) : doneItems),
    [doneItems, acct]
  )
  const counts = useMemo(() => {
    const c = { needs_reply: 0, info: 0, newsletter_junk: 0, all: scoped.length, done: scopedDone.length }
    for (const i of scoped) if (i.tag) c[i.tag]++
    return c
  }, [scoped, scopedDone])
  const shown = filter === 'done' ? scopedDone : filter === 'all' ? scoped : scoped.filter((i) => i.tag === filter)
  const reloginNeeded = accounts.filter((a) => a.status === 'needs_relogin')

  const [unsubscribing, setUnsubscribing] = useState<number | null>(null)
  const unsubscribe = async (id: number): Promise<void> => {
    setUnsubscribing(id)
    setNote(null)
    const r = await window.api.mail.unsubscribe(id)
    setUnsubscribing(null)
    if (r.ok) {
      const how =
        r.value.method === 'email'
          ? `sent an unsubscribe email to ${r.value.target}`
          : r.value.method === 'one-click'
            ? 'sent a one-click unsubscribe request'
            : 'opened the unsubscribe link for you'
      setNote(`Unsubscribed — ${how}. Marked done.`)
    } else {
      setNote(r.error)
    }
    await load()
  }

  const [drafting, setDrafting] = useState<number | null>(null)
  const writeDraft = async (id: number): Promise<void> => {
    setDrafting(id)
    setNote(null)
    const r = await window.api.drafts.create(id)
    setDrafting(null)
    if (!r.ok) setNote(r.error ?? 'Could not write a draft.')
    await load()
  }

  const check = async (sinceMs?: number): Promise<void> => {
    setChecking(true)
    setNote(null)
    const r = await window.api.scan.runNow(sinceMs)
    setChecking(false)
    if (r.status === 'no_api_key') setNote('Add your Anthropic API key in Settings first.')
    else if (r.status === 'no_accounts') setNote('Add an email account first.')
    else if (r.status === 'already_running') setNote('A check is already running.')
    else if (r.stopReason === 'bad_time') setNote('Pick a time in the past.')
    else if (sinceMs !== undefined) {
      const done = `Summarized ${r.triaged} email${r.triaged === 1 ? '' : 's'}, wrote ${r.drafted} draft${r.drafted === 1 ? '' : 's'}.`
      const more =
        r.stopReason === 'cap_emails' || r.stopReason === 'cap_tokens'
          ? ' The per-check limit was reached — press “Check from this time” again to continue.'
          : ''
      setNote(done + more)
    }
    await load()
  }

  const checkSince = (): void => {
    const ms = new Date(since).getTime()
    if (!since || !Number.isFinite(ms)) return setNote('Pick a date and time first.')
    if (ms > Date.now()) return setNote('Pick a time in the past.')
    void check(ms)
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
          <label className="since" title="Get all inbox mail received since this date and time">
            From
            <input
              type="datetime-local"
              step="1"
              value={since}
              max={toLocalInput(new Date())}
              onChange={(e) => setSince(e.target.value)}
              aria-label="Check mail received since"
            />
          </label>
          <button className="btn" onClick={checkSince} disabled={checking}>
            Check from this time
          </button>
          <button className="btn primary" onClick={() => void check()} disabled={checking}>
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
          <div className="num">{scoped.filter((i) => i.hasDraft && !i.answered).length}</div>
          <div className="lbl">Drafts ready</div>
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        {(['needs_reply', 'info', 'newsletter_junk', 'all', 'done'] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'done' ? 'Done' : TAG_LABEL[f]}
            <span className="n">{counts[f]}</span>
          </button>
        ))}
      </div>

      {accounts.length === 0 ? (
        <div className="empty">
          <div className="big">No accounts yet</div>
          <button className="btn primary" onClick={() => goTo('accounts')}>
            Add an email account
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
            <div className={`mail ${m.finished ? 'done' : ''}`} key={m.id}>
              <div className="dotcol">
                <span className="acct-dot" style={{ background: m.color }} title={m.accountLabel} />
              </div>
              <div className="meta">
                <span className="who" title={m.fromEmail}>
                  {m.fromName || m.fromEmail}
                </span>
                {m.state === 'failed' ? (
                  <span className="tag failed">Couldn&apos;t summarize</span>
                ) : m.answered ? (
                  <span className="tag answered" title="Needed a reply, but you already answered it, so no draft was written">
                    Important — already answered
                  </span>
                ) : (
                  m.tag && <span className={`tag ${m.tag}`}>{TAG_LABEL[m.tag]}</span>
                )}
                {m.finished && <span className="tag answered">Done</span>}
                {m.answered || m.finished ? null : m.hasDraft ? (
                  <button className="btn sm" onClick={() => goTo('drafts')}>
                    Draft ready →
                  </button>
                ) : (
                  m.tag === 'needs_reply' && (
                    <button className="btn sm" disabled={drafting === m.id} onClick={() => writeDraft(m.id)}>
                      {drafting === m.id ? 'Writing draft…' : 'Write draft'}
                    </button>
                  )
                )}
              </div>
              <div className="when">
                {m.repliedAt && <span className="chip replied">Replied</span>} {relativeDay(m.receivedAt)}
              </div>
              <div className="subj" style={{ gridColumn: '2 / 4' }}>
                {m.subject}
              </div>
              {m.summary && <div className="sum">{m.summary}</div>}
              <div className="actions">
                <button className="btn sm" onClick={() => setView({ id: m.id, mode: 'message' })}>
                  Open email
                </button>
                {m.tag === 'needs_reply' && m.webUrl && (
                  <a className="btn sm" href={m.webUrl} target="_blank" rel="noreferrer">
                    Open in Gmail ↗
                  </a>
                )}
                {m.tag === 'newsletter_junk' && !m.finished && (
                  <button className="btn sm" disabled={unsubscribing === m.id} onClick={() => void unsubscribe(m.id)}>
                    {unsubscribing === m.id ? 'Unsubscribing…' : 'Unsubscribe'}
                  </button>
                )}
                {!m.answered && (
                  <label className="done-check" title="Mark done — no reply needed">
                    <input
                      type="checkbox"
                      checked={m.finished}
                      onChange={(e) => void setFinished(m.id, e.target.checked)}
                    />
                    {m.finished ? 'Done' : 'Mark done'}
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {viewing && view && (
        <MailViewer
          item={viewing}
          mode={view.mode}
          onMode={(mode) => setView({ id: viewing.id, mode })}
          onClose={() => setView(null)}
        />
      )}
    </>
  )
}
