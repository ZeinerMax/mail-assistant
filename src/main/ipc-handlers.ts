import { ipcMain, type BrowserWindow } from 'electron'
import type { OAuth2Client } from 'google-auth-library'
import { CH, type Result, type RunResultView, type UsageSummary } from '@shared/ipc'
import type { Settings, StatusEvent, Tag } from '@shared/types'
import { loadSettings, saveSettings, SettingsError } from './config'
import type { Repo } from './db/repo'
import type { SecretStore } from './secrets'
import { SecretStorageUnavailable } from './secrets'
import { cleanApiKey, createAnthropic, testApiKey } from './ai/client'
import { log, redactError } from './log'
import type { AccountService } from './google/accounts'
import { MissingGoogleCredentials } from './google/oauth'
import { buildDraftItems, buildMailItems } from './views'
import { fetchEvents, type CalendarLike } from './google/calendar'

export interface AppContext {
  dataDir: string
  repo: Repo
  secrets: SecretStore
  accounts: AccountService<OAuth2Client>
  getWindow: () => BrowserWindow | null
  /** Runs a full check now (through the scheduler, so the interval restarts). sinceMs: check all mail since then. */
  runNow: (sinceMs?: number) => Promise<RunResultView>
  draftOne: (emailId: number) => Promise<string>
  onSettingsChanged: () => void
  writeClipboard: (text: string) => void
  refreshBadge: () => void
  getCalendar: (accountId: number) => Promise<CalendarLike>
}

export const ANTHROPIC_KEY = 'anthropicKey'

// Messages we wrote ourselves for the user; anything else is replaced by a generic text.
const OWN_MESSAGES = /^(Sign-in|Google did not|You signed in as|This account|This build has no Google|Could not read the Gmail profile)/

export function friendlyError(e: unknown): string {
  if (e instanceof SettingsError || e instanceof SecretStorageUnavailable || e instanceof MissingGoogleCredentials)
    return e.message
  if (e instanceof Error && OWN_MESSAGES.test(e.message)) return e.message
  log.error('ipc_error', redactError(e))
  return 'Something went wrong. Please try again.'
}

async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: friendlyError(e) }
  }
}

export function send(ctx: Pick<AppContext, 'getWindow'>, channel: string, payload?: unknown): void {
  const w = ctx.getWindow()
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
}

export function emitStatus(ctx: Pick<AppContext, 'getWindow'>, s: StatusEvent): void {
  send(ctx, CH.evStatus, s)
}

function startOfMonth(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

const DRAFT_ONE_TEXT: Record<string, string> = {
  busy: 'A check is running. Try again in a moment.',
  no_api_key: 'Add your Anthropic API key in Settings first.',
  not_found: 'That email is no longer available.',
  failed: 'Could not write a draft for this email.'
}

export function registerIpc(ctx: AppContext): void {
  const changed = (): void => send(ctx, CH.evDataChanged)

  // ---- settings + API key
  ipcMain.handle(CH.settingsGet, (): Settings => loadSettings(ctx.dataDir))
  ipcMain.handle(CH.settingsSave, (_e, patch: Partial<Settings>) =>
    wrap(() => {
      const s = saveSettings(ctx.dataDir, patch)
      ctx.onSettingsChanged()
      return s
    })
  )
  ipcMain.handle(CH.apiKeySet, (_e, key: string): Promise<Result<{ last4: string }>> =>
    wrap(() => {
      const k = typeof key === 'string' ? cleanApiKey(key) : ''
      if (k.length < 20 || !k.startsWith('sk-ant-'))
        throw new SettingsError('API key', 'that does not look like an Anthropic API key (it starts with sk-ant-)')
      ctx.secrets.set(ANTHROPIC_KEY, k)
      return { last4: k.slice(-4) }
    })
  )
  ipcMain.handle(CH.apiKeyStatus, () => {
    const k = ctx.secrets.get(ANTHROPIC_KEY)
    return k ? { set: true, last4: k.slice(-4) } : { set: false }
  })
  ipcMain.handle(CH.apiKeyTest, async () => {
    const k = ctx.secrets.get(ANTHROPIC_KEY)
    if (!k) return { ok: false, error: 'No API key saved yet.' }
    return testApiKey(createAnthropic(k), loadSettings(ctx.dataDir).triageModel)
  })

  // ---- accounts
  ipcMain.handle(CH.accountsList, () => ctx.repo.listAccounts())
  ipcMain.handle(CH.accountsAdd, () =>
    wrap(async () => {
      const a = await ctx.accounts.addAccount()
      changed()
      return a
    })
  )
  ipcMain.handle(CH.accountsRelogin, (_e, id: number) =>
    wrap(async () => {
      const a = await ctx.accounts.relogin(id)
      changed()
      return a
    })
  )
  ipcMain.handle(CH.accountsRemove, (_e, id: number) =>
    wrap(() => {
      ctx.accounts.removeAccount(id)
      changed()
      ctx.refreshBadge()
      return true as const
    })
  )
  ipcMain.handle(CH.accountsRename, (_e, id: number, label: string) =>
    wrap(() => {
      const clean = String(label ?? '').trim().slice(0, 40)
      if (!clean) throw new SettingsError('Name', 'must not be empty')
      ctx.repo.setAccountLabel(id, clean)
      changed()
      return true as const
    })
  )

  // ---- mail + drafts
  ipcMain.handle(CH.mailList, (_e, f: { tag?: Tag; accountId?: number }) => buildMailItems(ctx.repo, f ?? {}))
  ipcMain.handle(CH.draftsList, () => buildDraftItems(ctx.repo))
  ipcMain.handle(CH.draftsMarkSeen, (_e, id: number) => {
    ctx.repo.markDraftSeen(id)
    ctx.refreshBadge()
  })
  ipcMain.handle(CH.draftsCopy, (_e, id: number) => {
    const d = ctx.repo.getDraft(id)
    if (!d) return
    ctx.writeClipboard(d.body)
    ctx.repo.markDraftCopied(id)
    ctx.refreshBadge()
  })
  ipcMain.handle(CH.draftsCreate, async (_e, emailId: number) => {
    const r = await ctx.draftOne(emailId)
    changed()
    ctx.refreshBadge()
    return r === 'ok' || r === 'exists' ? { ok: true } : { ok: false, error: DRAFT_ONE_TEXT[r] ?? DRAFT_ONE_TEXT.failed }
  })

  // ---- calendar (read-only, in memory only)
  ipcMain.handle(CH.calendarEvents, (_e, startIso: string, endIso: string) =>
    fetchEvents(
      { accounts: ctx.repo.listAccounts(), getCalendar: ctx.getCalendar },
      new Date(startIso).toISOString(),
      new Date(endIso).toISOString()
    )
  )

  // ---- scan + usage
  ipcMain.handle(CH.scanRunNow, (_e, sinceMs?: unknown) => {
    if (sinceMs === undefined || sinceMs === null) return ctx.runNow()
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs) || sinceMs <= 0 || sinceMs > Date.now())
      return { status: 'done', stopReason: 'bad_time', triaged: 0, drafted: 0 }
    return ctx.runNow(sinceMs)
  })
  ipcMain.handle(
    CH.usageSummary,
    (): UsageSummary => ({
      thisMonth: ctx.repo.usageSummary(startOfMonth()),
      allTime: ctx.repo.usageSummary()
    })
  )
}
