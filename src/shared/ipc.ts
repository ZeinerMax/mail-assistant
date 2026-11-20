import type { Account, AccountKind, Settings, StatusEvent, Tag, UsageRow } from './types'

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
  accountsAddImap: 'accounts:addImap',
  accountsImapPassword: 'accounts:imapPassword',
  mailList: 'mail:list',
  mailMessage: 'mail:message',
  mailThread: 'mail:thread',
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
  accountKind: AccountKind
  /** Owner already replied: no draft, shown as "already answered". */
  answered: boolean
  /** Messages in the conversation, when known. */
  threadSize: number | null
  /** Gmail web link (null for IMAP accounts, which have no web link). */
  webUrl: string | null
}

/** One email in full, fetched live for the reader view (never stored). */
export interface FullMessage {
  id: string
  fromName: string
  fromEmail: string
  to: string
  date: number
  subject: string
  text: string
  fromOwner: boolean
  isTarget: boolean
}

export interface ImapAccountForm {
  email: string
  host: string
  port: number
  user: string
  password: string
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
    /** Add a non-Gmail mailbox over IMAP (tests the login first). */
    addImap(form: ImapAccountForm): Promise<Result<Account>>
    /** New password for an IMAP account. */
    setImapPassword(id: number, password: string): Promise<Result<Account>>
  }
  mail: {
    list(filter: { tag?: Tag; accountId?: number }): Promise<MailItem[]>
    /** The whole email, fetched live. */
    message(emailId: number): Promise<Result<FullMessage>>
    /** The whole conversation, oldest first, fetched live. */
    thread(emailId: number): Promise<Result<FullMessage[]>>
  }
  drafts: {
    list(): Promise<DraftItem[]>
    markSeen(id: number): Promise<void>
    copy(id: number): Promise<void>
    /** Manually write a draft for one email. */
    create(emailId: number): Promise<{ ok: boolean; error?: string }>
  }
  usage: { summary(): Promise<UsageSummary> }
  /** sinceMs: check all inbox mail received since then (otherwise only mail new since the last check). */
  scan: { runNow(sinceMs?: number): Promise<RunResultView> }
  calendar: { events(startIso: string, endIso: string): Promise<CalResult> }
  onStatus(cb: (s: StatusEvent) => void): () => void
  onBadge(cb: (unseenDrafts: number) => void): () => void
  onDataChanged(cb: () => void): () => void
}

/** Where the app's own update stands (shown in the banner and in Settings). */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes: string }
  | { phase: 'waiting'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; message: string; version?: string }
  | { phase: 'uptodate'; checkedAt: number }
