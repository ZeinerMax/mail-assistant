import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { downloadVerified, fetchFollowingAllowed, type FetchLike } from '../src/main/update/download'

const DATA = Buffer.from('x'.repeat(1000))
const SHA = createHash('sha256').update(DATA).digest('hex')
const FILE = { name: 'a.zip', sha256: SHA, size: DATA.length }
const URL1 = 'https://github.com/o/r/releases/download/v1.0.0/a.zip'
const CDN = 'https://objects.githubusercontent.com/blob'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ma-dl-'))

/** Serves a redirect from github.com to the CDN, like GitHub does. */
function fakeFetch(body: () => BodyInit | null, opts: { redirectTo?: string } = {}): FetchLike {
  return async (url) => {
    if (url === URL1) return new Response(null, { status: 302, headers: { location: opts.redirectTo ?? CDN } })
    if (url === CDN) return new Response(body(), { status: 200 })
    return new Response('nope', { status: 404 })
  }
}

describe('downloadVerified', () => {
  it('downloads, verifies and renames', async () => {
    const d = dir()
    const dest = join(d, 'a.zip')
    const progress: number[] = []
    await downloadVerified(fakeFetch(() => DATA), URL1, dest, FILE, (p) => progress.push(p))
    expect(readFileSync(dest).equals(DATA)).toBe(true)
    expect(existsSync(dest + '.part')).toBe(false)
    expect(progress.at(-1)).toBe(100)
  })

  it('checksum mismatch deletes the file', async () => {
    const d = dir()
    const dest = join(d, 'a.zip')
    await expect(
      downloadVerified(fakeFetch(() => Buffer.from('y'.repeat(1000))), URL1, dest, FILE, () => undefined)
    ).rejects.toThrow('checksum mismatch')
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(dest + '.part')).toBe(false)
  })

  it('size mismatch is rejected', async () => {
    const dest = join(dir(), 'a.zip')
    await expect(downloadVerified(fakeFetch(() => DATA.subarray(0, 10)), URL1, dest, FILE, () => undefined)).rejects.toThrow(
      'size mismatch'
    )
  })

  it('stream error mid-download removes the partial file; a retry starts clean', async () => {
    // [RF 2]
    const d = dir()
    const dest = join(d, 'a.zip')
    const broken = (): ReadableStream =>
      new ReadableStream({
        start(c) {
          c.enqueue(DATA.subarray(0, 100))
          c.error(new Error('connection reset'))
        }
      })
    await expect(downloadVerified(fakeFetch(broken), URL1, dest, FILE, () => undefined)).rejects.toThrow()
    expect(existsSync(dest + '.part')).toBe(false)
    await downloadVerified(fakeFetch(() => DATA), URL1, dest, FILE, () => undefined)
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  it('redirect to a non-GitHub host is blocked', async () => {
    const dest = join(dir(), 'a.zip')
    await expect(
      downloadVerified(fakeFetch(() => DATA, { redirectTo: 'https://evil.example/x' }), URL1, dest, FILE, () => undefined)
    ).rejects.toThrow('blocked host')
  })

  it('a non-GitHub start URL is blocked before any request', async () => {
    let called = false
    const f: FetchLike = async () => {
      called = true
      return new Response('x')
    }
    await expect(fetchFollowingAllowed(f, 'https://evil.example/latest.json')).rejects.toThrow('blocked host')
    expect(called).toBe(false)
  })
})
