# Send Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reply to an email from inside Mail Assistant, from the account that received it, after editing the text (pre-filled with the AI draft) and confirming.

**Architecture:** A pure `compose` step turns the original message + reply text into a reply (recipient, `Re:` subject, threading headers). nodemailer's `MailComposer` builds the MIME once; Google accounts send it via Gmail `users.messages.send` (new `gmail.send` scope), IMAP accounts via a nodemailer SMTP transport using the IMAP password. A `reply` service in the main process ties it together behind two IPC calls (`preview`, `send`); the renderer gets a `ReplyBox` component used in the mail viewer and on the Drafts page.

**Tech Stack:** Electron 45, React 19, TypeScript, better-sqlite3, @googleapis/gmail 22, nodemailer (new), vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-send-replies-design.md`

## Global Constraints

- Scopes are exactly: `gmail.readonly`, `calendar.readonly`, `gmail.send` (all `https://www.googleapis.com/auth/...`). No `mail.google.com`, no `gmail.modify`/`gmail.compose`.
- The only new write is sending a reply. Delete/move/label/flags/Gmail drafts API/IMAP append stay forbidden by `test/no-write-paths.test.ts`.
- Nothing is sent without the user confirming "Send to <to> from <account email>?" in the UI.
- Reply goes from the account that received the email; no account picker.
- Subject `Re: <original>`, never `Re: Re:`; `In-Reply-To` = original `Message-ID`; `References` = original `References` + original `Message-ID`; Gmail sends with the original `threadId`.
- Email bodies and reply text never go into logs (`log.ts` only), and the sent text is not stored. Draft edits may be stored in the existing `drafts.body`.
- SMTP default: IMAP host with leading `imap.` → `smtp.` (otherwise the same host), port 465; port 465 = implicit TLS, any other port = STARTTLS required. TLS certificates verified (Node default). Same user + password as IMAP.
- No new account sign-in on update: a Gmail account without the send permission shows "Sign in again to enable sending" only when a send fails for that reason.
- UI copy is English.

## Review Focus

1. **Reply-To header** — a mailing list or "noreply + Reply-To" email must be answered at `Reply-To`, not `From`. Test in Task 1.
2. **Czech characters** in subject, body and sender name must arrive intact (encoded headers, UTF-8 body). Test in Task 2.
3. **Double click on Send** must send once. Test in Task 4 (in-flight guard).
4. **Old Gmail token without `gmail.send`** (403 insufficient scopes) must give the "Sign in again to enable sending" error, not "Something went wrong", and must not mark the account `needs_relogin` (reading keeps working). Test in Task 4.
5. **Replying to a message the owner sent** (target is from the owner) must address the original `To`, not the owner themselves. Test in Task 1.

---

### Task 1: Reply composition

**Files:**
- Create: `src/main/send/compose.ts`
- Modify: `src/main/imap/source.ts` (`toGmailMessage` headers)
- Test: `test/compose.test.ts`, `test/imap.test.ts`

**Interfaces:**
- Produces:
  - `interface Reply { to: string; subject: string; inReplyTo: string | null; references: string[]; text: string }`
  - `replySubject(subject: string): string`
  - `buildReply(original: gmail_v1.Schema$Message, ownerEmail: string, text: string): Reply`
  - `class ReplyError extends Error` (name `'ReplyError'`, message is user-facing)

- [ ] **Step 1: Write the failing tests** in `test/compose.test.ts`, building `Schema$Message` objects with `payload.headers`:
  - `replySubject`: `'Lunch'` → `'Re: Lunch'`; `'Re: Lunch'` → `'Re: Lunch'`; `'RE: Lunch'` → `'RE: Lunch'`; `'AW: Lunch'` → `'Re: AW: Lunch'`; `''` → `'Re:'`.
  - `buildReply` uses `Reply-To` when present: headers `From: a@x.cz`, `Reply-To: list@x.cz` → `to === 'list@x.cz'`.
  - Without Reply-To → `From` address (`'Jana Nová <jana@x.cz>'` → `to === 'Jana Nová <jana@x.cz>'`).
  - Owner-sent target: `From: me@x.cz`, `To: bob@y.cz`, ownerEmail `'ME@x.cz'` → `to === 'bob@y.cz'`.
  - Threading: `Message-ID: <m2@x>`, `References: <m0@x> <m1@x>` → `inReplyTo === '<m2@x>'`, `references` equals `['<m0@x>', '<m1@x>', '<m2@x>']`; no Message-ID → `inReplyTo === null`, `references` equals `[]`.
  - `text` is trimmed at the end only; empty or whitespace-only text throws `ReplyError` with message `'Write a reply first.'`.
  - No usable recipient (no From/Reply-To) throws `ReplyError` `'Could not find who to reply to.'`.
