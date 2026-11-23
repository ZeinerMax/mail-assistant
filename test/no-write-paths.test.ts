import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// Hard requirement: the app has NO code path that sends, deletes or changes email or calendar data,
// and requests no scope beyond gmail.readonly + calendar.readonly.
const FORBIDDEN: [string, RegExp][] = [
  ['gmail message write', /messages\s*\.\s*(modify|trash|untrash|delete|insert|import|batchModify|batchDelete)\b/],
  ['gmail thread write', /threads\s*\.\s*(modify|trash|untrash|delete)\b/],
  ['gmail drafts api', /users\s*\.\s*drafts\b/],
  ['gmail labels write', /labels\s*\.\s*(create|update|patch|delete)\b/],
  ['gmail settings write', /settings\s*\.\s*(update\w*|filters|forwardingAddresses|delegates)/],
  ['calendar write', /events\s*\.\s*(insert|update|patch|delete|move|quickAdd|import)\b/],
  ['calendar list write', /calendarList\s*\.\s*(insert|update|patch|delete)\b/],
  ['non-readonly google scope', /googleapis\.com\/auth\/(?!gmail\.readonly\b|calendar\.readonly\b|gmail\.send\b)/],
  ['full gmail scope', /mail\.google\.com\/(?!mail\/\?authuser=)/],
  // IMAP: only connect/list/search/fetch/logout; never flags, moves, copies, deletes, appends or folder changes.
  ['imap write', /\.(messageFlagsAdd|messageFlagsSet|messageFlagsRemove|setFlagColor|messageDelete|messageMove|messageCopy|append|mailboxCreate|mailboxDelete|mailboxRename|mailboxSubscribe|mailboxUnsubscribe)\(/],
  ['imap mailbox opened writable', /(getMailboxLock|mailboxOpen)\((?![^)]*readOnly:\s*true)[^)]*\)/]
]

// Sending is allowed only in these files (paths relative to src, forward slashes).
const ALLOWED_ONLY_IN: [string, RegExp, string[]][] = [
  ['gmail send', /messages\s*\.\s*send|\.send\(\s*\{/, ['main/send/gmail-send.ts']],
  ['nodemailer import', /from ['"]nodemailer/, ['main/send/mime.ts', 'main/send/smtp.ts']],
  ['createTransport', /createTransport\(/, ['main/send/smtp.ts']]
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })
}

describe('no write paths', () => {
  it('source contains no Gmail/Calendar write calls and no extra scopes', () => {
    const root = join(__dirname, '..', 'src')
    const hits: string[] = []
    for (const f of files(root)) {
      const text = readFileSync(f, 'utf8')
      for (const [name, re] of FORBIDDEN) if (re.test(text)) hits.push(`${relative(root, f)}: ${name}`)
    }
    expect(hits).toEqual([])
  })

  it('sending code lives only in main/send', () => {
    const root = join(__dirname, '..', 'src')
    const hits: string[] = []
    for (const f of files(root)) {
      const rel = relative(root, f).split('\\').join('/')
      const text = readFileSync(f, 'utf8')
      for (const [name, re, ok] of ALLOWED_ONLY_IN) if (re.test(text) && !ok.includes(rel)) hits.push(`${rel}: ${name}`)
    }
    expect(hits).toEqual([])
  })

  it('only the updater (and the app wiring) may start other programs', () => {
    const root = join(__dirname, '..', 'src')
    const hits = files(root)
      .filter((f) => /from ['"](node:)?child_process['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split('\\').join('/'))
      .filter((f) => !f.startsWith('main/update/') && f !== 'main/index.ts')
    expect(hits).toEqual([])
  })

  it('the guard catches IMAP writes and writable mailboxes', () => {
    const hit = (code: string): boolean => FORBIDDEN.some(([, re]) => re.test(code))
    expect(hit("await client.messageFlagsAdd('1', ['\Seen'])")).toBe(true)
    expect(hit("await client.getMailboxLock('INBOX')")).toBe(true)
    expect(hit("await client.getMailboxLock('INBOX', { readOnly: true })")).toBe(false)
  })

  it('the guard still catches Gmail modify and IMAP append, and the send file passes', () => {
    const hit = (code: string): boolean => FORBIDDEN.some(([, re]) => re.test(code))
    expect(hit("gmail.users.messages.modify({ userId: 'me' })")).toBe(true)
    expect(hit("client.append('Sent', raw)")).toBe(true)
    const send = readFileSync(join(__dirname, '..', 'src', 'main', 'send', 'gmail-send.ts'), 'utf8')
    expect(hit(send)).toBe(false)
  })

  it('the guard itself catches a write call', () => {
    const sample = "gmail.users.messages.trash({ userId: 'me', id })"
    expect(FORBIDDEN.some(([, re]) => re.test(sample))).toBe(true)
  })
})
