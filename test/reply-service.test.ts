import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'
import { createReplyService, SendPermissionMissing } from '../src/main/send/service'
import { ReplyError } from '../src/main/send/compose'
import { smtpErrorMessage } from '../src/main/send/smtp'

let repo: Repo
beforeEach(() => {
  repo = new Repo(openDb(join(mkdtempSync(join(tmpdir(), 'ma-reply-')), 'db.sqlite')))
})

const original = {
  id: 'm1',
  payload: {
    headers: [
      { name: 'From', value: 'Jana <jana@x.cz>' },
      { name: 'Subject', value: 'Schůzka' },
      { name: 'Message-ID', value: '<a@x.cz>' }
    ]
  }
}
const mailbox = { users: { messages: { get: vi.fn().mockResolvedValue({ data: original }) } } }

function setup(kind: 'gmail' | 'imap' = 'gmail') {
  const acc =
    kind === 'gmail'
      ? repo.addAccount({ email: 'me@gmail.com', label: 'Me', color: '#000', lastHistoryId: null })
      : repo.addImapAccount({ email: 'me@x.cz', label: 'Me', color: '#000', host: 'imap.x.cz', port: 993, user: 'me' })
  const emailId = repo.insertEmailIfNew({
    accountId: acc.id, gmailMessageId: 'm1', gmailThreadId: 't1', receivedAt: 1, fromName: 'Jana', fromEmail: 'jana@x.cz', subject: 'Schůzka'
  })!
  const gmailSend = vi.fn().mockResolvedValue({ data: { id: 'x' } })
  const smtp = { sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() }
  const svc = createReplyService({
    repo,
    openMailbox: async () => mailbox as never,
    gmailSender: async () => ({ users: { messages: { send: gmailSend } } }),
    smtpFor: () => smtp
  })
  return { acc, emailId, gmailSend, smtp, svc }
}

describe('reply service', () => {
  it('sends via Gmail on the thread and marks replied', async () => {
    const { emailId, gmailSend, svc } = setup()
    const r = await svc.send(emailId, 'Díky')
    expect(gmailSend).toHaveBeenCalledTimes(1)
    expect(gmailSend.mock.calls[0][0].requestBody.threadId).toBe('t1')
    expect(repo.getEmail(emailId)!.repliedAt).toBe(r.sentAt)
    expect(r.sentAt).toBeGreaterThan(0)
  })

  it('sends via SMTP with the account email as envelope sender', async () => {
    const { emailId, gmailSend, smtp, svc } = setup('imap')
    await svc.send(emailId, 'Díky')
    expect(gmailSend).not.toHaveBeenCalled()
    expect(smtp.sendMail.mock.calls[0][0].envelope).toEqual({ from: 'me@x.cz', to: ['jana@x.cz'] })
    expect(repo.getEmail(emailId)!.repliedAt).not.toBeNull()
  })

  it('rejects a concurrent second send', async () => {
    const { emailId, gmailSend, svc } = setup()
    const a = svc.send(emailId, 'Díky')
    const b = svc.send(emailId, 'Díky')
    await expect(b).rejects.toThrow(new ReplyError('This reply is already being sent.'))
    await a
    expect(gmailSend).toHaveBeenCalledTimes(1)
  })

  it('refuses when already replied', async () => {
    const { emailId, gmailSend, svc } = setup()
    repo.markReplied(emailId)
    await expect(svc.send(emailId, 'Díky')).rejects.toThrow('You already replied to this email from the app.')
    expect(gmailSend).not.toHaveBeenCalled()
  })

  it('maps a missing Gmail scope to SendPermissionMissing without touching account status', async () => {
    const { acc, emailId, gmailSend, svc } = setup()
    gmailSend.mockRejectedValue({ status: 403, message: 'Request had insufficient authentication scopes.' })
    await expect(svc.send(emailId, 'Díky')).rejects.toBeInstanceOf(SendPermissionMissing)
    expect(repo.getAccount(acc.id)!.status).toBe('ok')
    expect(repo.getEmail(emailId)!.repliedAt).toBeNull()
  })

  it('maps an SMTP failure to a friendly ReplyError', async () => {
    const { emailId, smtp, svc } = setup('imap')
    const err = { code: 'EAUTH' }
    smtp.sendMail.mockRejectedValue(err)
    const p = svc.send(emailId, 'Díky')
    await expect(p).rejects.toBeInstanceOf(ReplyError)
    await expect(p).rejects.toThrow(smtpErrorMessage(err))
    expect(repo.getEmail(emailId)!.repliedAt).toBeNull()
  })

  it('releases the lock after a failure so the user can retry', async () => {
    const { emailId, gmailSend, svc } = setup()
    gmailSend.mockRejectedValueOnce(new Error('boom'))
    await expect(svc.send(emailId, 'Díky')).rejects.toThrow()
    await svc.send(emailId, 'Díky')
    expect(repo.getEmail(emailId)!.repliedAt).not.toBeNull()
  })

  it('previews without sending', async () => {
    const { emailId, gmailSend, smtp, svc } = setup()
    expect(await svc.preview(emailId)).toEqual({ to: 'Jana <jana@x.cz>', from: 'me@gmail.com', subject: 'Re: Schůzka' })
    expect(gmailSend).not.toHaveBeenCalled()
    expect(smtp.sendMail).not.toHaveBeenCalled()
  })
})
