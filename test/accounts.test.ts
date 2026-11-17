import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'
import { createAccountService, PALETTE, ReloginRequired, isInvalidGrant } from '../src/main/google/accounts'
import type { SecretStore } from '../src/main/secrets'

const memSecrets = (): SecretStore & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), delete: (k) => void map.delete(k) }
}

const invalidGrant = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } })

let repo: Repo
let secrets: ReturnType<typeof memSecrets>
let profiles: string[]
let refreshFails: boolean

const svc = () =>
  createAccountService({
    repo,
    secrets,
    signIn: async () => ({ refreshToken: 'rt-' + profiles[0] }),
    getProfile: async () => ({ emailAddress: profiles.shift()!, historyId: '777' }),
    makeAuth: (rt) => ({
      refreshToken: rt,
      getAccessToken: async () => {
        if (refreshFails) throw invalidGrant
        return { token: 'at' }
      }
    })
  })

beforeEach(() => {
  repo = new Repo(openDb(join(mkdtempSync(join(tmpdir(), 'ma-acc-')), 'db.sqlite')))
  secrets = memSecrets()
  profiles = []
  refreshFails = false
})

describe('account service', () => {
  it('adds account with profile email, history cursor and stored token', async () => {
    profiles = ['a@gmail.com']
    const a = await svc().addAccount()
    // No cursor yet: the first check then covers the last 24 hours (spec §8), not only mail arriving after sign-in.
    expect(a).toMatchObject({ email: 'a@gmail.com', lastHistoryId: null, lastCheckedAt: null, color: PALETTE[0], status: 'ok' })
    expect(secrets.get(`google:${a.id}`)).toBe('rt-a@gmail.com')
  })

  it('assigns next unused palette color', async () => {
    profiles = ['a@gmail.com', 'b@gmail.com']
    const s = svc()
    await s.addAccount()
    const b = await s.addAccount()
    expect(b.color).toBe(PALETTE[1])
  })

  it('duplicate email reuses row and resets status', async () => {
    profiles = ['a@gmail.com', 'a@gmail.com']
    const s = svc()
    const a = await s.addAccount()
    repo.setAccountStatus(a.id, 'needs_relogin')
    const again = await s.addAccount()
    expect(again.id).toBe(a.id)
    expect(again.status).toBe('ok')
    expect(repo.listAccounts()).toHaveLength(1)
  })

  it('invalid_grant → status needs_relogin + ReloginRequired', async () => {
    profiles = ['a@gmail.com']
    const s = svc()
    const a = await s.addAccount()
    refreshFails = true
    await expect(s.getAuth(a.id)).rejects.toBeInstanceOf(ReloginRequired)
    expect(repo.getAccount(a.id)!.status).toBe('needs_relogin')
  })

  it('missing token → ReloginRequired', async () => {
    profiles = ['a@gmail.com']
    const s = svc()
    const a = await s.addAccount()
    secrets.delete(`google:${a.id}`)
    await expect(s.getAuth(a.id)).rejects.toBeInstanceOf(ReloginRequired)
  })

  it('remove deletes secret and row', async () => {
    profiles = ['a@gmail.com']
    const s = svc()
    const a = await s.addAccount()
    s.removeAccount(a.id)
    expect(secrets.get(`google:${a.id}`)).toBeNull()
    expect(repo.listAccounts()).toEqual([])
  })

  it('isInvalidGrant recognises gaxios-style errors', () => {
    expect(isInvalidGrant(invalidGrant)).toBe(true)
    expect(isInvalidGrant(new Error('ECONNRESET'))).toBe(false)
  })
})
