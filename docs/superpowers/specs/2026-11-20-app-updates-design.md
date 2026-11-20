# One-click app updates — design

Date: 2026-11-20 · Status: draft for approval

## Intent

Mail Assistant runs on **one MacBook** (main focus) and maybe one Windows PC later. When the developer
changes the app, getting the new version onto that machine must be **as little work as possible** for the
person using it. Today every update means building an installer, carrying the file over, opening the `.dmg`,
dragging it to Applications and clicking through macOS's "unidentified developer" warning.

Success: the app says *"Version 0.3.0 is available"*, the user clicks **Update and restart**, and a moment
later the new version is running. The developer's side is one click on GitHub.

## Goals

- The app notices a new version by itself (on start and every 6 hours) and offers **Update and restart**.
- One click downloads, verifies, installs and restarts. No dragging, no Finder, no `.dmg`.
- Works on macOS (Apple Silicon and Intel) now; Windows uses the same mechanism.
- Settings, API key, sign-ins, mail summaries and drafts survive updates (they already live in the separate
  user-data folder, not inside the app).
- Developer releases a version by bumping the version number and clicking **Run workflow**.

## Non-goals

- Fully silent background installs without asking (the user should see that something changes).
- Paid Apple Developer signing / notarization (option 3, rejected: $99/year for one MacBook).
- Delta updates, rollback UI, multiple update channels (beta/stable).
- Updating the very first install: the MacBook needs **one last manual install** of the first version that
  contains the updater (0.2.0). From then on, updates are one click.

## Anti-goals (would make it a failure even if it "works")

- An update that leaves the user with a broken or half-replaced app and no way back.
- Installing anything that wasn't verified to be exactly the file the GitHub build produced.
- Updating in the middle of a mail check (half-written summaries/drafts).
- Prompting more than the old manual way (e.g. a Gatekeeper warning *and* a password prompt every time).

## Constraints

- **macOS app is unsigned (ad-hoc signature).** The standard Electron auto-updater (Squirrel.Mac / electron-updater)
  refuses unsigned apps, so the update must be done by the app's own small installer.
- **Public repository.** Release files are public. They contain the Google OAuth client ID/secret. Accepted:
  Google treats a desktop app's client secret as not confidential, the OAuth app is limited to listed test users /
  <100 users, and a private repo would break unauthenticated downloads.
- Gatekeeper: macOS shows the "unidentified developer" warning for files that carry the `com.apple.quarantine`
  attribute (set by browsers and Finder downloads). A file written by the app itself through Node's own HTTPS code
  is not quarantined. **TO VERIFY on the real MacBook** — the developer machine is Windows, so the macOS path can only
  be unit-tested here; the first real update on the MacBook is the acceptance test. As a safety net the installer
  also removes the attribute (`xattr -dr com.apple.quarantine`) from the new app.
- The app must be in a folder the user can write to (normally `/Applications` for an admin user). If it isn't
  (e.g. started straight from the `.dmg`, or macOS "App Translocation"), the one-click update is not possible.

## Approaches considered

1. **Update notice + manual install** — the app only shows "new version, Download"; the user installs the `.dmg` by
   hand. Simplest to build, but 1–2 minutes and several steps per update, likely with the Gatekeeper warning again.
2. **One-click self-update (chosen)** — the app downloads, verifies, replaces itself and restarts. Free, one click,
   medium build. Picked by the user because it is the least work per update without paying for a certificate.
3. **Apple Developer certificate + standard electron-updater** — fully automatic and the "proper" way, but $99/year
   plus signing/notarization setup in CI. Overkill for one MacBook.

## Design

### Release side (GitHub Actions)

- `electron-builder.yml`: macOS gets a second target `zip` (per arch) next to `dmg`. The zip is what the updater
  installs; the dmg stays for first installs. Windows keeps the NSIS `Setup.exe`.
