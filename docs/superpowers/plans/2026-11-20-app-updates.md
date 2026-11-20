# One-click App Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app finds a newer GitHub Release by itself and installs it with one click ("Update and restart") on macOS (and Windows), without Apple signing.

**Architecture:** A main-process module `src/main/update/` reads `latest.json` from the latest GitHub Release, downloads the platform file with Node's own HTTPS (no quarantine), verifies SHA-256 + size, then hands over to a small platform installer: on macOS a detached shell script swaps the `.app` bundle after the app quits; on Windows the NSIS installer runs silently. The renderer shows a banner and a Settings card via IPC. The GitHub workflow gains a `release` job that builds `latest.json` and publishes the release.

**Tech Stack:** Electron 45, TypeScript, Node `fetch`/`crypto`/`child_process`, electron-builder 26 (dmg + zip, NSIS), GitHub Actions + `gh release`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-app-updates-design.md`

## Global Constraints

- Manifest URL: `https://github.com/ZeinerMax/mail-assistant/releases/latest/download/latest.json`
- Download hosts allowed: `github.com` and `*.githubusercontent.com` only, HTTPS only, also after redirects.
- Platform keys in `latest.json`: `darwin-arm64`, `darwin-x64`, `win32-x64`; each `{ name, sha256, size }`.
- Check 10 s after start and every 6 hours; manual **Check for updates** in Settings.
- Never install while a mail check runs; stop the scheduler before installing.
- macOS: extract with `ditto -x -k`; verify `CFBundleShortVersionString`; remove quarantine with `xattr -dr com.apple.quarantine`; on failure restore `…/Mail Assistant.app.old` and reopen it.
- macOS refusal cases: bundle under `/Volumes/`, path containing `AppTranslocation`, parent folder not writable.
- Windows: run verified `Setup.exe` with `/S --updated --force-run`, detached, then quit.
- Logs: only versions, sizes, error names. No user data.
- First updater version is `0.2.0`; release tag `v<version>`; the workflow fails if that tag exists.
- UI copy: banner `New version {v} is available.` + `What's new` + `Update and restart`; `Downloading update… {n}%`; `Waiting for the current check…`; error + `Try again` + `Download manually` (link `https://github.com/ZeinerMax/mail-assistant/releases/latest`); once after update `Updated to {v}.`

## Review Focus

1. A release without a file for this machine (e.g. no `darwin-x64`) → no banner, no error shown on automatic checks.
2. Connection drops mid-download → partial file deleted, banner shows error + Try again; a retry starts clean.
3. Double click on "Update and restart" (or click during an automatic check) → exactly one download/install.
4. Bundle path with spaces (`/Applications/Mail Assistant.app`) → script quotes every path.
5. Malformed or non-newer manifest version (`"0.2"`, `"0.2.0-beta"`, equal, lower) → nothing offered.

Each line has a pinned test in the owning task (marked **[RF n]**).

---

### Task 0: Commit the pending feature work

The IMAP / answered / language changes are uncommitted on `main`; the release must contain them.

- [ ] **Step 1:** Run `npm test` → expect all tests pass (167).
- [ ] **Step 2:** Commit everything except `docs/` plans:
```bash
git add -A src test README.md package.json package-lock.json
git commit -m "IMAP mailboxes (Webglobe), full email reader, Gmail links, already-answered detection, reply/summary in the email's language"
```

### Task 1: Manifest, versions, host allow-list (pure functions)

**Files:**
- Create: `src/main/update/manifest.ts`
- Test: `test/update-manifest.test.ts`

