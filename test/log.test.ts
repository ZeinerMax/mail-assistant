import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { createLogger, redactError, sanitizeFields } from '../src/main/log'

describe('redacting logger', () => {
  it('numbers and booleans pass through', () => {
    expect(sanitizeFields({ n: 42, ok: true })).toEqual({ n: 42, ok: true })
  })

  it('short id-like strings pass through', () => {
    expect(sanitizeFields({ id: '18c2f0a1b2', phase: 'summarizing', model: 'claude-haiku-5-5' })).toEqual({
      id: '18c2f0a1b2',
      phase: 'summarizing',
      model: 'claude-haiku-5-5'
    })
  })

  it('free text and long secrets become [redacted]', () => {
    const out = sanitizeFields({
      body: 'Hi Jana, see attached',
      key: 'sk-ant-api03-' + 'x'.repeat(80),
      email: 'jana@example.com',
      obj: { nested: 1 }
    })
    expect(out).toEqual({ body: '[redacted]', key: '[redacted]', email: '[redacted]', obj: '[redacted]' })
  })

  it('redactError keeps only name and status, drops message', () => {
    const e = Object.assign(new Error('Email from Jana: secret plans'), { name: 'APIError', status: 500 })
    expect(redactError(e)).toEqual({ name: 'APIError', status: 500 })
    expect(redactError('weird')).toEqual({ name: 'UnknownError' })
  })

  it('logger writes sanitized lines to its sink', () => {
    const lines: string[] = []
    const log = createLogger((l) => lines.push(l))
    log.info('triaged', { count: 3, text: 'hello there friend' })
    expect(lines[0]).toContain('triaged')
    expect(lines[0]).toContain('"count":3')
    expect(lines[0]).not.toContain('hello there')
  })

  it('no console.log in src/main outside log.ts', () => {
    const root = join(__dirname, '..', 'src', 'main')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(f) && f !== 'log.ts' && /console\.(log|info|warn|error|debug)\(/.test(readFileSync(p, 'utf8')))
          offenders.push(p)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
