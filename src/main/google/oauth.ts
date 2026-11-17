import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { OAuth2Client, CodeChallengeMethod, type GenerateAuthUrlOpts, type GetTokenOptions } from 'google-auth-library'

/** READ-ONLY. Never add other scopes (enforced by test/no-write-paths.test.ts and test/oauth.test.ts). */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly'
] as const

export class MissingGoogleCredentials extends Error {
  constructor() {
    super('This build has no Google client ID. See README → Google Cloud setup.')
    this.name = 'MissingGoogleCredentials'
  }
}

/** Injected at build time by electron-vite (MAIN_VITE_* is only exposed to the main process). */
export function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID as string | undefined
  const clientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET as string | undefined
  if (!clientId || !clientSecret) throw new MissingGoogleCredentials()
  return { clientId, clientSecret }
}

/** The subset of OAuth2Client we use (verified in google-auth-library 11 oauth2client.d.ts). */
export interface OAuthLike {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>
  generateAuthUrl(opts: GenerateAuthUrlOpts): string
  getToken(opts: GetTokenOptions): Promise<{ tokens: { refresh_token?: string | null; access_token?: string | null } }>
}

export interface LoopbackAuthOptions {
  clientId: string
  clientSecret: string
  openUrl: (url: string) => Promise<void>
  timeoutMs?: number
  createClient?: (redirectUri: string) => OAuthLike
}

const DONE_PAGE = (ok: boolean, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Mail Assistant</title>` +
  `<body style="font-family:system-ui;padding:48px;text-align:center">` +
  `<h2>${ok ? 'Signed in ✓' : 'Sign-in did not finish'}</h2><p>${text}</p></body>`

/**
 * Google's installed-app flow: system browser + PKCE (S256) + loopback redirect on 127.0.0.1.
 * Resolves with a refresh token. The local server always closes (success, error or timeout).
 */
export function runLoopbackAuth(opts: LoopbackAuthOptions): Promise<{ refreshToken: string; accessToken: string }> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const state = randomBytes(16).toString('hex')
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null

  const cleanup = (): void => {
    if (timer) clearTimeout(timer)
    if (server) {
      server.closeAllConnections?.()
      server.close()
    }
    server = null
  }

  return new Promise((resolve, reject) => {
    const fail = (e: Error): void => {
      cleanup()
      reject(e)
    }
    server = createServer()
    server.on('error', (e) => fail(e))
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = (server!.address() as AddressInfo).port
        const redirectUri = `http://127.0.0.1:${port}`
        const client: OAuthLike =
          opts.createClient?.(redirectUri) ??
          new OAuth2Client({ clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri })
        const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()

        server!.on('request', async (req, res) => {
          const url = new URL(req.url ?? '/', redirectUri)
          if (url.pathname !== '/') {
            res.writeHead(404).end()
            return
          }
          const reply = (ok: boolean, text: string): void => {
            res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
            res.end(DONE_PAGE(ok, text))
          }
          if (url.searchParams.get('state') !== state) {
            reply(false, 'Security check failed. Please try again from Mail Assistant.')
            return fail(new Error('Sign-in failed a security check (state mismatch). Please try again.'))
          }
          const err = url.searchParams.get('error')
          if (err) {
            reply(false, 'You can close this window.')
            return fail(new Error(err === 'access_denied' ? 'Sign-in was cancelled' : 'Sign-in failed'))
          }
          const code = url.searchParams.get('code')
          if (!code) {
            reply(false, 'No sign-in code received.')
            return fail(new Error('Sign-in failed'))
          }
          try {
            const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
            if (!tokens.refresh_token) {
              reply(false, 'Please try again.')
              return fail(new Error('Google did not return a refresh token. Please try again.'))
            }
            reply(true, 'You can close this window and return to Mail Assistant.')
            cleanup()
            resolve({ refreshToken: tokens.refresh_token, accessToken: tokens.access_token ?? '' })
          } catch {
            reply(false, 'Please try again.')
            fail(new Error('Sign-in failed while exchanging the code'))
          }
        })

        const authUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [...SCOPES],
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: codeChallenge,
          state,
          redirect_uri: redirectUri
        })
        timer = setTimeout(() => fail(new Error('Sign-in timed out. Please try again.')), timeoutMs)
        await opts.openUrl(authUrl)
      } catch (e) {
        fail(e instanceof Error ? e : new Error('Sign-in failed'))
      }
    })
  })
}
