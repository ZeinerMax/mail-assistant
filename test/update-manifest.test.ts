import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  isNewer,
  platformKey,
  isAllowedUrl,
  parseManifest,
  fileUrl,
  MANIFEST_URL,
  RELEASES_PAGE
} from '../src/main/update/manifest'

const H = 'a'.repeat(64)

describe('versions', () => {
  it('compares X.Y.Z numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1)
    expect(() => compareVersions('1.2', '1.2.0')).toThrow()
  })

  it('offers only strictly newer, well-formed versions', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false) // [RF 5]
    expect(isNewer('0.1.9', '0.2.0')).toBe(false) // [RF 5]
    expect(isNewer('0.2', '0.1.0')).toBe(false) // [RF 5]
    expect(isNewer('0.2.0-beta', '0.1.0')).toBe(false) // [RF 5]
  })
})

describe('platform + hosts', () => {
  it('maps platform/arch to manifest keys', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformKey('darwin', 'x64')).toBe('darwin-x64')
    expect(platformKey('win32', 'x64')).toBe('win32-x64')
    expect(platformKey('linux', 'x64')).toBeNull()
  })

  it('allows only HTTPS GitHub hosts', () => {
    expect(isAllowedUrl('https://github.com/ZeinerMax/mail-assistant/releases')).toBe(true)
    expect(isAllowedUrl('https://objects.githubusercontent.com/x')).toBe(true)
    expect(isAllowedUrl('http://github.com/x')).toBe(false)
    expect(isAllowedUrl('https://github.com.evil.io/x')).toBe(false)
    expect(isAllowedUrl('https://evilgithubusercontent.com/x')).toBe(false)
    expect(isAllowedUrl('not a url')).toBe(false)
  })

  it('builds release URLs', () => {
    expect(MANIFEST_URL).toBe('https://github.com/ZeinerMax/mail-assistant/releases/latest/download/latest.json')
    expect(RELEASES_PAGE).toBe('https://github.com/ZeinerMax/mail-assistant/releases/latest')
    expect(fileUrl('0.2.0', 'a.zip')).toBe('https://github.com/ZeinerMax/mail-assistant/releases/download/v0.2.0/a.zip')
  })
})

describe('parseManifest', () => {
  it('accepts a valid manifest; notes default to empty', () => {
    const m = parseManifest({ version: '0.2.0', files: { 'darwin-arm64': { name: 'a.zip', sha256: H, size: 5 } } })
    expect(m.notes).toBe('')
    expect(m.files['darwin-arm64']).toEqual({ name: 'a.zip', sha256: H, size: 5 })
  })

  it('a release without this platform has no file for it', () => {
    expect(parseManifest({ version: '0.2.0', files: {} }).files['darwin-x64']).toBeUndefined() // [RF 1]
  })

  it('rejects bad shapes', () => {
    const bad = (files: unknown, version: unknown = '0.2.0') => () => parseManifest({ version, files })
    expect(bad({ 'darwin-arm64': { name: '../x', sha256: H, size: 5 } })).toThrow('bad manifest')
    expect(bad({ 'darwin-arm64': { name: 'a.zip', sha256: 'xyz', size: 5 } })).toThrow('bad manifest')
    expect(bad({ 'darwin-arm64': { name: 'a.zip', sha256: H, size: 0 } })).toThrow('bad manifest')
    expect(bad({}, 7)).toThrow('bad manifest')
    expect(() => parseManifest(null)).toThrow('bad manifest')
  })

  it('ignores unknown platform keys', () => {
    const m = parseManifest({ version: '0.2.0', files: { 'linux-x64': { name: 'a', sha256: H, size: 1 } } })
    expect(Object.keys(m.files)).toEqual([])
  })
})
