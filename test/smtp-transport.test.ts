import { describe, it, expect } from 'vitest'
import { makeSmtpTransport } from '../src/main/send/smtp'

type Opts = { secure?: boolean; requireTLS?: boolean; port?: number }
const opts = (port: number): Opts =>
  (makeSmtpTransport({ host: 'smtp.example.com', port, user: 'u' }, 'p') as unknown as { transporter: { options: Opts } })
    .transporter.options

describe('makeSmtpTransport TLS', () => {
  it('uses implicit TLS on 465', () => {
    const o = opts(465)
    expect(o.secure).toBe(true)
    expect(o.requireTLS).toBe(false)
  })
  it('requires STARTTLS on 587', () => {
    const o = opts(587)
    expect(o.secure).toBe(false)
    expect(o.requireTLS).toBe(true)
  })
})
