import { safeStorage } from 'electron'
import type { Cipher } from './secrets'

// VERIFIED against electron.d.ts (Electron 45): isEncryptionAvailable(), encryptString(), decryptString().
// Windows: DPAPI. macOS: Keychain. ASSUMPTION: an unsigned macOS build may show a Keychain prompt on first use.
export const electronCipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b)
}