- [ ] **Step 2: Run** `npm test -- test/compose.test.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement `src/main/send/compose.ts`.** Read headers case-insensitively (reuse the lookup style of `extractHeaders` in `src/main/google/clean.ts`). Prefix check for `replySubject` is `/^re:/i` only.
- [ ] **Step 4: Extend IMAP adapter.** In `toGmailMessage` (`src/main/imap/source.ts`) add headers `References` (space-joined) and `In-Reply-To`, and `Reply-To` from a new `ParsedLike.replyTo?: { text?: string }` field filled in `parseMail` (`src/main/imap/client.ts`) from mailparser's `replyTo.text`. Add a test in `test/imap.test.ts`: a parsed message with references `['<a@x>','<b@x>']` and replyTo `'r@x.cz'` yields those three headers.
- [ ] **Step 5: Run** `npm test -- test/compose.test.ts test/imap.test.ts` — expected PASS.
- [ ] **Step 6: Commit** `feat(send): compose reply recipient, subject and threading headers`

### Task 2: MIME, senders and the safety rules

**Files:**
- Modify: `package.json` (add `nodemailer` dependency and `@types/nodemailer` devDependency; check current versions in npm docs)
- Create: `src/main/send/mime.ts`, `src/main/send/gmail-send.ts`, `src/main/send/smtp.ts`
- Modify: `src/main/google/oauth.ts` (`SCOPES`), `test/oauth.test.ts`, `test/no-write-paths.test.ts`
- Test: `test/send.test.ts`

**Interfaces:**
- Consumes: `Reply` (Task 1).
- Produces:
  - `buildMime(from: string, r: Reply): Promise<Buffer>` — `nodemailer/lib/mail-composer`, `text` only, headers `In-Reply-To`/`References` set when present.
  - `interface GmailSendLike { users: { messages: { send(p: Record<string, unknown>): Promise<{ data: { id?: string | null } }> } } }`
  - `sendViaGmail(g: GmailSendLike, raw: Buffer, threadId: string): Promise<void>` — `{ userId: 'me', requestBody: { raw: raw.toString('base64url'), threadId } }`.
  - `interface SmtpSettings { host: string; port: number; user: string }`
  - `defaultSmtp(imapHost: string): { host: string; port: number }`
  - `interface SmtpTransportLike { sendMail(m: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<unknown>; close(): void }`
  - `makeSmtpTransport(s: SmtpSettings, password: string): SmtpTransportLike` — `secure: port === 465`, otherwise `requireTLS: true`; `logger: false`; timeouts 20 s connection / 60 s socket.
  - `sendViaSmtp(t: SmtpTransportLike, from: string, to: string, raw: Buffer): Promise<void>` — envelope `to` = bare address parsed from `to`; always `close()`.
  - `smtpErrorMessage(e: unknown): string` — `EAUTH` → `'The outgoing mail server rejected the user name or password.'`; `ECONNECTION`/`ETIMEDOUT`/`ESOCKET`/`ENOTFOUND` → `'Could not connect to the outgoing mail server. Check its address and port in Accounts.'`; otherwise `'The outgoing mail server did not accept the email.'`

- [ ] **Step 1: Write failing tests** in `test/send.test.ts`:
  - `buildMime('me@x.cz', reply)` with subject `'Re: Schůzka v pátek'` and body `'Dobrý den, děkuji.'`: parse the result with mailparser `simpleParser` → subject and text match exactly, `inReplyTo` and `references` match the input.
  - `sendViaGmail` with a fake records exactly one call whose `requestBody.threadId === 't1'` and whose `raw` decodes (base64url) back to the input buffer.
  - `defaultSmtp('imap.seznam.cz')` → `{ host: 'smtp.seznam.cz', port: 465 }`; `defaultSmtp('mail.webglobe.cz')` → `{ host: 'mail.webglobe.cz', port: 465 }`.
  - `sendViaSmtp` with a fake: envelope `{ from: 'me@x.cz', to: ['jana@x.cz'] }` for `to = 'Jana <jana@x.cz>'`; `close` called also when `sendMail` rejects.
  - `smtpErrorMessage({ code: 'EAUTH' })` and `({ code: 'ETIMEDOUT' })` return the strings above.
- [ ] **Step 2: Run** `npm test -- test/send.test.ts` — expected FAIL.
- [ ] **Step 3: `npm install nodemailer` and `npm install -D @types/nodemailer`**, then implement the three files. `makeSmtpTransport` is the only `nodemailer.createTransport` call.
- [ ] **Step 4: Scopes.** Add `'https://www.googleapis.com/auth/gmail.send'` as the third entry of `SCOPES`; update its comment and the `test/oauth.test.ts` assertion to the three scopes in that order.
- [ ] **Step 5: Safety test.** In `test/no-write-paths.test.ts`:
  - Allow `gmail.send` in the scope rule: `/googleapis\.com\/auth\/(?!gmail\.readonly\b|calendar\.readonly\b|gmail\.send\b)/`.
  - Remove `send` from the `gmail message write` alternatives and remove the generic `send call` / `smtp / sending library` rules from `FORBIDDEN`; add a separate `ALLOWED_ONLY_IN` list: `messages.send` / `.send({` → only `main/send/gmail-send.ts`; `from 'nodemailer` → only `main/send/mime.ts` and `main/send/smtp.ts`; `createTransport(` → only `main/send/smtp.ts`. New test `'sending code lives only in main/send'` asserts no hits elsewhere.
  - Add guard tests: `hit("gmail.users.messages.modify({ userId: 'me' })")` is true, `hit("client.append('Sent', raw)")` is true (unchanged IMAP rule), and the gmail-send file passes.
- [ ] **Step 6: Run** `npm test` and `npm run typecheck` — expected all PASS.
- [ ] **Step 7: Commit** `feat(send): MIME builder, Gmail and SMTP senders; allow only these send paths`

### Task 3: Storage (SMTP settings, replied state, draft edits)

**Files:**
- Modify: `src/main/db/schema.ts` (migration 3), `src/main/db/repo.ts`, `src/shared/types.ts`, `src/shared/ipc.ts` (`MailItem`, `DraftItem`), `src/main/views.ts`, `src/main/imap/accounts.ts`
- Test: `test/repo.test.ts`, `test/views.test.ts`, `test/accounts.test.ts` (or the existing IMAP accounts test file)

**Interfaces:**
- Produces:
  - Migration 3: `ALTER TABLE accounts ADD COLUMN smtp_host TEXT; ALTER TABLE accounts ADD COLUMN smtp_port INTEGER; ALTER TABLE emails ADD COLUMN replied_at INTEGER;`
  - `Account.smtp: { host: string; port: number } | null` — for `kind === 'imap'` it is the stored value, or `defaultSmtp(imap_host)` when the columns are NULL; `null` for Gmail.
  - `Repo.setSmtpSettings(id: number, s: { host: string; port: number }): void`
  - `Repo.markReplied(emailId: number): void` — sets `replied_at = now` and `answered = 1`.
  - `Repo.saveDraftBody(emailId: number, body: string): void` — updates the draft for that email, or inserts one (then `seen_at = now`) if none exists.
  - `EmailRow.repliedAt: number | null`; `MailItem.repliedAt: number | null`; `DraftItem.repliedAt: number | null`
  - `ImapAccounts.setSmtp(accountId: number, raw: unknown): Account` — validates host with the same regex as IMAP host and port 1–65535, throws `ImapSetupError` with `'Enter the outgoing (SMTP) server, e.g. smtp.example.com.'` / `'Enter the outgoing port (usually 465 or 587).'`.

- [ ] **Step 1: Write failing tests:**
  - repo: an IMAP account with `imap_host 'imap.seznam.cz'` and no SMTP columns reports `smtp` `{ host: 'smtp.seznam.cz', port: 465 }`; after `setSmtpSettings(id, { host: 'smtp.x.cz', port: 587 })` reports that; a Gmail account reports `smtp === null`.
  - repo: `markReplied` sets `repliedAt` to the injected `now` and `answered` to true.
  - repo: `saveDraftBody` on an email with a draft replaces `body`; on an email without one creates a draft whose `seenAt` is not null (so the badge does not count it).
  - views: `buildMailItems` and `buildDraftItems` pass `repliedAt` through. Check the existing `buildDraftItems` rule "answered → hidden": a replied email's draft disappears from Drafts, which is intended.
  - imap accounts: `setSmtp(id, { host: 'smtp.x.cz', port: 587 })` stores it; `{ host: 'bad', port: 0 }` throws `ImapSetupError`.
- [ ] **Step 2: Run** the three test files — expected FAIL.
- [ ] **Step 3: Implement** the migration, repo methods, type fields and `setSmtp`. `defaultSmtp` comes from `src/main/send/smtp.ts` (Task 2).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — expected PASS.
- [ ] **Step 5: Commit** `feat(send): store SMTP settings, replied state and edited drafts`

### Task 4: Reply service and IPC

**Files:**
- Create: `src/main/send/service.ts`
- Modify: `src/shared/ipc.ts` (channels + `Api`), `src/preload/index.ts`, `src/main/ipc-handlers.ts` (`AppContext`, handlers, `friendlyError`), `src/main/index.ts` (wiring)
- Test: `test/reply-service.test.ts`

**Interfaces:**
- Consumes: `buildReply`, `ReplyError` (Task 1); `buildMime`, `sendViaGmail`, `GmailSendLike`, `makeSmtpTransport`, `sendViaSmtp`, `smtpErrorMessage` (Task 2); `Repo.markReplied`, `Account.smtp` (Task 3); existing `getMessage`, `GmailLike`, `AccountService.getAuth`, `gmailFor`, IMAP secret key `imapKey`.
- Produces:
  - `class SendPermissionMissing extends Error` — message `'Sign in again to enable sending from this account.'`, field `accountId`.
  - `createReplyService(deps: { repo: Repo; openMailbox(id: number): Promise<GmailLike>; gmailSender(id: number): Promise<GmailSendLike>; smtpFor(account: Account): SmtpTransportLike; }): { preview(emailId: number): Promise<ReplyPreview>; send(emailId: number, text: string): Promise<{ sentAt: number }> }`
  - `interface ReplyPreview { to: string; from: string; subject: string }` (in `src/shared/ipc.ts`)
  - IPC: `CH.replyPreview = 'reply:preview'`, `CH.replySend = 'reply:send'`, `CH.draftsSave = 'drafts:save'`, `CH.accountsSetSmtp = 'accounts:setSmtp'`.
  - `Api.reply: { preview(emailId: number): Promise<Result<ReplyPreview>>; send(emailId: number, text: string): Promise<Result<{ sentAt: number }>> }`
  - `Api.drafts.save(emailId: number, body: string): Promise<Result<true>>`
  - `Api.accounts.setSmtp(id: number, s: { host: string; port: number }): Promise<Result<Account>>`

- [ ] **Step 1: Write failing tests** in `test/reply-service.test.ts` with an in-memory `Repo` and fakes:
  - Gmail account: `send(emailId, 'Díky')` calls the fake Gmail sender once with the email's `gmailThreadId`, then `repo.getEmail(emailId).repliedAt` is set.
  - IMAP account: the SMTP fake receives envelope from = account email, and Gmail sender is never called.
  - Two concurrent `send` calls for the same email → exactly one send; the second rejects with `ReplyError('This reply is already being sent.')`.
  - Already replied email (`repliedAt` set) → rejects with `ReplyError('You already replied to this email from the app.')`; nothing sent.
  - Gmail sender rejects `{ status: 403, message: 'Request had insufficient authentication scopes.' }` → rejects with `SendPermissionMissing`; account status stays `'ok'`; `repliedAt` stays null.
  - SMTP rejects `{ code: 'EAUTH' }` → rejects with `ReplyError` carrying `smtpErrorMessage`'s text; `repliedAt` stays null.
  - `preview` returns `{ to, from: account email, subject: 'Re: …' }` without sending.
- [ ] **Step 2: Run** `npm test -- test/reply-service.test.ts` — expected FAIL.
- [ ] **Step 3: Implement `service.ts`.** Fetch the original with `getMessage(await openMailbox(accountId), row.gmailMessageId)`. Detect missing scope as `status === 403` and `/insufficient/i` on the message or `response.data.error.message` (mark `PARTLY VERIFIED` in a comment; check the Gmail API error docs). Hold an in-memory `Set<number>` of emails being sent. Log only `log.info('reply_sent', { emailId, kind })` / `log.error('reply_failed', redactError(e))`.
- [ ] **Step 4: Wire it up.** In `index.ts`, `gmailSender = async (id) => gmailFor(await accounts.getAuth(id))`; `smtpFor = (a) => makeSmtpTransport({ ...a.smtp!, user: a.imap!.user }, secrets.get(imapKey(a.id))!)` (missing password → `ReloginRequired`). Add handlers through `wrap`, call `changed()` and `refreshBadge()` after a successful send and after `drafts.save`. Add `ReplyError` and `SendPermissionMissing` to the pass-through list in `friendlyError`. Expose the new calls in `preload/index.ts`. Validate IPC inputs: `emailId` integer, `text` string ≤ 100 000 chars.
- [ ] **Step 5: Run** `npm test` and `npm run typecheck` — expected PASS.
- [ ] **Step 6: Commit** `feat(send): reply service and IPC`

### Task 5: Reply UI

**Files:**
- Create: `src/renderer/src/components/ReplyBox.tsx`
- Modify: `src/renderer/src/components/MailViewer.tsx`, `src/renderer/src/pages/Drafts.tsx`, `src/renderer/src/pages/Mail.tsx` (replied chip), `src/renderer/src/pages/Accounts.tsx`, `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `Api.reply`, `Api.drafts.save`, `Api.drafts.list`, `Api.accounts.setSmtp`, `Api.accounts.relogin`, `MailItem.repliedAt`, `DraftItem.repliedAt`.
- Produces: `ReplyBox({ emailId: number; accountId: number; initialText: string; onSent: () => void }): React.JSX.Element`

Behaviour of `ReplyBox` (UI, no unit test; verify by running the app):
- A textarea pre-filled with `initialText`. Edits are saved with `drafts.save` 800 ms after typing stops and when the box closes.
- **Send…** button (disabled while the text is blank) → calls `reply.preview` and shows an inline confirm row: `Send to <to> from <from>?` with **Send now** and **Cancel**. **Send now** is disabled while sending and shows "Sending…".
- On success: "Sent ✓", then `onSent()`. On error: show the error text; if it is the "Sign in again to enable sending…" message, show a **Sign in again** button calling `accounts.relogin(accountId)`.

- [ ] **Step 1: Build `ReplyBox`** as above, using existing classes (`btn`, `note`, `msg err`) and adding only what is missing to `styles.css`.
- [ ] **Step 2: MailViewer.** Add a **Reply** button in the viewer tabs row (hidden when `item.repliedAt` is set; show "Replied <relativeDay>" instead). It opens `ReplyBox` under the messages, pre-filled with this email's draft body from `drafts.list()` (or empty).
- [ ] **Step 3: Drafts page.** Replace the "Copy a draft and paste it into Gmail to send. Mail Assistant never sends email." note with "Edit a draft and send it from here, or copy it." Show `ReplyBox` for the selected draft in place of the read-only body; keep the Copy button.
- [ ] **Step 4: Mail list.** Show a small "Replied" chip on items with `repliedAt`.
- [ ] **Step 5: Accounts page.** For IMAP accounts, add "Outgoing server" host + port fields (pre-filled from `account.smtp`) with a Save button calling `accounts.setSmtp`.
- [ ] **Step 6: Verify:** `npm run typecheck`, `npm test`, then `npm run dev`. Reply to a test email from a Gmail account (check it arrives in the same Gmail conversation and in Sent), cancel once at the confirm step (nothing sent), and send from an IMAP account if one is set up. Report what could not be tried.
- [ ] **Step 7: Commit** `feat(send): reply box in the viewer and on the Drafts page; SMTP settings in Accounts`

### Task 6: Documentation and Obsidian notes

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-11-17-mail-assistant-design.md` (one dated note at the top of section 2: read-only rule replaced by `2026-11-23-send-replies-design.md`), `package.json` `description` (drop "read-only")
- Modify (separate git repo `C:\VS\Claude\notes`): `Mail Assistant/Mail Assistant.md`, `Mail Assistant/Google Cloud setup.md`, `Mail Assistant/Status and next steps.md`

- [ ] **Step 1: README:** describe replying, the `gmail.send` scope, the one-time "Sign in again to enable sending" per existing Gmail account, and the SMTP defaults.
- [ ] **Step 2: Obsidian:**
  - `Mail Assistant.md`: reads Gmail and **sends replies** (from the receiving account, after confirming); still no delete/move/label.
  - `Google Cloud setup.md`: add `gmail.send` in Google Auth platform → Data Access; existing accounts sign in again once when they first send.
  - `Status and next steps.md`: a dated "Done (2026-11-23)" entry for sending replies with the commit hashes and test count; next steps: add the scope in Google Cloud, test a real send from each account type, release a new version.
- [ ] **Step 3: Commit** the app repo (`docs: sending replies`) and the notes repo (`Mail Assistant: sending replies`).
