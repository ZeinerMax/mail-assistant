import { describe, it, expect } from 'vitest'
import { bundleFromExecPath, macRefusal, macSwapScript, installMac } from '../src/main/update/install-mac'

const APP = '/Applications/Mail Assistant.app'

describe('bundleFromExecPath', () => {
  it('finds the .app bundle of the running executable', () => {
    expect(bundleFromExecPath(`${APP}/Contents/MacOS/Mail Assistant`)).toBe(APP)
    expect(bundleFromExecPath('/usr/bin/node')).toBeNull()
  })
})

describe('macRefusal', () => {
  const yes = (): boolean => true
  it('refuses when running from the disk image', () => {
    expect(macRefusal('/Volumes/Mail Assistant/Mail Assistant.app', yes)).toBe(
      'Mail Assistant is running from the disk image. Drag it into Applications first, then update.'
    )
  })
  it('refuses when macOS translocated the app', () => {
    expect(macRefusal('/private/var/folders/x/AppTranslocation/ABC/d/Mail Assistant.app', yes)).toBe(
      'macOS is running Mail Assistant from a temporary location. Move it into Applications, open it from there, then update.'
    )
  })
  it('refuses when the folder is not writable', () => {
    expect(macRefusal(APP, () => false)).toBe(
      'Mail Assistant can’t replace itself in this folder. Use “Download manually” instead.'
    )
  })
  it('allows a normal install in Applications', () => {
    expect(macRefusal(APP, yes)).toBeNull()
  })
})

describe('macSwapScript', () => {
  it('waits, swaps with rollback, removes quarantine and reopens; paths are quoted [RF 4]', () => {
    const s = macSwapScript({ pid: 42, bundle: APP, newBundle: '/tmp/u/extract/Mail Assistant.app', workDir: '/tmp/u' })
    expect(s).toContain('while kill -0 42')
    expect(s).toContain("mv '/Applications/Mail Assistant.app' '/Applications/Mail Assistant.app.old'")
    expect(s).toContain("mv '/tmp/u/extract/Mail Assistant.app' '/Applications/Mail Assistant.app'")
    expect(s).toContain("xattr -dr com.apple.quarantine '/Applications/Mail Assistant.app'")
    expect(s).toContain("open '/Applications/Mail Assistant.app'")
    // rollback: restore the old bundle and reopen it
    expect(s).toMatch(/else[\s\S]*mv '\/Applications\/Mail Assistant\.app\.old' '\/Applications\/Mail Assistant\.app'/)
    // the old bundle is only removed after a successful swap
    expect(s.lastIndexOf("rm -rf '/Applications/Mail Assistant.app.old'")).toBeGreaterThan(s.indexOf('xattr')) // the first rm only clears a leftover from an earlier run
  })

  it("escapes single quotes in paths", () => {
    expect(macSwapScript({ pid: 1, bundle: "/A/it's.app", newBundle: '/n', workDir: '/w' })).toContain("'/A/it'\\''s.app'")
  })
})

describe('installMac', () => {
  const base = () => {
    const calls: { cmd: string; args: string[] }[] = []
    const spawned: string[] = []
    const written: Record<string, string> = {}
    return {
      calls,
      spawned,
      written,
      deps: {
        zipPath: '/u/0.3.0/Mail-Assistant-0.3.0-arm64-mac.zip',
        version: '0.3.0',
        execPath: `${APP}/Contents/MacOS/Mail Assistant`,
        pid: 7,
        workDir: '/u/0.3.0',
        run: async (cmd: string, args: string[]): Promise<string> => {
          calls.push({ cmd, args })
          return cmd.endsWith('PlistBuddy') ? '0.3.0\n' : ''
        },
        spawnDetached: (p: string) => void spawned.push(p),
        writeFile: (p: string, s: string) => void (written[p] = s),
        canWrite: () => true
      }
    }
  }

  it('extracts with ditto, checks the version, writes and starts the swap script', async () => {
    const t = base()
    await installMac(t.deps)
    expect(t.calls[0]).toEqual({ cmd: 'ditto', args: ['-x', '-k', t.deps.zipPath, '/u/0.3.0/extract'] })
    expect(t.calls[1].cmd).toBe('/usr/libexec/PlistBuddy')
    expect(t.calls[1].args).toEqual(['-c', 'Print :CFBundleShortVersionString', '/u/0.3.0/extract/Mail Assistant.app/Contents/Info.plist'])
    expect(t.spawned).toEqual(['/u/0.3.0/swap.sh'])
    expect(t.written['/u/0.3.0/swap.sh']).toContain('while kill -0 7')
  })

  it('version mismatch → no swap', async () => {
    const t = base()
    t.deps.run = async (cmd: string) => (cmd.endsWith('PlistBuddy') ? '0.2.9' : '')
    await expect(installMac(t.deps)).rejects.toThrow('version mismatch')
    expect(t.spawned).toEqual([])
  })

  it('refusal → nothing runs', async () => {
    const t = base()
    t.deps.execPath = '/Volumes/Mail Assistant/Mail Assistant.app/Contents/MacOS/Mail Assistant'
    await expect(installMac(t.deps)).rejects.toThrow('disk image')
    expect(t.calls).toEqual([])
  })
})