**Interfaces:**
- Produces:
  - `type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'`
  - `interface UpdateFile { name: string; sha256: string; size: number }`
  - `interface Manifest { version: string; notes: string; files: Partial<Record<PlatformKey, UpdateFile>> }`
  - `parseManifest(raw: unknown): Manifest` — throws `Error('bad manifest')` on wrong shape; `notes` defaults to `''`; `sha256` must be 64 hex chars; `size` positive integer; `name` must match `/^[\w.-]+$/`.
  - `compareVersions(a: string, b: string): number` — strict `X.Y.Z` only; returns -1/0/1; throws on anything else.
  - `isNewer(candidate: string, current: string): boolean` — false (no throw) for malformed input.
  - `platformKey(platform: string, arch: string): PlatformKey | null`
  - `isAllowedUrl(url: string): boolean`
  - `MANIFEST_URL`, `RELEASES_PAGE` constants (values from Global Constraints)
  - `fileUrl(version: string, name: string): string` → `https://github.com/ZeinerMax/mail-assistant/releases/download/v${version}/${name}`

- [ ] **Step 1: Write the failing tests**
```ts
expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
expect(isNewer('0.2.0', '0.1.0')).toBe(true)
expect(isNewer('0.2.0', '0.2.0')).toBe(false)          // [RF 5]
expect(isNewer('0.1.9', '0.2.0')).toBe(false)          // [RF 5]
expect(isNewer('0.2', '0.1.0')).toBe(false)            // [RF 5]
expect(isNewer('0.2.0-beta', '0.1.0')).toBe(false)     // [RF 5]
expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64')
expect(platformKey('linux', 'x64')).toBeNull()
expect(isAllowedUrl('https://objects.githubusercontent.com/x')).toBe(true)
expect(isAllowedUrl('http://github.com/x')).toBe(false)
expect(isAllowedUrl('https://github.com.evil.io/x')).toBe(false)
expect(isAllowedUrl('https://evilgithubusercontent.com/x')).toBe(false)
expect(parseManifest({ version: '0.2.0', files: { 'darwin-arm64': { name: 'a.zip', sha256: 'a'.repeat(64), size: 5 } } }).notes).toBe('')
expect(() => parseManifest({ version: '0.2.0', files: { 'darwin-arm64': { name: '../x', sha256: 'a'.repeat(64), size: 5 } } })).toThrow('bad manifest')
expect(parseManifest({ version: '0.2.0', files: {} }).files['darwin-x64']).toBeUndefined()   // [RF 1]
```
- [ ] **Step 2:** `npx cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run test/update-manifest.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the functions above in `src/main/update/manifest.ts`. Host check: `new URL(u)`, protocol `https:`, hostname `=== 'github.com'` or ends with `'.githubusercontent.com'`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(update): manifest parsing, version compare, host allow-list`.

### Task 2: Verified download

**Files:**
- Create: `src/main/update/download.ts`
- Test: `test/update-download.test.ts`

**Interfaces:**
- Consumes: `UpdateFile`, `isAllowedUrl` (Task 1)
- Produces:
  - `type FetchLike = (url: string, init?: { redirect: 'manual' }) => Promise<Response>`
  - `fetchFollowingAllowed(fetchImpl: FetchLike, url: string, maxRedirects = 5): Promise<Response>` — follows 301/302/303/307/308 manually, every hop must pass `isAllowedUrl`, else throws `Error('blocked host')`.
  - `downloadVerified(fetchImpl: FetchLike, url: string, dest: string, file: UpdateFile, onProgress: (pct: number) => void): Promise<void>` — streams to `dest + '.part'`, hashes SHA-256 while streaming, checks size and hash, then renames to `dest`. On any error deletes `.part` and rethrows (`Error('checksum mismatch')`, `Error('size mismatch')`).

- [ ] **Step 1: Write the failing tests** (fake `fetch` returning `new Response(body, { status, headers })` into a temp dir):
  - `downloads, verifies and renames` → `dest` exists, `.part` gone, progress last value `100`.
  - `checksum mismatch deletes the file` → rejects `'checksum mismatch'`, neither `dest` nor `.part` exists.
  - `stream error mid-download removes the partial file` → body `ReadableStream` that errors after first chunk → rejects, no `.part` **[RF 2]**.
  - `retry after failure starts clean` → second call with good body succeeds **[RF 2]**.
  - `redirect to a non-GitHub host is blocked` → 302 `location: https://evil.example/x` → rejects `'blocked host'`.
