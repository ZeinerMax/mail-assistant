# Mail Assistant — Design

Date: 2026-11-17 · Status: draft, awaiting approval

## 1. Intent

A private desktop app for **one family member** (on macOS; developed and tested on Windows). It reads 3–4 Gmail accounts, tells them what each new email is about, flags what needs a reply, and drafts those replies for them to copy. It also shows one combined calendar.

**What success looks like:** the family member installs the app, signs in to each account **once**, and from then on it just works. They never deal with setup, tokens, servers or errors they can't act on. The developer handles the one-time Google Cloud and build setup.

## 2. Goals, non-goals, anti-goals

**Goals**
- Read-only access to Gmail and Calendar for 3–4 accounts.
- Haiku: a summary and a tag (`needs_reply` / `info` / `newsletter_junk`) for each new email.
- Sonnet: a draft reply for each `needs_reply` email, stored in the app.
- A combined week/month calendar, color-coded per account.
- An always-visible status bar with an approximate time left.
- An in-app badge and a native notification when a draft is ready.
- Settings: Anthropic API key, models, check interval, per-run caps, a usage/cost counter.
- Installers for macOS and Windows, built by GitHub Actions with no paid code signing.

**Non-goals (v1)**
- Sending, deleting, labelling or changing email in any way.
- Reminders.
- AI in the calendar.
- Syncing summaries via git.
- More than one person per installation.

**Anti-goals (a failure even if it technically works)**
- The family member has to sign in again on a schedule, or sees an error they can't act on.
- Email bodies end up on disk or in logs, or more than the minimum is sent to the API. Sender, subject and date are stored on purpose (section 7).
- Any code path that could send or change email.
- Costs grow without limit (unbounded retries, no caps).
- Setup that requires the end user to install anything besides the app itself (no database server, no runtime).

## 3. Constraints

- Stack: Electron + React + TypeScript; SQLite; electron-builder.
- OAuth: Google's desktop flow (system browser, PKCE, loopback redirect). Scopes are **exactly** `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/calendar.readonly`. The account's email address comes from Gmail `users.getProfile`, so no extra identity scope is needed.
- **Sign in once:** the Google Cloud project is published as **"In production"** (unverified). In "Testing" mode, refresh tokens expire after 7 days. In production they don't expire on a timer, only on a password change (Gmail scopes), revocation, or about 6 months of no use. Users see Google's "unverified app" screen once per account. `PARTLY VERIFIED`: the expiry rules come from Google's docs. Whether a restricted scope may stay unverified for under 100 private users is not explicitly confirmed by Google's docs; it works in practice. The README will say so.
- Secrets (Anthropic key, Google refresh tokens) are stored only through Electron `safeStorage`. They are never in SQLite as plain text, never in logs, and never sent to the renderer.
- Every library call and parameter gets checked against current official docs while building. Anything that can't be checked is marked `ASSUMPTION` / `PARTLY VERIFIED` in code and listed in the milestone report.

## 4. Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. better-sqlite3 + electron-vite + electron-builder** | Mature and well documented. It's a native module, so it must be rebuilt for Electron on each OS; CI builds on real macOS and Windows runners handle that. | **Chosen** |
| B. Built-in `node:sqlite` | No native build. Its stability in Electron's bundled Node is unconfirmed. | Rejected, too uncertain |
| sql.js (WASM) | Saving the database to disk would have to be done by hand. | Dropped |
| Electron Forge | Has its own packaging, which conflicts with electron-builder. | Dropped |
| PostgreSQL (PGlite or a bundled server) | Considered at the developer's request. It adds a server or a young dependency for no gain on this small amount of data. | Dropped: "keep it as simple as it gets for the end user" |

## 5. Architecture

```
┌──────────── Renderer (React) ────────────┐
│ Mail · Drafts · Calendar · Accounts ·    │   sees: summaries, tags, drafts,
│ Settings · StatusBar (always visible)    │   status, events. NEVER keys/tokens.
└───────────────▲──────────────────────────┘
                │ contextBridge (narrow typed IPC; contextIsolation on, nodeIntegration off)
┌───────────────┴──────── Main process ─────────────────────────────────────┐
│ scheduler ─► scanner (per account) ─► Gmail (read-only)                    │
│                 │                       │ full text in memory only         │
│                 ├─► triage (Haiku) ◄────┘                                  │
│                 └─► drafter (Sonnet) ◄── thread re-fetched from Gmail      │
│ status (rolling ETA) · notify (Notification + badge) · usage meter         │
│ secrets (safeStorage) · db (better-sqlite3) · config (JSON in userData)    │
└───────────────────────────────────────────────────────────────────────────┘
```

All network calls, secrets and the database live in the main process. The renderer gets a small typed API through the preload script, for example `accounts.add()`, `settings.save()`, `drafts.list()` and `onStatus(cb)`.

## 6. Folder structure

