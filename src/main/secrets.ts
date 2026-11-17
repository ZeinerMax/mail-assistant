import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** Thin abstraction over Electron safeStorage (see secrets-electron.ts) so it can be faked in tests. */
export interface Cipher {
  isAvailable(): boolean
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
}

export class SecretStorageUnavailable extends Error {
  constructor() {
    super(
      'Secure storage is not available on this computer, so secrets cannot be saved safely. ' +
        'On macOS, allow Mail Assistant to use the Keychain when asked.'
    )
    this.name = 'SecretStorageUnavailable'
  }
}

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

/**
 * Stores all secrets as ONE encrypted JSON blob. There is deliberately no plaintext fallback:
 * if the OS cipher is unavailable, writes fail with SecretStorageUnavailable.
 */
export function createSecretStore(filePath: string, cipher: Cipher): SecretStore {
  function readAll(): Record<string, string> {
    if (!existsSync(filePath)) return {}
    try {
      if (!cipher.isAvailable()) return {}
      const parsed = JSON.parse(cipher.decrypt(readFileSync(filePath)))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeAll(map: Record<string, string>): void {
    if (!cipher.isAvailable()) throw new SecretStorageUnavailable()
    const blob = cipher.encrypt(JSON.stringify(map))
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = filePath + '.tmp'
    writeFileSync(tmp, blob)
    renameSync(tmp, filePath)
  }

  return {
    get(key) {
      const v = readAll()[key]
      return typeof v === 'string' ? v : null
    },
    set(key, value) {
      if (!cipher.isAvailable()) throw new SecretStorageUnavailable()
      const all = readAll()
      all[key] = value
      writeAll(all)
    },
    delete(key) {
      const all = readAll()
      if (!(key in all)) return
      delete all[key]
      writeAll(all)
    }
  }
}
