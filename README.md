# Mail Assistant

A private desktop app (macOS + Windows) that reads up to a few Gmail accounts, summarizes and tags new mail with Claude Haiku, writes reply drafts with Claude Sonnet for mail that needs an answer, lets you **send a reply** from the app, mark mail **done**, **unsubscribe** from newsletters in one tap, and shows all calendars in one view.

**It never deletes, moves or labels email and never changes calendar events.** The only emails it sends are (a) a reply you read, edit and confirm yourself (see [Sending replies](#sending-replies)), and (b) an unsubscribe request when you press **Unsubscribe** on a newsletter (see [Marking mail done and unsubscribing](#marking-mail-done-and-unsubscribing)). There is no "new email from scratch".

How the app was designed and built (process, decisions, Google Cloud setup, problems solved): see [HOW_IT_WAS_BUILT.md](HOW_IT_WAS_BUILT.md).

| | |
|---|---|
| Stack | Electron 45 · React 19 · TypeScript · electron-vite · better-sqlite3 · electron-builder |
| AI | `claude-haiku-5-5` (summary + tag) · `claude-sonnet-5-5` (drafts, adaptive thinking, effort `medium`) — changeable in Settings |
| Google scopes | `gmail.readonly`, `calendar.readonly`, `gmail.send` — nothing else |
| Other mailboxes | IMAP (e.g. Webglobe), every folder opened **read-only** (`EXAMINE`) — mail isn't even marked as read; replies go out through SMTP |

## Other mailboxes (IMAP, e.g. Webglobe)

**Accounts → Add other email (IMAP)**: email address, IMAP server (Webglobe: `mail.webglobe.cz`), port `993` (SSL/TLS), user name (usually the full mailbox address) and password. The app logs in once to test the settings before saving. The password is encrypted like the API key.

- New mail is found by IMAP UID (`UIDVALIDITY:last UID` cursor); "Check from this time" searches by date.
- A conversation is built from the `References` / `In-Reply-To` headers across INBOX and the Sent folder.
- No calendar for IMAP accounts. No web links either (IMAP has none), so "Open email" / "Whole conversation" show the text inside the app.

## Sending replies

- **Reply** button in the email viewer; the reply box opens at the **top** of the viewer so it stays visible in a long conversation. Also an editable reply box on the **Drafts** page (pre-filled with the AI draft). Edits to a draft are kept.
- **Send** asks "Send to X from Y?" first. After sending, the email shows a **Replied** chip.
- A reply always goes from the account that received the email, to the sender, with the right subject and threading headers. Gmail accounts put it in Sent automatically; for IMAP accounts no copy is saved to the Sent folder.
- Not included: new email from scratch, syncing drafts to Gmail.
- **Gmail:** uses the `gmail.send` scope. Existing accounts were signed in without it, so the first time you send from one, the app says "Sign in again to enable sending from this account. On Google's screen, make sure sending email is allowed." — click **Sign in again** once and leave the sending permission ticked. In Google Cloud, `gmail.send` must be added under Google Auth platform → Data Access.
- **IMAP:** the account needs outgoing-server (SMTP) settings (Accounts page). Defaults: IMAP host `imap.x` becomes `smtp.x` (otherwise the same host), port `465` with TLS; any other port uses STARTTLS. Same user name and password as IMAP.
- Status: covered by unit tests, typecheck and build; a real send has not been tested yet.

## Reading mail, links and "already answered"

- **Open email** shows the whole email; **Whole conversation** shows every message of the thread. Both are fetched live when opened and never stored.
- Gmail emails that need a reply get **Open in Gmail ↗**, and longer conversations get **Whole conversation (N) ↗**.
- Before writing a draft, the app checks the conversation. If you already replied (a later message sent by you, or the IMAP `\Answered` flag), no draft is written and the email shows **Important — already answered**.
- The tag for mail that needs an answer is shown as **Important**.

## Marking mail done and unsubscribing

- **Mark done:** every email has a **Mark done** checkbox — for mail that needs no reply but you want cleared. Done mail (and mail you already answered) leaves the active list; the **Done** filter shows it again and you can un-check to bring it back. This is only in the app — nothing is changed, archived or deleted in your mailbox.
- **Check now** reloads the active list, so done and already-answered mail stay out of the way.
- **Unsubscribe** (on *Newsletter / junk* mail): one tap, fully automatic, with no browser window opened:
  1. If the newsletter offers **one-click** unsubscribe (RFC 8058 `List-Unsubscribe-Post`), the app sends that one-click request.
  2. Otherwise, if it offers only a **mailto** unsubscribe, the app **sends a short unsubscribe email** from the account that received it.
  3. Otherwise it quietly contacts the unsubscribe **link** in the background.
  4. If there is no `List-Unsubscribe` header at all, Claude Haiku reads the email body to find the unsubscribe link, which the app then contacts.
  On success the email is marked done. Because this sends a request (and sometimes an email) on your behalf, it only happens when you press **Unsubscribe**.

## Privacy and security

- **What is stored on disk (SQLite):** account address + colour, message/thread IDs, sender name and address, subject, date, the AI summary and tag, drafts, run history and token usage.
- **Never stored:** email bodies, quoted text, attachments, thread text. Full text exists only in memory during a check and is discarded after the model call.
- **Sent to Anthropic:** only new emails, with quoted reply chains, signatures and attachments removed and long bodies cut to a limit (Settings). For a draft, the cleaned thread (newest messages first, up to a limit). When you unsubscribe from a newsletter that has no `List-Unsubscribe` header, its cleaned body is sent to Haiku once to locate the unsubscribe link.
- **Prompt injection:** every email is wrapped in a tag with a random per-request name, the model is told to ignore any instructions inside, the models get **no tools**, and summaries are forced into a fixed JSON shape.
- **Secrets:** the Anthropic API key and Google sign-ins are encrypted with the operating system (Windows DPAPI / macOS Keychain) via Electron `safeStorage`. There is no plain-text fallback. They never reach the UI, logs or the database.
- **Logs** (`…/Mail Assistant/logs/app.log`) contain only IDs, counts and error types — never text, addresses or keys.
- **Cost control:** hard per-check limits on emails, drafts and tokens; at most one SDK retry per request; an email that fails twice is not retried again. A usage counter (tokens + estimated cost) is in Settings.

## One-time Google Cloud setup (done by the developer, once)

1. **Create a project** — [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate) → Project name → **Create**.
2. **Enable the APIs** — *APIs & Services → Library*: enable **Gmail API** and **Google Calendar API**.
3. **Google Auth platform** (OAuth consent screen) — *Menu → Google Auth platform*:
   1. **Get Started** → App name "Mail Assistant", your support email → Audience **External** → contact email → accept the policy → **Create**.
   2. **Data Access → Add or Remove Scopes** → add `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.readonly` and `https://www.googleapis.com/auth/gmail.send` → **Save**.
   3. **Audience → Test users → Add users**: add every Gmail address that will use the app.
4. **Create the client** — *Google Auth platform → Clients → Create Client* → Application type **Desktop app** → name it → **Create**. **Copy the client ID and secret now** (the secret is shown only once).
5. **Publish to production** — *Audience* → **Publish app**.
   - **Why:** while the app is in *Testing*, Google says *"Authorizations by a test user will expire seven days from the time of consent"*, including refresh tokens — everyone would have to sign in again every week. In production, sign-ins last until the user changes their Google password, revokes access, or doesn't use the app for about 6 months.
   - Because `gmail.readonly` is a restricted scope and the app is not verified by Google, users see an **"Google hasn't verified this app"** screen once per account (click **Advanced → Go to Mail Assistant (unsafe)**). Google limits unverified apps to 100 users in total, which is irrelevant for one family.
   - `PARTLY VERIFIED`: Google's docs say public apps using these scopes "must complete a verification process"; they don't explicitly state that a private, unverified app with <100 users may stay unverified. It works in practice. If Google ever blocks it, set the app back to *Testing* (the app then shows "Sign in again" weekly).

> Google treats a desktop app's client secret as not confidential, but it still must never be committed: it lives only in your local `.env` (git-ignored) and in GitHub Actions secrets. The code repository can be public.

## Run on Windows (development)

Requirements: Node.js 22 LTS or newer, Git. No C++ build tools needed (better-sqlite3 ships ready-made binaries).

```powershell
git clone https://github.com/ZeinerMax/mail-assistant.git Mail_assistant
cd Mail_assistant
copy .env.example .env      # then put the Google client ID + secret into .env
npm install
npm run dev                  # starts the app with hot reload
npm test                     # ~250 unit tests (run inside Electron's Node)
npm run build                # typecheck + production build into out/
```

First start: **Settings** → paste your Anthropic API key → **Save key** → **Test key**. Then **Accounts → Add account** (your browser opens for Google sign-in). Then **Mail → Check now**.

### Look at the UI without real accounts

```powershell
$env:MA_USER_DATA="$env:TEMP\ma-demo"          # throwaway data folder (dev builds only)
$env:ELECTRON_RUN_AS_NODE=1; npx electron ./node_modules/vitest/vitest.mjs run --config scripts/seed.config.mts
Remove-Item Env:ELECTRON_RUN_AS_NODE
npm run build; npx electron .                   # opens with fake demo mail
# optional: $env:MA_SCREENSHOT="$env:TEMP\ma-shots" before `npx electron .` saves a PNG of every page and quits
```
These two variables are ignored in packaged builds.

## Releasing an update (one click for the users)

1. Raise `version` in `package.json` (e.g. `npm version minor --no-git-tag-version`), commit, push.
2. GitHub → **Actions → Build installers → Run workflow** (optionally type "What's new").
3. The workflow builds macOS (`.dmg` + `.zip`) and Windows (`Setup.exe`), writes `latest.json` (SHA-256 + size per platform) and publishes GitHub Release `v<version>`. It refuses to overwrite an existing version.

The installed app checks `releases/latest/download/latest.json` 10 seconds after start and every 6 hours (also **Settings → Updates → Check for updates**). When there is a newer version it shows **"New version X is available — Update and restart"**. One click downloads the file with the app's own HTTPS client (GitHub hosts only), checks size + SHA-256, then:
- **macOS:** unpacks the `.zip` with `ditto`, checks the bundle version, and a small script swaps `/Applications/Mail Assistant.app` after the app quits, removes the quarantine flag and reopens it. If the swap fails, the old app is put back. Needs the app in a folder the user can write to (`/Applications` on an admin account); otherwise the banner says so and offers **Download manually**.
- **Windows:** runs the verified `Setup.exe` silently (`/S --updated --force-run`), which replaces and restarts the app.

Never during a running mail check. Settings, API key, sign-ins and mail data live in the user-data folder and are kept. The very first version with the updater (0.2.0) must be installed by hand once.

## Build installers (GitHub Actions)

1. In the GitHub repository: *Settings → Secrets and variables → Actions → New repository secret*: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
2. *Actions → Build installers → Run workflow* (manual only).
3. Note: in a **public** repository, workflow artifacts can be downloaded by any signed-in GitHub user, and the built app contains your Google client ID and secret. Artifacts are deleted after 14 days; delete them sooner from the run page once you've downloaded them.
4. Download from the run's **Artifacts**: `Mail-Assistant-x.y.z-arm64.dmg` (Apple Silicon Mac), `…-x64.dmg` (Intel Mac), `Mail-Assistant-x.y.z-Setup.exe` (Windows).

Local Windows installer: `npm run dist` (needs the two values in `.env`). The build stops with a clear message if they are missing.

No paid code signing is used: the Mac app is **ad-hoc signed** and not notarized; the Windows installer is unsigned.

## Installing on the Mac (for the family member)

1. Open the `.dmg` and drag **Mail Assistant** into **Applications**.
2. The first time you open it, macOS says it *"cannot be opened because Apple cannot check it for malicious software"* / *"unidentified developer"*. This is expected for apps without a paid Apple certificate.
   - **macOS 15 Sequoia and newer:** try to open the app once, click **Done**, then go to **System Settings → Privacy & Security**, scroll down to the message about Mail Assistant and click **Open Anyway**, confirm with your password, then **Open**.
   - **macOS 14 and older:** right-click (Control-click) the app in Applications → **Open** → **Open**.
   - You only need to do this once.
3. If macOS asks whether Mail Assistant may use the **Keychain**, choose **Always Allow** (that is where the API key and sign-ins are stored safely).
4. If macOS asks to allow **notifications**, allow them (you get a notice when drafts are ready).
5. Add each Gmail account once (**Accounts → Add account**). On Google's *"Google hasn't verified this app"* screen click **Advanced → Go to Mail Assistant**, then **Continue**.

Windows: SmartScreen may say *"Windows protected your PC"* → **More info → Run anyway**.

## How it works

- Every *N* minutes (default 15, Settings) and on **Check now**: for each account, Gmail's history API lists new inbox messages since the last check (first check: last 24 hours). Promotions/Social tab mail is tagged *Newsletter / junk* without AI (switchable). Each other email is cleaned and sent to Haiku → summary + tag.
- Each *Important* (needs-reply) email from that check gets a Sonnet draft built from the cleaned thread. One OS notification per check ("2 new drafts ready") + a badge on **Drafts**. Emails without a draft show **Write draft**.
- The **status bar** shows e.g. *"Home: reading email 14 of 40, about 1 min left"* (estimate from the average of the last 10 emails), *"Offline — will try again at 10:57"*, or *"Check your API key in Settings"*.
- If a Google sign-in stops working, the account shows **Sign in again** (Accounts page, banner on Mail and Calendar) and the other accounts keep working.

## Project layout

```
src/main/      config, secrets (safeStorage), log, db/ (schema, repo), google/ (oauth, accounts, gmail, calendar, clean),
               imap/ (accounts, client, source), send/ (compose, mime, gmail-send, smtp, service),
               unsubscribe/ (parse, find, service), ai/ (client, prompts, triage, draft, usage),
               jobs/ (scan, scheduler, status), update/, notify, views, ipc-handlers, index
src/preload/   narrow typed bridge (window.api)
src/renderer/  React UI: Mail, Drafts, Calendar, Accounts, Settings, StatusBar
src/shared/    types, IPC contract, status text formatting
test/          vitest unit tests (incl. a guard that fails if any Gmail/Calendar write call other than sending, or any extra scope, appears)
docs/superpowers/  design spec and implementation plan
```

## Verified vs. not verified

Verified against installed library typings / official docs while building: Electron `safeStorage`, `Notification`, `app.setBadgeCount`; google-auth-library PKCE (`generateCodeVerifierAsync`, `generateAuthUrl`, `getToken`); `@googleapis/gmail` / `@googleapis/calendar` list/get parameters; Anthropic SDK `output_config.format` (structured outputs, supported on Haiku 5.5), `thinking: {type: "adaptive"}` + `output_config.effort` for Sonnet 5.5, server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`); electron-vite `MAIN_VITE_` env prefix (main process only); electron-builder ad-hoc signing (`identity: "-"` + `hardenedRuntime: false`). The Windows installer was built and launched locally.

**Not verified (needs a real Mac / real accounts):**
- The unsigned/ad-hoc-signed `.dmg` launching on Apple Silicon and Intel, the Keychain prompt, notifications and the dock badge.
- The full Google sign-in and a real Gmail/Calendar/Anthropic round trip (no credentials were available while building — all of it is covered by unit tests with fakes).
- Whether Google keeps allowing an unverified production app with `gmail.readonly` (see above).
- Sending a real reply: Gmail (including the "Sign in again" step for an existing account and the 403 missing-permission detection) and IMAP/SMTP on ports 465 and 587. Covered only by unit tests with fakes.
- Haiku 5.5 price above 100K-token prompts differs; our prompts are far below that. Prices are editable in Settings.
