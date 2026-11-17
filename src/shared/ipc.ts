import type { Account, Settings, StatusEvent, Tag, UsageRow } from './types'

/** Every renderer→main call goes through one of these channels (ipcRenderer.invoke / ipcMain.handle). */
export const CH = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  apiKeySet: 'apiKey:set',
  apiKeyStatus: 'apiKey:status',
  apiKeyTest: 'apiKey:test',
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsRelogin: 'accounts:relogin',
  accountsRemove: 'accounts:remove',
  accountsRename: 'accounts:rename',
  mailList: 'mail:list',
  draftsList: 'drafts:list',
  draftsMarkSeen: 'drafts:markSeen',
  draftsCopy: 'drafts:copy',
  draftsCreate: 'drafts:create',
  usageSummary: 'usage:summary',
  scanRunNow: 'scan:runNow',
  calendarEvents: 'calendar:events',
  // main → renderer events
  evStatus: 'ev:status',
  evBadge: 'ev:badge',
  evDataChanged: 'ev:dataChanged'
} as const

/** Errors cross IPC as plain results so the UI can show friendly text. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface MailItem {
  id: number
  accountId: number
  accountLabel: string
  color: string
  fromName: string
  fromEmail: string
  subject: string
  receivedAt: number
  summary: string | null
  tag: Tag | null
  state: 'pending' | 'triaged' | 'failed' | 'skipped'
  hasDraft: boolean
}

export interface DraftItem {
  id: number
  emailId: number
  accountId: number
  accountLabel: string
  color: string
  fromName: string
  fromEmail: string
  subject: string
  summary: string | null
  receivedAt: number
  body: string
  createdAt: number
  seen: boolean
  copied: boolean
}

export interface CalEvent {
  id: string
  accountId: number
  color: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
}

export interface CalResult {
  events: CalEvent[]
  skipped: { accountId: number; label: string; reason: 'needs_relogin' | 'error' }[]
}

export interface UsageSummary {
  thisMonth: UsageRow[]
  allTime: UsageRow[]
}

export interface RunResultView {
  status: 'done' | 'already_running' | 'no_api_key' | 'no_accounts'
  stopReason: string
  triaged: number
  drafted: number
}

export interface Api {
  settings: {
    get(): Promise<Settings>
    save(patch: Partial<Settings>): Promise<Result<Settings>>
  }
  apiKey: {
    set(key: string): Promise<Result<{ last4: string }>>
    status(): Promise<{ set: boolean; last4?: string }>
    test(): Promise<{ ok: boolean; error?: string }>
  }
  accounts: {
    list(): Promise<Account[]>
    add(): Promise<Result<Account>>
    relogin(id: number): Promise<Result<Account>>
    remove(id: number): Promise<Result<true>>
    rename(id: number, label: string): Promise<Result<true>>
  }
  mail: {
    list(filter: { tag?: Tag; accountId?: number }): Promise<MailItem[]>
  }
  drafts: {
    list(): Promise<DraftItem[]>
    markSeen(id: number): Promise<void>
    copy(id: number): Promise<void>
    /** Manually write a draft for one email. */
    create(emailId: number): Promise<{ ok: boolean; error?: string }>
  }
  usage: { summary(): Promise<UsageSummary> }
  scan: { runNow(): Promise<RunResultView> }
  calendar: { events(startIso: string, endIso: string): Promise<CalResult> }
  onStatus(cb: (s: StatusEvent) => void): () => void
  onBadge(cb: (unseenDrafts: number) => void): () => void
  onDataChanged(cb: () => void): () => void
}
