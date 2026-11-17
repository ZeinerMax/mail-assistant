import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import type { UsageSummary } from '@shared/ipc'

type Msg = { kind: 'ok' | 'err'; text: string } | null

function ApiKeyCard(): React.JSX.Element {
  const [status, setStatus] = useState<{ set: boolean; last4?: string }>({ set: false })
  const [value, setValue] = useState('')
  const [msg, setMsg] = useState<Msg>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.apiKey.status().then(setStatus)
  }, [])

  const save = async (): Promise<void> => {
    setMsg(null)
    const r = await window.api.apiKey.set(value)
    if (r.ok) {
      setValue('')
      setStatus({ set: true, last4: r.value.last4 })
      setMsg({ kind: 'ok', text: 'Saved securely.' })
    } else setMsg({ kind: 'err', text: r.error })
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await window.api.apiKey.test()
    setBusy(false)
    setMsg(r.ok ? { kind: 'ok', text: 'The key works.' } : { kind: 'err', text: r.error ?? 'Test failed' })
  }

  return (
    <div className="card">
      <h2>Anthropic API key</h2>
      <p className="note">
        Stored with your computer&apos;s secure storage. It is never shown again after saving.
        {status.set && (
          <>
            {' '}
            Current key: <strong>••••{status.last4}</strong>
          </>
        )}
      </p>
      <div className="row">
        <input
          type="password"
          placeholder={status.set ? 'Paste a new key to replace it' : 'sk-ant-…'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn primary" onClick={save} disabled={!value.trim()}>
          Save key
        </button>
        <button className="btn" onClick={test} disabled={!status.set || busy}>
          {busy ? 'Testing…' : 'Test key'}
        </button>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </div>
  )
}

const NUM_FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'checkIntervalMin', label: 'Check for new mail every (minutes)', hint: '5 – 1440' },
  { key: 'maxEmailsPerRun', label: 'Max emails per check', hint: 'Hard cap' },
  { key: 'maxDraftsPerRun', label: 'Max drafts per check', hint: 'Hard cap' },
  { key: 'maxTokensPerRun', label: 'Max tokens per check', hint: 'Hard cap' },
  { key: 'triageBodyChars', label: 'Characters sent per email (summary)', hint: 'Longer emails are cut' },
  { key: 'draftContextChars', label: 'Characters of thread sent (draft)', hint: 'Oldest messages dropped first' }
]

function SettingsCard(): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [msg, setMsg] = useState<Msg>(null)

  useEffect(() => {
    void window.api.settings.get().then(setS)
  }, [])
  if (!s) return <div className="card">Loading…</div>

  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setS({ ...s, [k]: v })
  const save = async (): Promise<void> => {
    const r = await window.api.settings.save(s)
    if (r.ok) {
      setS(r.value)
      setMsg({ kind: 'ok', text: 'Settings saved.' })
    } else setMsg({ kind: 'err', text: r.error })
  }

  return (
    <div className="card">
      <h2>Models and limits</h2>
      <div className="grid2">
        <label className="field">
          Summary model
          <input type="text" value={s.triageModel} onChange={(e) => set('triageModel', e.target.value)} />
        </label>
        <label className="field">
          Draft model
          <input type="text" value={s.draftModel} onChange={(e) => set('draftModel', e.target.value)} />
        </label>
        <label className="field">
          Draft effort
          <select value={s.draftEffort} onChange={(e) => set('draftEffort', e.target.value as Settings['draftEffort'])}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        {NUM_FIELDS.map((f) => (
          <label className="field" key={f.key} title={f.hint}>
            {f.label}
            <input
              type="number"
              value={s[f.key] as number}
              onChange={(e) => set(f.key, Number(e.target.value) as never)}
            />
          </label>
        ))}
        <label className="field">
          Promotions &amp; social tabs
          <select
            value={s.prefilterPromotions ? 'skip' : 'ai'}
            onChange={(e) => set('prefilterPromotions', e.target.value === 'skip')}
          >
            <option value="skip">Mark as newsletter without AI (cheaper)</option>
            <option value="ai">Summarize with AI too</option>
          </select>
        </label>
      </div>
      <h2 style={{ marginTop: 18 }}>Prices (USD per million tokens)</h2>
      <div className="grid2">
        {Object.entries(s.prices).map(([model, p]) => (
          <div key={model} className="field">
            <span className="note">{model}</span>
            <div className="row">
              <input
                type="number"
                step="0.01"
                value={p.in}
                aria-label={`${model} input price`}
                onChange={(e) => set('prices', { ...s.prices, [model]: { ...p, in: Number(e.target.value) } })}
                style={{ width: 90 }}
              />
              <span className="note">in</span>
              <input
                type="number"
                step="0.01"
                value={p.out}
                aria-label={`${model} output price`}
                onChange={(e) => set('prices', { ...s.prices, [model]: { ...p, out: Number(e.target.value) } })}
                style={{ width: 90 }}
              />
              <span className="note">out</span>
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={save}>
          Save settings
        </button>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </div>
  )
}

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`

function UsageCard(): React.JSX.Element {
  const [u, setU] = useState<UsageSummary | null>(null)
  useEffect(() => {
    void window.api.usage.summary().then(setU)
    return window.api.onDataChanged(() => void window.api.usage.summary().then(setU))
  }, [])
  const total = (rows: UsageSummary['allTime']): number => rows.reduce((a, r) => a + r.costUsd, 0)
  return (
    <div className="card">
      <h2>Usage</h2>
      {!u || u.allTime.length === 0 ? (
        <p className="note">No AI usage yet.</p>
      ) : (
        <>
          <p className="note">
            This month: <strong>{usd(total(u.thisMonth))}</strong> · All time: <strong>{usd(total(u.allTime))}</strong>{' '}
            (estimated from the prices set below)
          </p>
          <table className="usage">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Input tokens</th>
                <th className="num">Output tokens</th>
                <th className="num">Cost (all time)</th>
              </tr>
            </thead>
            <tbody>
              {u.allTime.map((r) => (
                <tr key={r.model}>
                  <td>{r.model}</td>
                  <td className="num">{r.inputTokens.toLocaleString()}</td>
                  <td className="num">{r.outputTokens.toLocaleString()}</td>
                  <td className="num">{usd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export default function SettingsPage(): React.JSX.Element {
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <ApiKeyCard />
      <UsageCard />
      <SettingsCard />
    </>
  )
}
