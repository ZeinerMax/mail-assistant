import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

// The ONLY logging entry point in the main process. It never logs free text:
// strings are allowed only if they look like ids/enum values (no spaces, no @, max 64 chars).
// This keeps email content, addresses, API keys and tokens out of logs by construction.

const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/

export function sanitizeFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) out[k] = v
    else if (typeof v === 'string' && SAFE_STRING.test(v)) out[k] = v
    else out[k] = '[redacted]'
  }
  return out
}

export function redactError(e: unknown): { name: string; status?: number } {
  if (e && typeof e === 'object') {
    const name = typeof (e as { name?: unknown }).name === 'string' ? (e as { name: string }).name : 'Error'
    const status = (e as { status?: unknown }).status
    return typeof status === 'number' ? { name, status } : { name }
  }
  return { name: 'UnknownError' }
}

type Sink = (line: string) => void

export function createLogger(sink: Sink): {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
} {
  const write = (level: string, event: string, fields?: Record<string, unknown>): void => {
    const safeEvent = SAFE_STRING.test(event) ? event : '[redacted-event]'
    sink(`${new Date().toISOString()} ${level} ${safeEvent} ${JSON.stringify(sanitizeFields(fields))}`)
  }
  return {
    info: (e, f) => write('INFO', e, f),
    warn: (e, f) => write('WARN', e, f),
    error: (e, f) => write('ERROR', e, f)
  }
}

let logFile: string | null = null
export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  logFile = path
}

export const log = createLogger((line) => {
  console.log(line)
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n', 'utf8')
    } catch {
      // logging must never crash the app
    }
  }
})
