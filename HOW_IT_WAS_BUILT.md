# How it was built

This document explains how Mail Assistant was designed and built, including the Google Cloud setup, the decisions behind it and the problems solved along the way. For what the app does and how to run it, see [README.md](README.md).

**Built:** November 2026 · **Approach:** AI-assisted development with Claude Code (Anthropic's coding agent) · **Size:** ~80 source files, 138 automated tests

---

## 1. The goal

A personal assistant for one family member who handles 3–4 Gmail accounts:

- summarize every new email and sort it into *needs reply*, *info* or *newsletter/junk*,
- prepare reply drafts for the emails that need an answer,
- show all calendars in one place,

with hard rules: **read-only access**, no code path that can send or change email, as little data as possible sent to the AI, secrets in the operating system's secure storage, and strict cost limits. The user is on a Mac; development happened on Windows, so it had to work on both.

## 2. How the work was organised

The project used Claude Code as the implementation agent, with me in the role of product owner and reviewer: I wrote the requirements, made the product and security decisions, did the Google Cloud setup, and tested the result. The process was deliberately structured rather than "prompt and hope":

| Step | What happened | Output |
|---|---|---|
| 1. Requirements | A written brief: features, privacy/security rules, cost control, milestones, "verify every API against official docs, don't guess". | Brief |
| 2. Brainstorming | The agent restated the brief, then raised issues I hadn't considered — e.g. Google expires sign-ins after 7 days for apps in *Testing* mode, and where the OAuth client secret should live. | Clarified requirements |
| 3. Approaches | Options were compared with trade-offs (database library, tooling). I also asked about PostgreSQL; we rejected it because it would require a database server on a non-technical user's laptop — SQLite is a single file. | Chosen approach |
| 4. Design document | Goals, non-goals, *anti-goals* ("fails if the user has to log in weekly"), data model, architecture, milestones. | `docs/superpowers/specs/…-design.md` |
| 5. Implementation plan | 20 small tasks, each with exact interfaces, the tests that prove it, and a list of risky situations to test (offline, wrong API key, duplicates, huge emails, secure storage unavailable). | `docs/superpowers/plans/…md` |
| 6. Test-driven build | Every module: write the failing test → see it fail → implement → see it pass. A progress ledger recorded every decision that deviated from the plan and why. | Code + 138 tests |
| 7. Visual check | The app was launched with fake demo data and a development-only hook took screenshots of every page, which were reviewed (this caught a real bug, see §6). | Screenshots |
| 8. Final review | Review of the whole codebase against the design (found and fixed one bug, see §6). | Fix + regression test |
| 9. Packaging | Windows installer built and launched locally; CI workflow for macOS + Windows installers. | `npm run dist`, GitHub Actions |

## 3. Architecture

```
┌──────────── Renderer (React UI) ─────────┐
│ Mail · Drafts · Calendar · Accounts ·    │   sees only summaries, tags, drafts, status.
│ Settings · status bar                    │   Never keys or tokens.
└───────────────▲──────────────────────────┘
                │ narrow typed IPC bridge (context isolation, sandbox, no Node in the UI)
┌───────────────┴──────── Main process ─────────────────────────────────────┐
│ scheduler → scanner (per account) → Gmail API (read-only)                  │
│               ├→ triage: Claude Haiku  (summary + tag, JSON schema output) │
│               └→ drafts: Claude Sonnet (adaptive thinking, effort medium)  │
│ status/ETA · notifications · usage & cost meter · per-run caps             │
│ secrets (OS secure storage) · SQLite · settings JSON                       │
└───────────────────────────────────────────────────────────────────────────┘
```

**Stack:** Electron 45, React 19, TypeScript, electron-vite, better-sqlite3, Anthropic TypeScript SDK, Google's official `google-auth-library` / `@googleapis/gmail` / `@googleapis/calendar`, FullCalendar, Vitest, electron-builder, GitHub Actions.

**Key design decisions**

| Decision | Why |
|---|---|
| All network calls, secrets and the database live in Electron's main process; the UI gets a small typed API | The UI can never read an API key or token, even if something goes wrong in it. |
| Only IDs, sender, subject, date, summary, tag and drafts are stored | Email bodies exist only in memory during a check. A test checks that no email text ever reaches the database. |
| Email text is cleaned before it goes to the AI: quoted replies, signatures, HTML and attachments removed, length capped | Less data leaves the computer, and it's cheaper. |
| Prompt-injection defence: each email is wrapped in a tag with a **random per-request name**, the model is told to ignore instructions inside, models get **no tools**, and the summary must match a JSON schema | An email saying "ignore previous instructions" can't escape its tag and can't make the app do anything. |
| A test scans the source code and fails if any Gmail/Calendar write call or extra Google permission appears | "Read-only" is enforced by the build, not just by intention. |
| Hard caps per check (emails, drafts, tokens), max one SDK retry, an email is tried at most twice | Costs can't run away; no infinite retry loops. |
| Logger that only accepts IDs, numbers and short codes | Email text, addresses or keys can't end up in a log file by accident. |
| Cheap model (Haiku) for every email, stronger model (Sonnet) only for drafts; Gmail's own Promotions/Social labels skip the AI | Most cost goes only where quality matters. |
| Model names, limits, interval and prices are settings | Models can be swapped later without code changes. |

## 4. Google Cloud setup (and what I learned)

The app reads Gmail and Calendar through Google's official APIs, so it needs its own registered OAuth client. Steps taken:

1. **Created a Google Cloud project** for the app.
2. **Enabled the Gmail API and Google Calendar API.** Both are free. The console showed a *"billing required"* message; it turned out not to apply to these APIs, so no payment method was added.
3. **Configured the Google Auth platform** (consent screen): app name, support email, audience *External*, and the two scopes `gmail.readonly` and `calendar.readonly` — nothing that can send, modify or delete.
4. **Created an OAuth client** of type *Desktop app* and stored the client ID and secret only in a local, git-ignored `.env` file (and later in GitHub Actions secrets for CI builds) — never in the code.
5. **Added test users.** The first sign-in failed with *"Access blocked: Mail Assistant has not completed the Google verification process"*. Cause: in *Testing* mode Google only allows addresses listed as test users. Fix: add each Gmail address under *Audience → Test users*.

**Testing vs. production — the main trade-off**

- In *Testing*, Google's docs say *"Authorizations by a test user will expire seven days from the time of consent"*, so the user would have to sign in again every week.
- In *In production* the sign-in lasts (until a password change, revocation, or ~6 months unused). But `gmail.readonly` is a *restricted* scope, so an unverified production app shows a one-time "Google hasn't verified this app" screen and is limited to 100 users — acceptable for a family app. Publishing may ask for branding details (logo, homepage, privacy policy); a logo triggers extra verification, so it's left empty.
- Decision: develop and test in *Testing*; publish when the app is ready for daily use.

**How the login works technically:** OAuth 2.0 for installed apps — the app opens the system browser, uses **PKCE** (S256), receives the code on a temporary **loopback** server on `127.0.0.1`, checks a random `state` value against forgery, exchanges the code for a refresh token and stores it encrypted (Windows DPAPI / macOS Keychain via Electron `safeStorage`). If Google later rejects the token (`invalid_grant`), the account shows a clear **"Sign in again"** button instead of failing silently.

**Why the Claude Google connector needs none of this:** Anthropic did the same setup (and Google's verification) for its own client. A desktop app can't borrow another company's OAuth client, so it needs its own — free, and set up once.

## 5. Verifying instead of guessing

A requirement was to not invent API names. In practice:

- Library functions were checked against the **installed type definitions** (e.g. Electron `safeStorage`, google-auth-library PKCE methods, Gmail `history.list` parameters, the Anthropic SDK's `fallbacks` and `output_config` fields) — if the code compiles against the real types, the names are real.
- Model parameters (adaptive thinking + effort for Sonnet 5.5, structured outputs on Haiku 5.5) were checked in Anthropic's current documentation.
- Google Cloud console steps and the 7-day token rule were checked against Google's documentation pages.
- Things that couldn't be checked are marked `PARTLY VERIFIED` / `TO VERIFY` in the code and listed in the README.

## 6. Problems hit and how they were solved

| Problem | Root cause | Solution |
|---|---|---|
| Project scaffolder wouldn't run in a script | It's interactive-only | Downloaded the official electron-vite React template and adapted it by hand. |
| `npm install` failed: "Could not find any Visual Studio installation" | electron-builder tried to recompile the SQLite library for Electron; no C++ compiler on the machine | Found that better-sqlite3 13 ships Node-API binaries that work in any Electron version; removed the rebuild step. Verified by running the tests inside Electron and launching the packaged app. |
| Tests need the same runtime as the app | Native module built for Electron, not plain Node | Tests run through Electron's own Node (`ELECTRON_RUN_AS_NODE=1`). |
| A test failed with a mysterious `TypeError` | The logger deliberately hides error messages (privacy), so the cause wasn't visible | Temporarily logged a sanitized snippet, found a **bug in the test helper** (settings override was replaced, not merged), fixed the test, removed the debug line. |
| Some code was written before its tests | Ordering slip | **Mutation check:** deliberately broke the draft limit and duplicate check → 3 tests failed → restored. Proves the tests catch real bugs. |
| Read-only guard test flagged the app's own Drafts page | Pattern `.drafts.` matched `window.api.drafts` | Narrowed the pattern to Gmail's `users.drafts`. |
| Calendar arrows rendered as empty boxes | The app's Content-Security-Policy blocked the calendar's embedded icon font | Found by reviewing screenshots; allowed `font-src data:`. |
| New accounts would skip the last 24 hours of mail | The account stored Gmail's current history position at sign-in | Found in the final review; first check now uses a 24-hour search. Regression test added. |
| Google "Access blocked" at sign-in | App in *Testing*, address not a test user | Added test users (see §4). |
| Push to GitHub rejected | The CLI login lacked the `workflow` permission needed to upload a CI workflow file | Refreshed the GitHub CLI login with the `workflow` scope. |

## 7. Testing

- **138 automated tests** (Vitest), covering: settings validation, encrypted secret storage, the redacting logger, database schema and queries, OAuth flow (state forgery, cancel, timeout, missing refresh token), email cleaning (HTML, attachments, English/Czech/Outlook quote styles, truncation), Gmail listing (history API, 404 fallback, paging, duplicates), prompts and prompt-injection wrapping, cost calculation, ETA, the full scan (caps, retries, offline, wrong API key, duplicates, promotions, drafts), notifications, scheduler and calendar merging.
- External services (Gmail, Calendar, Anthropic) are replaced by small fakes in tests, so the suite runs offline in ~2 seconds and costs nothing.
- **Manual:** screenshots of every page with demo data; a locally built Windows installer was launched and confirmed to open its database.

## 8. Status and next steps

- ✅ App, tests, Windows installer, CI workflow, documentation.
- ⏳ First real end-to-end run with real Gmail accounts and an Anthropic API key.
- ⏳ Install and test the macOS build on a real Mac (ad-hoc signed, not notarized — no paid Apple certificate).
- ⏳ Decide on publishing the Google app to production so sign-ins don't expire weekly.

## 9. What this project demonstrates

- Turning loose requirements into a written design, a test-first plan and a working product.
- Security- and privacy-first design: least-privilege OAuth scopes, secrets in OS storage, data minimisation, prompt-injection defence, guard tests.
- Practical LLM engineering: model selection by cost/quality, structured outputs, effort settings, token caps and cost tracking.
- Cross-platform desktop development and CI packaging without paid signing.
- Working effectively with an AI coding agent: clear requirements, reviewing its proposals, making the decisions, and insisting on verification over guesswork.
