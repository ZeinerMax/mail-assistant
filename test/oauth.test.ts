import { describe, it, expect } from 'vitest'
import { SCOPES, runLoopbackAuth, type OAuthLike } from '../src/main/google/oauth'

function fakeClient(tokens: { refresh_token?: string | null; access_token?: string }) {
  let authOpts: Record<string, unknown> = {}
  let redirectUri = ''
  const client: OAuthLike = {
    generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier-1', codeChallenge: 'challenge-1' }),
    generateAuthUrl: (o) => {
      authOpts = o as Record<string, unknown>
      return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + o.state
    },
    getToken: async (o) => {
      expect(o.codeVerifier).toBe('verifier-1')
      expect(o.redirect_uri).toBe(redirectUri)
      return { tokens }
    }
  }
  return {
    client,
    create: (r: string) => {
      redirectUri = r
      return client
    },
    get authOpts() {
      return authOpts
    },
    get redirectUri() {
      return redirectUri
    }
  }
}

/** Simulates the browser: once the auth URL is "opened", hit the loopback redirect. */
function browser(fc: ReturnType<typeof fakeClient>, query: (state: string) => string) {
  return async (url: string): Promise<void> => {
    const state = new URL(url).searchParams.get('state')!
    setTimeout(() => void fetch(`${fc.redirectUri}?${query(state)}`).catch(() => {}), 10)
  }
}

describe('google oauth', () => {
  it('SCOPES equals the two readonly scopes exactly', () => {
    expect([...SCOPES]).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly'
    ])
  })

  it('happy path: PKCE S256, offline access, loopback redirect, returns refresh token', async () => {
    const fc = fakeClient({ refresh_token: 'r-1', access_token: 'a-1' })
    const res = await runLoopbackAuth({
      clientId: 'id',
      clientSecret: 'secret',
      openUrl: browser(fc, (s) => `code=abc&state=${s}`),
      createClient: fc.create
    })
    expect(res).toEqual({ refreshToken: 'r-1', accessToken: 'a-1' })
    expect(fc.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(fc.authOpts).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...SCOPES],
      code_challenge_method: 'S256',
      code_challenge: 'challenge-1'
    })
  })

  it('rejects callback with wrong state', async () => {
    const fc = fakeClient({ refresh_token: 'r' })
    await expect(
      runLoopbackAuth({
        clientId: 'id',
        clientSecret: 's',
        openUrl: browser(fc, () => `code=abc&state=forged`),
        createClient: fc.create
      })
    ).rejects.toThrow(/state/i)
  })

  it('rejects callback with error=access_denied', async () => {
    const fc = fakeClient({ refresh_token: 'r' })
    await expect(
      runLoopbackAuth({
        clientId: 'id',
        clientSecret: 's',
        openUrl: browser(fc, (s) => `error=access_denied&state=${s}`),
        createClient: fc.create
      })
    ).rejects.toThrow('Sign-in was cancelled')
  })

  it('times out and closes server', async () => {
    const fc = fakeClient({ refresh_token: 'r' })
    await expect(
      runLoopbackAuth({ clientId: 'id', clientSecret: 's', openUrl: async () => {}, createClient: fc.create, timeoutMs: 100 })
    ).rejects.toThrow(/timed out/i)
    await expect(fetch(fc.redirectUri)).rejects.toThrow()
  })

  it('rejects when no refresh_token returned', async () => {
    const fc = fakeClient({ refresh_token: null, access_token: 'a' })
    await expect(
      runLoopbackAuth({
        clientId: 'id',
        clientSecret: 's',
        openUrl: browser(fc, (s) => `code=abc&state=${s}`),
        createClient: fc.create
      })
    ).rejects.toThrow(/refresh/i)
  })
})