```
Mail_assistant/
  package.json · electron.vite.config.ts · electron-builder.yml · tsconfig*.json
  .gitignore · .env.example · README.md
  .github/workflows/build.yml          # matrix: macos-latest, windows-latest
  docs/superpowers/specs/…             # this file
  src/
    shared/   types.ts · ipc.ts        # IPC contract shared by main/preload/renderer
    main/
      index.ts                         # app lifecycle, window, IPC wiring
      config.ts                        # defaults + load/save settings JSON
      secrets.ts                       # safeStorage wrapper
      log.ts                           # logger that refuses message content
      db/ schema.ts · repo.ts
      google/ oauth.ts · gmail.ts · calendar.ts · clean.ts   # clean = strip quotes/HTML/attachments, truncate
      ai/ client.ts · prompts.ts · triage.ts · draft.ts · usage.ts
      jobs/ scheduler.ts · scan.ts · status.ts
      notify.ts
    preload/ index.ts
    renderer/
      main.tsx · App.tsx
      pages/ Mail.tsx · Drafts.tsx · Calendar.tsx · Accounts.tsx · Settings.tsx
      components/ StatusBar.tsx · AccountBadge.tsx · …
  test/                                # unit tests (vitest) for clean, ETA, caps, prompts, repo
```

## 7. Data model (SQLite)

Stored: IDs, sender name and address, subject, date, summary, tag, drafts and bookkeeping. The developer approved the sender/subject exception on 2026-11-17 so the Mail list is readable offline. Never stored: email bodies, quoted text, attachments, thread text.

```sql
accounts(
  id INTEGER PK, email TEXT UNIQUE, label TEXT, color TEXT,
  status TEXT CHECK(status IN ('ok','needs_relogin','error')),
  last_history_id TEXT,          -- Gmail history cursor
  last_checked_at INTEGER, created_at INTEGER)

emails(
  id INTEGER PK, account_id INTEGER REFERENCES accounts,
  gmail_message_id TEXT, gmail_thread_id TEXT, received_at INTEGER,
  from_name TEXT, from_email TEXT, subject TEXT,
  tag TEXT CHECK(tag IN ('needs_reply','info','newsletter_junk')),
  summary TEXT,
  state TEXT CHECK(state IN ('triaged','failed','skipped')), attempts INTEGER,
  UNIQUE(account_id, gmail_message_id))

drafts(
  id INTEGER PK, email_id INTEGER REFERENCES emails,
  body TEXT, created_at INTEGER, seen_at INTEGER NULL, copied_at INTEGER NULL)

runs(
  id INTEGER PK, started_at INTEGER, finished_at INTEGER,
  status TEXT, emails_seen INTEGER, stop_reason TEXT)   -- e.g. 'done', 'cap_emails', 'cap_tokens', 'error'

usage(
  id INTEGER PK, run_id INTEGER, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, created_at INTEGER)
```

**Outside SQLite:**
- `settings.json` in `userData`. Defaults live in `config.ts`.
- `secrets.bin` in `userData`: safeStorage-encrypted JSON holding the Anthropic key and each account's refresh token.
- Calendar events are fetched live and kept in memory only.

**Settings (one config):**
- `triageModel: "claude-haiku-5-5"`
- `draftModel: "claude-sonnet-5-5"`
- `draftEffort: "medium"`
- `checkIntervalMin: 15`
- `maxEmailsPerRun: 50`
- `maxDraftsPerRun: 10`
- `maxTokensPerRun: 300000`
- `triageBodyChars: 4000`
- `draftContextChars: 12000`
- `prices`: USD per MTok input/output, editable. The table defaults to Haiku 5.5 $0.10/$0.50 and Sonnet 5.5 $2/$10.

## 8. Behaviour

**Adding an account**
1. Start a loopback server on `127.0.0.1` at a random port.
2. Open the system browser with PKCE (S256).
3. Exchange the code, then store the refresh token via safeStorage.
4. Call `users.getProfile` to get the email address and current `historyId`.
5. Assign a color from a fixed palette.

**Client ID and secret:** injected at build time from GitHub repository secrets. They're never in the repo. Google treats desktop client secrets as non-confidential. Recommend keeping the repo private.

**Re-login:** if a token refresh returns `invalid_grant`, set `status = needs_relogin`. The account then shows a red "Sign in again" button, and the status bar says so. Scanning skips that account.

**Scan run (every `checkIntervalMin`, or "Check now")**
- **Finding new mail:**
  - Per account, `history.list` from `last_history_id` (messageAdded, INBOX).
  - If the cursor is too old (Gmail returns 404), fall back to `messages.list` with `q=after:<last_checked_at>`.
  - **First run after adding an account:** the last 24 hours of inbox mail. *Builder's call.*
- **Per email:**
  - Fetch it as `full`.
  - `clean`: plain text (HTML → text), strip quoted reply chains and signatures where detectable, drop attachments, truncate to `triageBodyChars`.
  - Call Haiku and store the summary and tag. The text is then discarded.
