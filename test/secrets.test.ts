import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSecretStore, SecretStorageUnavailable, type Cipher } from '../src/main/secrets'

// Fake cipher: XOR with a byte plus a marker, so plaintext never appears on disk.
const fakeCipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: (s) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
  decrypt: (b) => {
    if (b.subarray(0, 4).toString() !== 'ENC1') throw new Error('bad blob')
    return Buffer.from(b.subarray(4).map((x) => x ^ 0x5a)).toString('utf8')
  }
})

let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'ma-secrets-')), 'secrets.bin')
})

describe('secret store', () => {
  it('set/get round-trip', () => {
    const s = createSecretStore(file, fakeCipher())
    s.set('anthropicKey', 'sk-ant-test-123')
    expect(s.get('anthropicKey')).toBe('sk-ant-test-123')
    expect(createSecretStore(file, fakeCipher()).get('anthropicKey')).toBe('sk-ant-test-123')
  })

  it('delete removes', () => {
    const s = createSecretStore(file, fakeCipher())
    s.set('google:1', 'refresh-abc')
    s.delete('google:1')
    expect(s.get('google:1')).toBeNull()
  })

  it('file on disk does not contain plaintext value', () => {
    createSecretStore(file, fakeCipher()).set('anthropicKey', 'sk-ant-PLAINTEXT')
    expect(readFileSync(file).toString('latin1')).not.toContain('PLAINTEXT')
  })

  it('isAvailable false → set throws SecretStorageUnavailable and file is not created', () => {
    const s = createSecretStore(file, fakeCipher(false))
    expect(() => s.set('anthropicKey', 'x')).toThrow(SecretStorageUnavailable)
    expect(existsSync(file)).toBe(false)
  })

  it('corrupt file → get returns null', () => {
    writeFileSync(file, 'garbage')
    expect(createSecretStore(file, fakeCipher()).get('anthropicKey')).toBeNull()
  })
})
