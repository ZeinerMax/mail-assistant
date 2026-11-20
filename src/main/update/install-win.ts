// Windows: the verified NSIS installer runs silently (per-user install, no admin prompt) and starts the
// new version when it is done (`--force-run`); the app quits right after starting it.
export function installWin(setupPath: string, spawnDetached: (file: string, args: string[]) => void): void {
  spawnDetached(setupPath, ['/S', '--updated', '--force-run'])
}
