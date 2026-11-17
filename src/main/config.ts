import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Settings } from '@shared/types'

// Prices: USD per million tokens, from Anthropic's model table (cached 2026-11-03).
// PARTLY VERIFIED: Haiku 5.5 price applies to prompts up to 100K tokens; our prompts are far below.
// Editable in Settings, so they can be corrected without a code change.
export const DEFAULT_SETTINGS: Settings = {
  triageModel: 'claude-haiku-5-5',
  draftModel: 'claude-sonnet-5-5',
  draftEffort: 'medium',
  checkIntervalMin: 15,
  maxEmailsPerRun: 50,
  maxDraftsPerRun: 10,
  maxTokensPerRun: 300000,
  triageBodyChars: 4000,
  draftContextChars: 12000,
  prefilterPromotions: true,
  prices: {
    'claude-haiku-5-5': { in: 0.1, out: 0.5 },
    'claude-sonnet-5-5': { in: 2, out: 10 }
  }
}

export class SettingsError extends Error {
  constructor(
    public field: string,
    message: string
  ) {
    super(`${field}: ${message}`)
    this.name = 'SettingsError'
  }
}

const FILE = 'settings.json'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function pickKnown(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in (raw as object)) out[key] = (raw as Record<string, unknown>)[key]
  }
  return out as Partial<Settings>
}

function intInRange(s: Settings, field: keyof Settings, min: number, max: number): void {
  const v = s[field]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new SettingsError(field, `must be a whole number between ${min} and ${max}`)
  }
}

export function validateSettings(s: Settings): Settings {
  for (const f of ['triageModel', 'draftModel'] as const) {
    if (typeof s[f] !== 'string' || s[f].trim() === '') {
      throw new SettingsError(f, 'must not be empty')
    }
    s[f] = s[f].trim()
  }
  if (!EFFORTS.includes(s.draftEffort)) {
    throw new SettingsError('draftEffort', `must be one of ${EFFORTS.join(', ')}`)
  }
  intInRange(s, 'checkIntervalMin', 5, 1440)
  intInRange(s, 'maxEmailsPerRun', 1, 1000)
  intInRange(s, 'maxDraftsPerRun', 1, 200)
  intInRange(s, 'maxTokensPerRun', 1, 50_000_000)
  intInRange(s, 'triageBodyChars', 200, 100_000)
  intInRange(s, 'draftContextChars', 500, 200_000)
  if (typeof s.prefilterPromotions !== 'boolean') {
    throw new SettingsError('prefilterPromotions', 'must be true or false')
  }
  if (!s.prices || typeof s.prices !== 'object') throw new SettingsError('prices', 'missing')
  for (const [model, p] of Object.entries(s.prices)) {
    if (!p || typeof p.in !== 'number' || typeof p.out !== 'number' || p.in < 0 || p.out < 0) {
      throw new SettingsError('prices', `invalid price for ${model}`)
    }
  }
  return s
}

export function loadSettings(dir: string): Settings {
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
  } catch {
    raw = {}
  }
  const merged: Settings = structuredClone({ ...DEFAULT_SETTINGS, ...pickKnown(raw) })
  try {
    return validateSettings(merged)
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveSettings(dir: string, patch: Partial<Settings>): Settings {
  const next = validateSettings(structuredClone({ ...loadSettings(dir), ...pickKnown(patch) }))
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, FILE + '.tmp')
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, join(dir, FILE))
  return next
}
