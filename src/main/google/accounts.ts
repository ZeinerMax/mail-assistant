import type { Account } from '@shared/types'
import type { Repo } from '../db/repo'
import type { SecretStore } from '../secrets'

export const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2']

export class ReloginRequired extends Error {
  constructor(public accountId: number) {
    super('This account needs you to sign in again.')
    this.name = 'ReloginRequired'
  }
}

/** Google returns invalid_grant when a refresh token was revoked/expired (password change, revocation, Testing-mode 7 days). */
export function isInvalidGrant(e: unknown): boolean {
  const err = e as { message?: unknown; response?: { data?: { error?: unknown } } }
  return err?.response?.data?.error === 'invalid_grant' || (typeof err?.message === 'string' && err.message.includes('invalid_grant'))
}

/** Minimal auth object: an OAuth2Client with credentials set. */
export interface AuthLike {
  getAccessToken(): Promise<unknown>
}

export interface AccountDeps<A extends AuthLike> {
  repo: Repo
  secrets: SecretStore
  /** Runs the browser sign-in and returns a refresh token. */
  signIn: () => Promise<{ refreshToken: string }>
  /** Gmail users.getProfile with a fresh auth for that token. */
  getProfile: (refreshToken: string) => Promise<{ emailAddress: string; historyId: string }>
  /** Builds an authed client from a refresh token. */
  makeAuth: (refreshToken: string) => A
}

const tokenKey = (id: number): string => `google:${id}`

export function createAccountService<A extends AuthLike>(deps: AccountDeps<A>) {
  const { repo, secrets } = deps

  function nextColor(): string {
    const used = new Set(repo.listAccounts().map((a) => a.color))
    return PALETTE.find((c) => !used.has(c)) ?? PALETTE[repo.listAccounts().length % PALETTE.length]
  }

  async function addAccount(): Promise<Account> {
    const { refreshToken } = await deps.signIn()
    const profile = await deps.getProfile(refreshToken)
    const existing = repo.findAccountByEmail(profile.emailAddress)
    if (existing) {
      secrets.set(tokenKey(existing.id), refreshToken)
      repo.setAccountStatus(existing.id, 'ok')
      return repo.getAccount(existing.id)!
    }
    const n = repo.listAccounts().length + 1
    const account = repo.addAccount({
      email: profile.emailAddress,
      label: `Account ${n}`,
      color: nextColor(),
      // No cursor yet → the first check lists the last 24 hours, then stores Gmail's history id.
      lastHistoryId: null
    })
    try {
      secrets.set(tokenKey(account.id), refreshToken)
    } catch (e) {
      repo.removeAccount(account.id)
      throw e
    }
    return account
  }

  /** Re-runs sign-in; the signed-in Google account must match. */
  async function relogin(accountId: number): Promise<Account> {
    const acc = repo.getAccount(accountId)
    if (!acc) throw new Error('Account not found')
    const { refreshToken } = await deps.signIn()
    const profile = await deps.getProfile(refreshToken)
    if (profile.emailAddress.toLowerCase() !== acc.email.toLowerCase()) {
      throw new Error(`You signed in as ${profile.emailAddress}, but this account is ${acc.email}.`)
    }
    secrets.set(tokenKey(acc.id), refreshToken)
    repo.setAccountStatus(acc.id, 'ok')
    return repo.getAccount(acc.id)!
  }

  function removeAccount(accountId: number): void {
    secrets.delete(tokenKey(accountId))
    repo.removeAccount(accountId)
  }

  /** Returns a ready auth client, or marks the account and throws ReloginRequired. */
  async function getAuth(accountId: number): Promise<A> {
    const rt = secrets.get(tokenKey(accountId))
    if (!rt) {
      repo.setAccountStatus(accountId, 'needs_relogin')
      throw new ReloginRequired(accountId)
    }
    const auth = deps.makeAuth(rt)
    try {
      await auth.getAccessToken()
    } catch (e) {
      if (isInvalidGrant(e)) {
        repo.setAccountStatus(accountId, 'needs_relogin')
        throw new ReloginRequired(accountId)
      }
      throw e
    }
    return auth
  }

  return { addAccount, relogin, removeAccount, getAuth }
}

export type AccountService<A extends AuthLike = AuthLike> = ReturnType<typeof createAccountService<A>>
