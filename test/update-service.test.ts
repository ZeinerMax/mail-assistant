import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { UpdateState } from '@shared/ipc'
import { createUpdater } from '../src/main/update/service'
import { installWin } from '../src/main/update/install-win'
import { MANIFEST_URL, fileUrl } from '../src/main/update/manifest'
import type { FetchLike } from '../src/main/update/download'

const DATA = Buffer.from('new app bytes')
const SHA = createHash('sha256').update(DATA).digest('hex')
const NAME = 'Mail-Assistant-0.3.0-arm64-mac.zip'

function server(opts: { version?: string; files?: Record<string, unknown>; manifestStatus?: number; offline?: boolean; badFile?: () => boolean } = {}) {
  const fetches: string[] = []
  const f: FetchLike = async (url) => {
    fetches.push(url)
    if (opts.offline) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    if (url === MANIFEST_URL) {
      if (opts.manifestStatus) return new Response('Not Found', { status: opts.manifestStatus })
      return new Response(
        JSON.stringify({
          version: opts.version ?? '0.3.0',
          notes: 'Faster checks',
          files: opts.files ?? { 'darwin-arm64': { name: NAME, sha256: SHA, size: DATA.length } }
        })
      )
    }
    if (url === fileUrl(opts.version ?? '0.3.0', NAME)) return new Response(opts.badFile?.() ? 'garbage!!!!!!' : DATA)
    return new Response('nope', { status: 404 })
  }
  return { f, fetches }
}

function make(over: Partial<Parameters<typeof createUpdater>[0]> = {}) {
  const states: UpdateState[] = []
  const installs: string[] = []
  const log: string[] = []
  const u = createUpdater({
    currentVersion: '0.2.0',
    platform: 'darwin',
    arch: 'arm64',
    workRoot: mkdtempSync(join(tmpdir(), 'ma-upd-')),
    fetch: server().f,
    isBusy: () => false,
    beforeInstall: () => void log.push('beforeInstall'),
    install: async (file) => {
      log.push('install')
      installs.push(file)
    },
    quit: () => void log.push('quit'),
    emit: (s) => void states.push(s),
    sleep: async () => undefined,
    ...over
  })
  return { u, states, installs, log }
}

describe('update check', () => {
  it('newer manifest → available with notes', async () => {
    const { u } = make()
    expect(await u.check(false)).toEqual({ phase: 'available', version: '0.3.0', notes: 'Faster checks' })
  })

  it('same version → uptodate', async () => {
    const { u } = make({ fetch: server({ version: '0.2.0' }).f })
    expect((await u.check(true)).phase).toBe('uptodate')
  })

  it('no file for this platform → stays idle on automatic checks, uptodate on manual [RF 1]', async () => {
    const t = make({ fetch: server({ files: {} }).f })
    expect((await t.u.check(false)).phase).toBe('idle')
    expect(t.states.some((s) => s.phase === 'error')).toBe(false)
    expect((await t.u.check(true)).phase).toBe('uptodate')
  })

  it('manifest 404 (no release yet) → uptodate, no error', async () => {
    const { u } = make({ fetch: server({ manifestStatus: 404 }).f })
    expect((await u.check(true)).phase).toBe('uptodate')
  })

  it('network error: quiet when automatic, explained when manual', async () => {
    const { u } = make({ fetch: server({ offline: true }).f })
    expect((await u.check(false)).phase).toBe('idle')
    expect(await u.check(true)).toEqual({
      phase: 'error',
      message: 'Could not check for updates. Check your internet connection.'
    })
  })
})

describe('update and restart', () => {
  it('waits for a running mail check, then downloads, installs and quits', async () => {
    let busyPolls = 2
    const t = make({ isBusy: () => busyPolls-- > 0 })
    await t.u.check(false)
    await t.u.update()
    const phases = t.states.map((s) => s.phase)
    expect(phases).toContain('waiting')
    expect(phases.indexOf('waiting')).toBeLessThan(phases.indexOf('downloading'))
    expect(phases.indexOf('downloading')).toBeLessThan(phases.indexOf('installing'))
    expect(t.log).toEqual(['beforeInstall', 'install', 'quit'])
    expect(t.installs[0]).toMatch(/0\.3\.0[\\/]Mail-Assistant-0\.3\.0-arm64-mac\.zip$/)
  })

  it('double click → one install [RF 3]', async () => {
    const t = make()
    await t.u.check(false)
    await Promise.all([t.u.update(), t.u.update()])
    expect(t.installs).toHaveLength(1)
  })

  it('update before any check checks first', async () => {
    const t = make()
    await t.u.update()
    expect(t.installs).toHaveLength(1)
  })

  it('download failure → error with version; the next try works [RF 2]', async () => {
    let bad = true
    const t = make({ fetch: server({ badFile: () => bad }).f })
    await t.u.check(false)
    await t.u.update()
    expect(t.u.state()).toEqual({
      phase: 'error',
      version: '0.3.0',
      message: 'The update could not be downloaded. Try again or download it manually.'
    })
    expect(t.installs).toHaveLength(0)
    bad = false
    await t.u.update()
    expect(t.installs).toHaveLength(1)
  })

  it('an installer refusal is shown as is, and the app does not quit', async () => {
    const t = make({
      install: async () => {
        throw new Error('Mail Assistant is running from the disk image. Drag it into Applications first, then update.')
      }
    })
    await t.u.check(false)
    await t.u.update()
    expect(t.u.state()).toMatchObject({ phase: 'error', message: expect.stringContaining('disk image') })
    expect(t.log).not.toContain('quit')
  })
})

describe('installWin', () => {
  it('runs the NSIS installer silently and relaunches', () => {
    const calls: [string, string[]][] = []
    installWin('C:\\u\\Setup.exe', (f, a) => void calls.push([f, a]))
    expect(calls).toEqual([['C:\\u\\Setup.exe', ['/S', '--updated', '--force-run']]])
  })
})
