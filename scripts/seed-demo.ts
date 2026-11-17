// Development helper: fills a throwaway data folder with fake demo mail so the UI can be looked at
// without real accounts. Usage (PowerShell):
//   $env:ELECTRON_RUN_AS_NODE=1; npx electron ./node_modules/vitest/vitest.mjs run --config scripts/seed.config.mts
// It never touches the real userData folder.
import { it } from 'vitest'
import { join } from 'path'
import { openDb } from '../src/main/db/schema'
import { Repo } from '../src/main/db/repo'

it('seed demo data', () => {
  const dir = process.env.MA_USER_DATA
  if (!dir) throw new Error('set MA_USER_DATA')
  const now = Date.now()
  const repo = new Repo(openDb(join(dir, 'mail.sqlite')), () => now)
  const home = repo.addAccount({ email: 'jana.home@gmail.com', label: 'Home', color: '#2563eb', lastHistoryId: '1' })
  const work = repo.addAccount({ email: 'jana.work@gmail.com', label: 'Work', color: '#16a34a', lastHistoryId: '1' })
  const club = repo.addAccount({ email: 'tennis.club@gmail.com', label: 'Tennis club', color: '#d97706', lastHistoryId: '1' })
  repo.setAccountStatus(club.id, 'needs_relogin')
  const mails: [number, string, string, string, string, 'needs_reply' | 'info' | 'newsletter_junk', number][] = [
    [home.id, 'Petr Novák', 'petr@example.cz', 'Sobotní oběd?', 'Petr asks whether you can come to lunch on Saturday at 12:30 at his place and if you could bring dessert.', 'needs_reply', 20],
    [work.id, 'Lucie Dvořák', 'lucie@firma.cz', 'Q4 report – review by Thursday', 'Lucie asks you to review the attached Q4 report and send comments by Thursday 20 Nov.', 'needs_reply', 95],
    [home.id, 'Dr. Svoboda – ordinace', 'recepce@ordinace.cz', 'Appointment confirmation', 'Your dental check-up is confirmed for 24 Nov at 9:00. No reply needed.', 'info', 200],
    [work.id, 'Alza.cz', 'noreply@alza.cz', 'Your order has shipped', 'Order #48213 (headphones) shipped; delivery expected Wednesday.', 'info', 400],
    [home.id, 'Rohlik.cz', 'news@rohlik.cz', 'Black Friday – 30 % off', 'Promotion/social update from Rohlik.cz.', 'newsletter_junk', 600],
    [home.id, 'Bank Security', 'secure@bank-verify.xyz', 'Verify your account now', 'Claims your bank account is locked and asks you to click a link — looks like phishing.', 'newsletter_junk', 900]
  ]
  mails.forEach(([acc, name, email, subject, summary, tag, minsAgo], i) => {
    const id = repo.insertEmailIfNew({
      accountId: acc,
      gmailMessageId: `demo${i}`,
      gmailThreadId: `t${i}`,
      receivedAt: now - minsAgo * 60_000,
      fromName: name,
      fromEmail: email,
      subject
    })!
    repo.setTriage(id, { summary, tag })
    if (i === 0)
      repo.addDraft(id, 'Ahoj Petře,\n\ndíky za pozvání! V sobotu ve 12:30 [ano, přijdu / bohužel nemůžu]. Dezert ráda přinesu — [co přinést].\n\nMěj se')
  })
  const failed = repo.insertEmailIfNew({ accountId: work.id, gmailMessageId: 'demoF', gmailThreadId: 'tF', receivedAt: now - 30 * 60_000, fromName: 'IT Helpdesk', fromEmail: 'it@firma.cz', subject: 'Password expiry' })!
  repo.markAttemptFailed(failed)
  const run = repo.startRun()
  repo.addUsage({ runId: run, model: 'claude-haiku-5-5', inputTokens: 18_400, outputTokens: 2_100, costUsd: 0.00289 })
  repo.addUsage({ runId: run, model: 'claude-sonnet-5-5', inputTokens: 4_200, outputTokens: 900, costUsd: 0.0174 })
})