- [ ] **Step 2:** Run the file → FAIL.
- [ ] **Step 3:** Implement with `fs.createWriteStream`, `crypto.createHash('sha256')`, `Readable.fromWeb(res.body)`; progress from bytes / `file.size`, rounded, emitted at most once per percent.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(update): verified download with host allow-list`.

### Task 3: macOS installer

**Files:**
- Create: `src/main/update/install-mac.ts`
- Test: `test/update-install-mac.test.ts`

**Interfaces:**
- Produces:
  - `bundleFromExecPath(execPath: string): string | null` — `/Applications/Mail Assistant.app/Contents/MacOS/Mail Assistant` → `/Applications/Mail Assistant.app`; null if no `.app/Contents/MacOS/` segment.
  - `macRefusal(bundle: string, canWrite: (dir: string) => boolean): string | null` — returns user-facing text or null:
    - under `/Volumes/` → `Mail Assistant is running from the disk image. Drag it into Applications first, then update.`
    - contains `AppTranslocation` → `macOS is running Mail Assistant from a temporary location. Move it into Applications, open it from there, then update.`
    - parent not writable → `Mail Assistant can't replace itself in this folder. Use “Download manually” instead.`
  - `macSwapScript(p: { pid: number; bundle: string; newBundle: string; workDir: string }): string` — POSIX sh; every path single-quoted with `'` escaped as `'\''`.
  - `installMac(deps: { zipPath: string; version: string; execPath: string; pid: number; workDir: string; run: (cmd: string, args: string[]) => Promise<string>; spawnDetached: (scriptPath: string) => void; writeFile: (p: string, s: string) => void; canWrite: (dir: string) => boolean }): Promise<void>` — refusal check → `run('ditto', ['-x','-k', zipPath, workDir+'/extract'])` → `run('/usr/libexec/PlistBuddy', ['-c','Print :CFBundleShortVersionString', <newBundle>/Contents/Info.plist])` must equal `version` (else `Error('version mismatch')`) → write script → `spawnDetached`. Quitting the app is the caller's job.

- [ ] **Step 1: Write the failing tests**
  - `bundleFromExecPath` happy path and `null` for `/usr/bin/node`.
  - `macRefusal` returns the three texts above and `null` for `/Applications/Mail Assistant.app` with `canWrite → true`.
  - `macSwapScript` snapshot-style assertions **[RF 4]**:
    ```ts
    const s = macSwapScript({ pid: 42, bundle: "/Applications/Mail Assistant.app", newBundle: "/tmp/u/extract/Mail Assistant.app", workDir: "/tmp/u" })
    expect(s).toContain("while kill -0 42")
    expect(s).toContain("mv '/Applications/Mail Assistant.app' '/Applications/Mail Assistant.app.old'")
    expect(s).toContain("xattr -dr com.apple.quarantine '/Applications/Mail Assistant.app'")
    expect(s).toContain("open '/Applications/Mail Assistant.app'")
    // rollback branch: if moving the new bundle fails, restore .old and reopen
    expect(s).toMatch(/mv '\/Applications\/Mail Assistant\.app\.old' '\/Applications\/Mail Assistant\.app'/)
    expect(macSwapScript({ pid: 1, bundle: "/A/it's.app", newBundle: '/n', workDir: '/w' })).toContain("'/A/it'\\''s.app'")
    ```
  - `installMac` with fakes: calls `ditto` then `PlistBuddy`, writes script, spawns once; version mismatch → rejects, `spawnDetached` not called; refusal → rejects with the refusal text, `run` not called.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Script order: wait loop (`while kill -0 PID 2>/dev/null; do sleep 0.5; done`) → `rm -rf .old` → `mv bundle .old` → `if mv new bundle; then xattr …; open bundle; rm -rf .old workDir; else mv .old bundle; open bundle; fi`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(update): macOS bundle swap installer`.

### Task 4: Windows installer + update service

**Files:**
- Create: `src/main/update/install-win.ts`, `src/main/update/service.ts`
- Test: `test/update-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `installWin(setupPath: string, spawnDetached: (file: string, args: string[]) => void): void` — args exactly `['/S', '--updated', '--force-run']`.
  - `type UpdateState = { phase: 'idle' } | { phase: 'checking' } | { phase: 'available'; version: string; notes: string } | { phase: 'waiting'; version: string } | { phase: 'downloading'; version: string; percent: number } | { phase: 'installing'; version: string } | { phase: 'error'; message: string; version?: string } | { phase: 'uptodate'; checkedAt: number }` (in `src/shared/ipc.ts` so the renderer can use it)
  - `createUpdater(deps: { currentVersion: string; platform: string; arch: string; workRoot: string; fetch: FetchLike; isBusy: () => boolean; beforeInstall: () => void; install: (file: string, version: string) => Promise<void>; quit: () => void; emit: (s: UpdateState) => void; sleep: (ms: number) => Promise<void> }): { check(manual: boolean): Promise<UpdateState>; update(): Promise<void>; state(): UpdateState }`
  - `UPDATE_CHECK_FIRST_MS = 10_000`, `UPDATE_CHECK_EVERY_MS = 6 * 3600_000`

