import { createHash } from 'crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'fs'
import { dirname } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { isAllowedUrl, type UpdateFile } from './manifest'

// Downloads with Node's own HTTP client (fetch): the file gets no macOS quarantine attribute.
// Every hop must stay on GitHub over HTTPS; the file is only kept if size and SHA-256 match.

export type FetchLike = (url: string, init?: { redirect: 'manual' }) => Promise<Response>

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export async function fetchFollowingAllowed(fetchImpl: FetchLike, url: string, maxRedirects = 5): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedUrl(current)) throw new Error('blocked host')
    const res = await fetchImpl(current, { redirect: 'manual' })
    if (!REDIRECTS.has(res.status)) return res
    const loc = res.headers.get('location')
    if (!loc) throw new Error('redirect without location')
    current = new URL(loc, current).toString()
  }
  throw new Error('too many redirects')
}

export async function downloadVerified(
  fetchImpl: FetchLike,
  url: string,
  dest: string,
  file: UpdateFile,
  onProgress: (pct: number) => void
): Promise<void> {
  const part = dest + '.part'
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(part, { force: true })
  try {
    const res = await fetchFollowingAllowed(fetchImpl, url)
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
    const hash = createHash('sha256')
    let bytes = 0
    let lastPct = -1
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        hash.update(chunk)
        const pct = Math.min(100, Math.floor((bytes / file.size) * 100))
        if (pct !== lastPct) {
          lastPct = pct
          onProgress(pct)
        }
        cb(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), meter, createWriteStream(part))
    if (bytes !== file.size) throw new Error('size mismatch')
    if (hash.digest('hex') !== file.sha256.toLowerCase()) throw new Error('checksum mismatch')
    rmSync(dest, { force: true })
    renameSync(part, dest)
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
}