- The **Build installers** workflow, after both builds succeed, runs a third job **release** that:
  1. reads the version from `package.json`; fails if a release `v<version>` already exists (forces a version bump);
  2. computes SHA-256 of every update file;
  3. writes `latest.json`:
     ```json
     {
       "version": "0.3.0",
       "notes": "<optional text from the workflow input>",
       "files": {
         "darwin-arm64": { "name": "Mail-Assistant-0.3.0-arm64-mac.zip", "sha256": "…", "size": 123 },
         "darwin-x64":   { "name": "Mail-Assistant-0.3.0-x64-mac.zip",   "sha256": "…", "size": 123 },
         "win32-x64":    { "name": "Mail-Assistant-0.3.0-Setup.exe",     "sha256": "…", "size": 123 }
       }
     }
     ```
  4. creates GitHub Release `v<version>` with the zips, dmgs, Setup.exe and `latest.json` (`gh release create`,
     job permission `contents: write`).
- Workflow input `notes` (optional, free text) becomes the "What's new" text shown in the app.
- Workflow artifacts are still uploaded but kept 1 day (the release is now the download place).

### App side

New module `src/main/update/` (main process only):

- **check()**: `GET https://github.com/ZeinerMax/mail-assistant/releases/latest/download/latest.json`
  (follows GitHub's redirect; no API token, no API rate limit). Compares `version` with `app.getVersion()` using
  semver ordering. Result: `none | available {version, notes} | error`. Runs 10 s after start and every 6 hours;
  also from a **Check for updates** button in Settings. Network errors are silent (shown only after a manual check).
- **download(version)**: picks `files["<platform>-<arch>"]`, downloads it over HTTPS with Node's own HTTP client
  (only hosts `github.com` and `*.githubusercontent.com`, redirects followed only to those) into
  `<userData>/updates/<version>/`, with progress events. Verifies size and SHA-256; on mismatch deletes the file and
  reports an error. Nothing is installed from an unverified file.
- **install()** — macOS:
  1. find the running bundle (`…/Mail Assistant.app`, from `process.execPath`); refuse with a clear message if it is
     inside `/Volumes/…` (running from the dmg) or `AppTranslocation`, or if its parent folder isn't writable;
  2. extract the zip with `ditto -x -k` into the updates folder; check the extracted bundle's `Info.plist`
     `CFBundleShortVersionString` equals the expected version;
  3. write a small shell script to the updates folder and start it **detached**, then quit the app. The script:
     waits for the app's PID to exit → moves the old bundle to `…/Mail Assistant.app.old` → moves the new bundle into
     place → `xattr -dr com.apple.quarantine` on it → `open` it → removes `.old` and the updates folder.
     If moving the new bundle fails, it moves `.old` back and re-opens the old version (no broken state).
- **install()** — Windows: run the verified `Setup.exe` with `/S` (NSIS silent; the installer is per-user, so no
  admin prompt) detached, then quit; the installer replaces the app and is told to relaunch it
  (`--updated` run after install via the NSIS `runAfterFinish` behaviour, **TO VERIFY**, else the script starts it).
- Never installs while a mail check is running: **Update and restart** waits for the scanner lock to be free
  (button shows "Waiting for the current check…").
- Logs only versions, sizes and error types (no URLs with tokens — there are none — and no user data).

### UI

- A slim banner at the top of every page when an update is available:
  `New version 0.3.0 is available.  [What's new]  [Update and restart]`
  While downloading: `Downloading update… 45%`. On error: short text + **Try again**, plus a fallback link
  **Download manually** (the release page) so the user is never stuck.
- Settings → **Updates** card: current version, **Check for updates**, last check time, result.
- After an update the app shows once: `Updated to 0.3.0.`

### Developer workflow (documented in README)

1. Bump `version` in `package.json` (e.g. `npm version minor`), commit, push.
2. GitHub → Actions → **Build installers** → Run workflow (optionally type "What's new").
3. Done: within ~6 hours (or on the next app start) the MacBook shows the banner.

## Decided by the user

- Approach 2 (one-click self-update, free, no Apple certificate).
- MacBook first; Windows later with the same mechanism.

## My calls (correct me)

- Releases are public GitHub Releases (repo is public; see Constraints).
- Check on start + every 6 hours; the user always clicks to install (no silent install).
- The first version with the updater is **0.2.0**, installed by hand once.
- "What's new" text comes from the workflow input; empty is allowed.

## Left to the builder

- Exact semver comparison helper, progress event plumbing, banner styling.
- Exact `ditto`/shell script quoting and the PID wait loop.
- Tests: manifest parsing, version comparison, host allow-list, checksum mismatch, refusal cases (dmg / translocated /
  read-only folder), "waits for running check", script generation (snapshot), Windows path selection.
