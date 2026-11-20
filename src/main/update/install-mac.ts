import { posix } from 'path'

// macOS self-update for the unsigned (ad-hoc signed) app: the standard updater refuses unsigned apps,
// so after a verified download we unpack the new bundle, and a small detached shell script swaps it in
// once the app has quit. If the swap fails, the old bundle is put back and reopened.

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export function bundleFromExecPath(execPath: string): string | null {
  const i = execPath.indexOf('.app/Contents/MacOS/')
  return i < 0 ? null : execPath.slice(0, i + 4)
}

export function macRefusal(bundle: string, canWrite: (dir: string) => boolean): string | null {
  if (bundle.startsWith('/Volumes/'))
    return 'Mail Assistant is running from the disk image. Drag it into Applications first, then update.'
  if (bundle.includes('AppTranslocation'))
    return 'macOS is running Mail Assistant from a temporary location. Move it into Applications, open it from there, then update.'
  if (!canWrite(posix.dirname(bundle))) return 'Mail Assistant can’t replace itself in this folder. Use “Download manually” instead.'
  return null
}

export function macSwapScript(p: {
  pid: number
  bundle: string
  newBundle: string
  workDir: string
  /** Every step is appended here, so a failed update on the Mac can be diagnosed. */
  logFile?: string
  /** Created when the swap fails; the app then stops offering this version. */
  failMarker?: string
}): string {
  const app = q(p.bundle)
  const old = q(p.bundle + '.old')
  const fail = p.failMarker ? `: > ${q(p.failMarker)}; ` : ''
  return [
    '#!/bin/sh',
    ...(p.logFile ? [`exec >>${q(p.logFile)} 2>&1`, 'set -x', 'echo "update swap started $(date)"'] : []),
    `while kill -0 ${p.pid} 2>/dev/null; do sleep 0.5; done`,
    `rm -rf ${old}`,
    `mv ${app} ${old} || { ${fail}open ${app}; exit 1; }`,
    `if mv ${q(p.newBundle)} ${app}; then`,
    `  xattr -dr com.apple.quarantine ${app} 2>/dev/null`,
    `  open ${app}`,
    `  rm -rf ${old}`,
    `  rm -rf ${q(p.workDir)}`,
    'else',
    ...(p.failMarker ? [`  : > ${q(p.failMarker)}`] : []),
    `  mv ${old} ${app}`,
    `  open ${app}`,
    'fi',
    ''
  ].join('\n')
}

export interface MacInstallDeps {
  zipPath: string
  version: string
  execPath: string
  pid: number
  workDir: string
  run: (cmd: string, args: string[]) => Promise<string>
  spawnDetached: (scriptPath: string) => void
  writeFile: (p: string, s: string) => void
  canWrite: (dir: string) => boolean
  logFile?: string
  failMarker?: string
}

/** Prepares the new bundle and starts the swap script. The caller quits the app afterwards. */
export async function installMac(d: MacInstallDeps): Promise<void> {
  const bundle = bundleFromExecPath(d.execPath)
  if (!bundle) throw new Error('Mail Assistant can’t find its own app bundle. Use “Download manually” instead.')
  const refusal = macRefusal(bundle, d.canWrite)
  if (refusal) throw new Error(refusal)
  const extract = posix.join(d.workDir, 'extract')
  await d.run('ditto', ['-x', '-k', d.zipPath, extract])
  const newBundle = posix.join(extract, posix.basename(bundle))
  const v = (await d.run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', posix.join(newBundle, 'Contents/Info.plist')])).trim()
  if (v !== d.version) throw new Error('version mismatch')
  const script = posix.join(d.workDir, 'swap.sh')
  d.writeFile(
    script,
    macSwapScript({ pid: d.pid, bundle, newBundle, workDir: d.workDir, logFile: d.logFile, failMarker: d.failMarker })
  )
  d.spawnDetached(script)
}
