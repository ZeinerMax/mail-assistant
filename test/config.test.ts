import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SettingsError } from '../src/main/config'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ma-config-'))
})

describe('settings config', () => {
  it('loads defaults when file missing', () => {
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('has the spec defaults', () => {
    expect(DEFAULT_SETTINGS.triageModel).toBe('claude-haiku-5-5')
    expect(DEFAULT_SETTINGS.draftModel).toBe('claude-sonnet-5-5')
    expect(DEFAULT_SETTINGS.draftEffort).toBe('medium')
    expect(DEFAULT_SETTINGS.checkIntervalMin).toBe(15)
    expect(DEFAULT_SETTINGS.maxEmailsPerRun).toBe(50)
    expect(DEFAULT_SETTINGS.maxDraftsPerRun).toBe(10)
    expect(DEFAULT_SETTINGS.maxTokensPerRun).toBe(300000)
    expect(DEFAULT_SETTINGS.triageBodyChars).toBe(4000)
    expect(DEFAULT_SETTINGS.draftContextChars).toBe(12000)
    expect(DEFAULT_SETTINGS.prefilterPromotions).toBe(true)
    expect(DEFAULT_SETTINGS.prices['claude-haiku-5-5']).toEqual({ in: 0.1, out: 0.5 })
    expect(DEFAULT_SETTINGS.prices['claude-sonnet-5-5']).toEqual({ in: 2, out: 10 })
  })

  it('merges partial file over defaults and drops unknown keys', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ checkIntervalMin: 30, bogus: 1 }))
    const s = loadSettings(dir)
    expect(s.checkIntervalMin).toBe(30)
    expect(s.maxEmailsPerRun).toBe(50)
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined()
  })

  it('corrupt JSON → defaults', () => {
    writeFileSync(join(dir, 'settings.json'), '{not json')
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects checkIntervalMin < 5 or > 1440', () => {
    expect(() => saveSettings(dir, { checkIntervalMin: 4 })).toThrow(SettingsError)
    expect(() => saveSettings(dir, { checkIntervalMin: 1441 })).toThrow(/checkIntervalMin/)
  })

  it('rejects caps <= 0', () => {
    expect(() => saveSettings(dir, { maxEmailsPerRun: 0 })).toThrow(/maxEmailsPerRun/)
    expect(() => saveSettings(dir, { maxDraftsPerRun: -1 })).toThrow(/maxDraftsPerRun/)
    expect(() => saveSettings(dir, { maxTokensPerRun: 0 })).toThrow(/maxTokensPerRun/)
  })

  it('rejects empty model string', () => {
    expect(() => saveSettings(dir, { triageModel: '  ' })).toThrow(/triageModel/)
  })

  it('round-trips prices and persists to disk', () => {
    const prices = { ...DEFAULT_SETTINGS.prices, 'claude-x': { in: 1, out: 2 } }
    const saved = saveSettings(dir, { prices, checkIntervalMin: 20 })
    expect(saved.prices['claude-x']).toEqual({ in: 1, out: 2 })
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk.checkIntervalMin).toBe(20)
    expect(loadSettings(dir).prices['claude-x']).toEqual({ in: 1, out: 2 })
  })
})
