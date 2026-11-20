// What a release offers (latest.json), version ordering and the download host allow-list.

const REPO = 'ZeinerMax/mail-assistant'
export const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

export type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'
const KEYS: PlatformKey[] = ['darwin-arm64', 'darwin-x64', 'win32-x64']

export interface UpdateFile {
  name: string
  sha256: string
  size: number
}

export interface Manifest {
  version: string
  notes: string
  files: Partial<Record<PlatformKey, UpdateFile>>
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) throw new Error('bad version')
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export function isNewer(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) > 0
  } catch {
    return false
  }
}

export function platformKey(platform: string, arch: string): PlatformKey | null {
  const k = `${platform}-${arch}` as PlatformKey
  return KEYS.includes(k) ? k : null
}

export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))
  } catch {
    return false
  }
}

export function fileUrl(version: string, name: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/${name}`
}

export function parseManifest(raw: unknown): Manifest {
  const bad = (): never => {
    throw new Error('bad manifest')
  }
  if (!raw || typeof raw !== 'object') bad()
  const r = raw as Record<string, unknown>
  if (typeof r.version !== 'string' || !SEMVER.test(r.version)) bad()
  if (!r.files || typeof r.files !== 'object') bad()
  const files: Manifest['files'] = {}
  for (const [key, v] of Object.entries(r.files as Record<string, unknown>)) {
    if (!KEYS.includes(key as PlatformKey)) continue
    const f = (v ?? {}) as Record<string, unknown>
    if (typeof f.name !== 'string' || !/^[\w.-]+$/.test(f.name) || f.name.startsWith('.')) bad()
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) bad()
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size <= 0) bad()
    files[key as PlatformKey] = { name: f.name as string, sha256: (f.sha256 as string).toLowerCase(), size: f.size as number }
  }
  return { version: r.version as string, notes: typeof r.notes === 'string' ? r.notes : '', files }
}
