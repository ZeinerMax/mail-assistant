import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseManifest } from '../src/main/update/manifest'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('scripts/make-manifest.mjs', () => {
  it('maps release files to platform keys with sha256 and size', () => {
    const d = mkdtempSync(join(tmpdir(), 'ma-rel-'))
    const files: Record<string, string> = {
      'Mail-Assistant-0.2.0-arm64-mac.zip': 'arm',
      'Mail-Assistant-0.2.0-x64-mac.zip': 'intel!',
      'Mail-Assistant-0.2.0-Setup.exe': 'windows-setup',
      'Mail-Assistant-0.2.0-arm64.dmg': 'ignored'
    }
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c)
    const out = execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'make-manifest.mjs'), d, '0.2.0', 'Faster checks'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const m = parseManifest(JSON.parse(out))
    expect(m.version).toBe('0.2.0')
    expect(m.notes).toBe('Faster checks')
    expect(m.files).toEqual({
      'darwin-arm64': { name: 'Mail-Assistant-0.2.0-arm64-mac.zip', sha256: sha('arm'), size: 3 },
      'darwin-x64': { name: 'Mail-Assistant-0.2.0-x64-mac.zip', sha256: sha('intel!'), size: 6 },
      'win32-x64': { name: 'Mail-Assistant-0.2.0-Setup.exe', sha256: sha('windows-setup'), size: 13 }
    })
  })

  it('fails when a platform file is missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'ma-rel-'))
    writeFileSync(join(d, 'Mail-Assistant-0.2.0-Setup.exe'), 'x')
    expect(() =>
      execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'make-manifest.mjs'), d, '0.2.0', ''], {
        stdio: 'pipe',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
    ).toThrow()
  })
})