- **Pre-filter:** Gmail's own `CATEGORY_PROMOTIONS` / `CATEGORY_SOCIAL` labels are tagged `newsletter_junk` without calling the model, which saves cost. *Builder's call*; it can be switched off in Settings.
- **Drafts:** for each new `needs_reply` email, re-fetch the thread, clean each message, keep the newest messages up to `draftContextChars`, call Sonnet, and store the draft. Then notify.
- **Caps:** the run stops as soon as any of `maxEmailsPerRun`, `maxDraftsPerRun` or `maxTokensPerRun` is hit, and records `stop_reason`. Leftover mail is picked up next run.
- **Retries:**
  - SDK `maxRetries: 1`.
  - A failed email gets `attempts += 1` and is retried at most once, in a later run. After 2 attempts it's `failed` and shown as "couldn't summarize".
  - Runs never overlap.

**Model calls (no tools for either model)**
- **Triage:**
  - `model: triageModel`
  - `output_config: { effort: "low", format: <JSON schema {summary: string, tag: enum}> }`
  - `max_tokens` ~1024
  - `PARTLY VERIFIED`: structured outputs on Haiku 5.5 is to be confirmed in the docs at build time.
- **Draft:**
  - `model: draftModel`
  - `thinking: { type: "adaptive" }`
  - `output_config: { effort: "medium" }`
  - `max_tokens` ~16000
  - This parameter shape comes from the current Anthropic API reference. Sonnet 5.5 rejects `budget_tokens` and `thinking: {type:"disabled"}`.
- **Refusals:** check `stop_reason` before reading `content`; `refusal` marks the item as failed with a clear note. The Sonnet call also opts into server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). *Builder's call*; it can be dropped.
- **Prompt-injection hygiene:**
  - The system prompt says the content between the delimiters is untrusted data and that any instructions inside it must be ignored.
  - Email text is wrapped in `<email_<random-nonce>> … </email_<random-nonce>>`, with the nonce generated per request.
  - Triage output is constrained to the schema.
  - Drafts are only ever displayed, never acted on.
- **Draft language:** the draft replies in the language of the incoming email. *Builder's call.*

**Status bar**
- The main process emits `{account, phase: 'listing'|'summarizing'|'drafting'|'idle'|'error', index, total, etaSec}`.
- ETA = rolling mean of the last 10 item durations × items left. It's shown as "about N min left", or "less than a minute".
- When idle: "Last checked 10:42 · next at 10:57".

**Notifications**
- An Electron `Notification` per completed run: "2 new drafts ready". Only one per run.
- An in-app badge on the Drafts tab.
- `app.setBadgeCount` (macOS dock). `TO VERIFY` on an unsigned macOS app.

**Calendar**
- `calendarList.list` + `events.list` per account for the visible range (`singleEvents=true`, `orderBy=startTime`).
- Merged into one week/month grid, colored by account.
- No AI, no reminders.
- Grid component: a small React calendar library (FullCalendar or similar). *Builder's call*, to be checked for license and maintenance.

**Settings**
- The API key field is write-only: saved, then shown as `••••last4`.
- Models, interval, caps, prices, and the promotions pre-filter toggle.
- Usage counter: tokens and estimated cost, for this month and all time, per model.

**Logging**
- `log.ts` only accepts IDs, counts, durations and error classes.
- No email text, no keys, no tokens. Anthropic/Google error messages are reduced to status code and type.

## 9. Milestones

Each milestone ends with how to run and test it, and what couldn't be verified.

1. **Shell + settings:**
   - electron-vite scaffold, the 5 tabs, and the StatusBar placeholder.
   - Settings saved to JSON; the API key stored via safeStorage.
   - SQLite schema created, plus a "Test API key" button (one tiny Haiku call).
2. **Accounts + calendar:**
   - OAuth loopback + PKCE, multi-account, the re-login state, and the combined calendar.
3. **Haiku triage + status bar:**
   - Scheduler, history cursor, cleaning, caps, the Mail tab with summaries by tag, ETA, and the usage meter.
4. **Sonnet drafts:**
   - Thread context, Drafts tab with a copy button, notifications and badge.
5. **Packaging:**
   - electron-builder config (dmg for macOS, NSIS for Windows) and the GitHub Actions matrix with build-time Google secrets.
   - README: Google Cloud setup (project → enable Gmail and Calendar APIs → consent screen → **publish to production** → desktop OAuth client); a Windows dev guide; macOS "unidentified developer" / Sequoia "Open Anyway" steps; the "unverified app" sign-in screen.

## 10. Decided by the developer

- Store sender name and address, subject and date alongside the summary and tag. Bodies are never stored.
- UI language: English only. Drafts still reply in the language of the incoming email.
- Stack and SQLite library: approach A. PostgreSQL was considered and dropped.
- Sign in once per account: the Google project is published to production (section 3).

## 11. Left to the builder (to be confirmed during build)

- Exact electron-vite / electron-builder / better-sqlite3 versions that work together (the native rebuild step).
- macOS: whether electron-builder's ad-hoc signing is enough for Apple Silicon to launch the app, and whether notifications and Keychain-backed safeStorage behave on an unsigned app. `TO VERIFY` in milestone 5 on a real Mac.
- The quote-stripping heuristic (Gmail-style `On … wrote:`, `>` lines, Outlook headers), unit-tested on sample texts.