- [ ] **Step 1: Write the failing tests** (fake fetch serving a manifest and file; temp `workRoot`):
  - `newer manifest → available` with `version` and `notes`.
  - `same version → uptodate`.
  - `no file for this platform → stays idle` **[RF 1]**: automatic check → `state().phase === 'idle'`, no `error` emitted; manual check → `uptodate`.
  - `manifest 404 (no release yet) → uptodate`, no error.
  - `network error on automatic check stays quiet` (phase `idle`), `on manual check → error` with message `Could not check for updates. Check your internet connection.`
  - `update() waits while a check runs` → `isBusy` true for two polls → emits `waiting`, then `downloading`, then `installing`; `beforeInstall` called before `install`; `quit` called once.
  - `double update() → one install` **[RF 3]**: `await Promise.all([u.update(), u.update()])` → `install` called once.
  - `download failure → error with version; next update() retries` **[RF 2]**.
  - `installWin` passes exactly `['/S','--updated','--force-run']`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Download target `workRoot/<version>/<file.name>`; `update()` is guarded by an in-flight promise; poll `isBusy` every 2 s via `deps.sleep`; error texts: download/checksum → `The update could not be downloaded. Try again or download it manually.`; install refusal → the refusal text from Task 3.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(update): update service and Windows installer`.

### Task 5: IPC, banner, Settings card, wiring

**Files:**
- Modify: `src/shared/ipc.ts` (channels `updateState: 'update:state'`, `updateCheck: 'update:check'`, `updateInstall: 'update:install'`, event `evUpdate: 'ev:update'`; `Api.update: { state(): Promise<UpdateState & { current: string; justUpdated: string | null }>; check(): Promise<UpdateState>; install(): Promise<void> }`, `onUpdate(cb)`)
- Modify: `src/preload/index.ts`, `src/main/ipc-handlers.ts` (AppContext gains `updater`, `appVersion`, `justUpdated`)
- Modify: `src/main/index.ts` — build updater with real deps: `fetch: globalThis.fetch`, `workRoot: <userData>/updates`, `isBusy: scanner.isRunning`, `beforeInstall: scheduler.stop`, `install`: darwin → `installMac` (`run` = `execFile` promisified, `spawnDetached` = `spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()`, `canWrite` = `fs.accessSync(dir, W_OK)`), win32 → `installWin`; `quit: app.quit`; timers per Global Constraints. "Updated" note: file `<userData>/last-version`; on start, if it exists and differs from `app.getVersion()`, `justUpdated = app.getVersion()`; then write current version.
- Create: `src/renderer/src/components/UpdateBanner.tsx`; Modify: `src/renderer/src/App.tsx` (banner above `<main>` content), `src/renderer/src/pages/Settings.tsx` (`UpdatesCard`: current version, Check for updates, last result), `src/renderer/src/styles.css`.
- Test: `test/no-write-paths.test.ts` stays green; add to it: the update module is the only place using `spawn(` / `execFile(` (`src/main/update/**` or `src/main/index.ts`).

- [ ] **Step 1:** Add the IPC contract + preload; `npm run typecheck` → errors only where handlers/UI are missing.
- [ ] **Step 2:** Implement handlers, wiring, banner (all copy from Global Constraints; "What's new" toggles `notes` text; "Download manually" is an `<a target="_blank">` to `RELEASES_PAGE`), Settings card, "Updated to {v}." one-time `msg ok` at the top of Mail page.
- [ ] **Step 3:** `npm run typecheck && npm test` → PASS.
- [ ] **Step 4:** `npm run dev`, Settings → **Check for updates** → shows `You have the latest version.` (no release with `latest.json` exists yet → 404 → `uptodate`).
- [ ] **Step 5:** Commit `feat(update): update banner, Settings card and app wiring`.

### Task 6: Release pipeline, version 0.2.0, docs

**Files:**
- Modify: `electron-builder.yml` — mac targets `dmg` and `zip` (arch arm64, x64); `zip.artifactName: Mail-Assistant-${version}-${arch}-mac.${ext}`.
- Modify: `.github/workflows/build.yml` — `workflow_dispatch.inputs.notes` (string, optional); upload `release/*.zip` too; artifact `retention-days: 1`; new job `release` (`needs: build`, `runs-on: ubuntu-latest`, `permissions: contents: write`): download both artifacts → read version from `package.json` → fail if `gh release view v$V` succeeds → `node scripts/make-manifest.mjs <dir> <version> "<notes>" > latest.json` → `gh release create v$V <files> latest.json --title "Mail Assistant $V" --notes "<notes>"`.
- Create: `scripts/make-manifest.mjs` — maps `*-arm64-mac.zip` → `darwin-arm64`, `*-x64-mac.zip` → `darwin-x64`, `*-Setup.exe` → `win32-x64`; sha256 + size; output passes `parseManifest`.
- Test: `test/make-manifest.test.ts` — temp dir with three dummy files → JSON parses with `parseManifest`, keys and hashes correct.
- Modify: `package.json` version `0.2.0`; `README.md` section **Releasing an update** (the 3 developer steps from the spec) and **Updating on the Mac** (banner → Update and restart; first time install 0.2.0 by hand).

- [ ] **Step 1:** Write `test/make-manifest.test.ts` → FAIL; implement the script → PASS.
- [ ] **Step 2:** Edit builder config, workflow, version, README.
- [ ] **Step 3:** `npm test && npm run build` → PASS; `npm run dist` on Windows produces `release/Mail-Assistant-0.2.0-Setup.exe`.
- [ ] **Step 4:** Commit `feat(update): publish GitHub releases with latest.json; version 0.2.0`; push; run the workflow; `gh release view v0.2.0` lists 2 dmg, 2 zip, Setup.exe, latest.json; download `latest.json` from `MANIFEST_URL` and check it parses.
- [ ] **Step 5:** Delete the old public workflow artifacts from run 44589041108 (`gh api -X DELETE repos/ZeinerMax/mail-assistant/actions/artifacts/<id>`).

### Task 7: Acceptance on real machines

- [ ] **Step 1 (Windows, here):** install `0.2.0` Setup.exe; bump to `0.2.1`, release; the installed app shows the banner; Update and restart → app restarts as 0.2.1 and shows `Updated to 0.2.1.`; settings/key/accounts still there.
- [ ] **Step 2 (MacBook, user):** install `0.2.x` dmg by hand once (last manual install). After the next release, the banner appears → Update and restart → app restarts on the new version with no Gatekeeper warning. If a warning appears, record it (spec item "TO VERIFY").
