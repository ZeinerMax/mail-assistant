import type { Account, ImapSettings } from '@shared/types'
import type { Repo } from '../db/repo'
import type { SecretStore } from '../secrets'
import { PALETTE, ReloginRequired } from '../google/accounts'
import type { GmailLike } from '../google/gmail'
import { imapAsGmail, type ImapClientLike, type ParseFn } from './source'

export const imapKey = (id: number): string => `imap:${id}`

export class ImapSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImapSetupError'
  }
}

export interface ImapAccountInput {
  email: string
  host: string
  port: number
  user: string
  password: string
}

export function validateImapInput(raw: unknown): ImapAccountInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const email = str(r.email)
  const host = str(r.host).toLowerCase()
  const user = str(r.user)
  const password = typeof r.password === 'string' ? r.password : ''
  const port = Number(r.port)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ImapSetupError('Enter the email address of this mailbox.')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new ImapSetupError('Enter the IMAP server, e.g. mail.example.com.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ImapSetupError('Enter the port (usually 993).')
  if (!user) throw new ImapSetupError('Enter the user name (usually the full email address).')
  if (!password) throw new ImapSetupError('Enter the password.')
  return { email, host, port, user, password }
}

export interface ImapAccountDeps {
  repo: Repo
  secrets: SecretStore
  makeClient: (s: ImapSettings, password: string) => ImapClientLike
  parse: ParseFn
}

export function createImapAccounts(deps: ImapAccountDeps) {
  const { repo, secrets } = deps

  /** Logs in and opens INBOX read-only; turns failures into readable messages. */
  async function test(s: ImapSettings, password: string): Promise<void> {
    const c = deps.makeClient(s, password)
    try {
      await c.connect()
      const lock = await c.getMailboxLock('INBOX', { readOnly: true })
      lock.release()
    } catch (e) {
      const err = e as { authenticationFailed?: boolean; code?: string }
      if (err?.authenticationFailed) throw new ImapSetupError('The server rejected the user name or password.')
      if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') throw new ImapSetupError(`Server "${s.host}" was not found.`)
      if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'ConnectionTimeout')
        throw new ImapSetupError(`Could not connect to ${s.host}:${s.port}. Check the server and port.`)
      throw new ImapSetupError('Could not open the mailbox. Check the server, port, user name and password.')
    } finally {
      await c.logout().catch(() => undefined)
    }
  }

  function nextColor(): string {
    const used = new Set(repo.listAccounts().map((a) => a.color))
    return PALETTE.find((c) => !used.has(c)) ?? PALETTE[repo.listAccounts().length % PALETTE.length]
  }

  async function addAccount(raw: unknown): Promise<Account> {
    const input = validateImapInput(raw)
    const s: ImapSettings = { host: input.host, port: input.port, user: input.user }
    await test(s, input.password)
    const existing = repo.findAccountByEmail(input.email)
    if (existing) {
      if (existing.kind !== 'imap') throw new ImapSetupError('This address is already connected as a Gmail account.')
      repo.setImapSettings(existing.id, s)
      secrets.set(imapKey(existing.id), input.password)
      repo.setAccountStatus(existing.id, 'ok')
      return repo.getAccount(existing.id)!
    }
    const account = repo.addImapAccount({
      email: input.email,
      label: `Account ${repo.listAccounts().length + 1}`,
      color: nextColor(),
      ...s
    })
    try {
      secrets.set(imapKey(account.id), input.password)
    } catch (e) {
      repo.removeAccount(account.id)
      throw e
    }
    return account
  }

  async function setPassword(accountId: number, password: unknown): Promise<Account> {
    const acc = repo.getAccount(accountId)
    if (!acc?.imap) throw new ImapSetupError('Account not found.')
    if (typeof password !== 'string' || !password) throw new ImapSetupError('Enter the password.')
    await test(acc.imap, password)
    secrets.set(imapKey(acc.id), password)
    repo.setAccountStatus(acc.id, 'ok')
    return repo.getAccount(acc.id)!
  }

  /** A read-only mailbox for one check. A wrong/missing password marks the account "needs sign-in". */
  function open(accountId: number): GmailLike & { close(): Promise<void> } {
    const acc = repo.getAccount(accountId)
    const password = secrets.get(imapKey(accountId))
    if (!acc?.imap || !password) {
      repo.setAccountStatus(accountId, 'needs_relogin')
      throw new ReloginRequired(accountId)
    }
    const s = acc.imap
    return imapAsGmail(() => deps.makeClient(s, password), deps.parse, {
      onAuthFailed: () => {
        repo.setAccountStatus(accountId, 'needs_relogin')
        return new ReloginRequired(accountId)
      }
    })
  }

  function setSmtp(accountId: number, raw: unknown): Account {
    const acc = repo.getAccount(accountId)
    if (!acc?.imap) throw new ImapSetupError('Account not found.')
    const r = (raw ?? {}) as Record<string, unknown>
    const host = (typeof r.host === 'string' ? r.host.trim() : '').toLowerCase()
    const port = Number(r.port)
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new ImapSetupError('Enter the outgoing (SMTP) server, e.g. smtp.example.com.')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ImapSetupError('Enter the outgoing port (usually 465 or 587).')
    repo.setSmtpSettings(acc.id, { host, port })
    return repo.getAccount(acc.id)!
  }

  return { addAccount, setPassword, setSmtp, open, removeSecret: (id: number) => secrets.delete(imapKey(id)) }
}

export type ImapAccounts = ReturnType<typeof createImapAccounts>
