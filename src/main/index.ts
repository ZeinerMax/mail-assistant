import { app, shell, BrowserWindow, Notification, clipboard } from 'electron'
import { join } from 'path'
import { log, setLogFile, redactError } from './log'
import { openDb } from './db/schema'
import { Repo } from './db/repo'
import { createSecretStore } from './secrets'
import { electronCipher } from './secrets-electron'
import { registerIpc, send, emitStatus, ANTHROPIC_KEY, type AppContext } from './ipc-handlers'
import { createAccountService } from './google/accounts'
import { runLoopbackAuth, getClientCredentials } from './google/oauth'
import { getProfile, makeAuth, gmailFor, calendarFor } from './google/clients'
import type { CalendarLike } from './google/calendar'
import type { GmailLike } from './google/gmail'
import { loadSettings } from './config'
import { createAnthropic } from './ai/client'
import { triage } from './ai/triage'
import { buildDraftContext, draftReply } from './ai/draft'
import { createScanner, type AiPort, type RunResult } from './jobs/scan'
import { createScheduler } from './jobs/scheduler'
import { notifyDraftsReady } from './notify'
import { finalStatus } from './views'
import { CH, type RunResultView } from '@shared/ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(onLoaded: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Mail Assistant',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.on('did-finish-load', onLoaded)
  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// Development-only: separate data folder + automatic screenshots of each page (never active in packaged builds).
if (!app.isPackaged && process.env.MA_USER_DATA) app.setPath('userData', process.env.MA_USER_DATA)

async function devScreenshots(win: BrowserWindow, dir: string): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs')
  mkdirSync(dir, { recursive: true })
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  await wait(1500)
  for (const [i, label] of ['Mail', 'Drafts', 'Calendar', 'Accounts', 'Settings'].entries()) {
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.nav-btn')].find(b => b.textContent.startsWith(${JSON.stringify(label)}))?.click()`
    )
    await wait(900)
    const img = await win.webContents.capturePage()
    writeFileSync(join(dir, `${i + 1}-${label.toLowerCase()}.png`), img.toPNG())
  }
  app.quit()
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.family.mailassistant')
  const dataDir = app.getPath('userData')
  setLogFile(join(dataDir, 'logs', 'app.log'))
  log.info('app_start', { version: app.getVersion() })

  const repo = new Repo(openDb(join(dataDir, 'mail.sqlite')))
  const secrets = createSecretStore(join(dataDir, 'secrets.bin'), electronCipher)
  const accounts = createAccountService({
    repo,
    secrets,
    signIn: () => runLoopbackAuth({ ...getClientCredentials(), openUrl: (url) => shell.openExternal(url) }),
    getProfile,
    makeAuth
  })
  const win = { getWindow: () => mainWindow }

  /** Built per run so a new API key / settings apply immediately. Full email text stays inside these closures. */
  function aiPort(): AiPort | null {
    const key = secrets.get(ANTHROPIC_KEY)
    if (!key) return null
    const client = createAnthropic(key)
    return {
      triage: (input) => triage(client, input, loadSettings(dataDir)),
      draft: async ({ thread, targetMessageId, ownerEmail }) => {
        const s = loadSettings(dataDir)
        const ctx = buildDraftContext(thread, targetMessageId, s.draftContextChars, ownerEmail)
        return draftReply(client, ctx, s)
      }
    }
  }

  const refreshBadge = (): void => {
    const n = repo.unseenDraftCount()
    send(win, CH.evBadge, n)
    app.setBadgeCount(n) // macOS dock / Linux; no-op on Windows. TO VERIFY on unsigned macOS build.
  }

  const scanner = createScanner({
    repo,
    get settings() {
      return loadSettings(dataDir)
    },
    get ai() {
      return aiPort()
    },
    getGmail: async (id) => gmailFor(await accounts.getAuth(id)) as unknown as GmailLike,
    emit: (s) => emitStatus(win, s),
    now: () => Date.now(),
    onDraftsReady: (count) =>
      notifyDraftsReady(count, {
        show: (title, body) => {
          if (!Notification.isSupported()) return
          const n = new Notification({ title, body })
          n.on('click', () => {
            mainWindow?.show()
            mainWindow?.focus()
          })
          n.show()
        },
        setBadge: () => refreshBadge(),
        unseen: () => repo.unseenDraftCount()
      })
  })

  const toView = (r: RunResult | undefined): RunResultView =>
    r
      ? { status: r.status, stopReason: r.stopReason, triaged: r.triaged, drafted: r.drafted }
      : { status: 'done', stopReason: 'error', triaged: 0, drafted: 0 }

  const scheduler = createScheduler({
    run: async () => {
      const r = await scanner.run()
      if (r.status === 'done') emitStatus(win, finalStatus(r, Date.now(), scheduler.nextRunAt()))
      else if (r.status === 'no_api_key')
        emitStatus(win, { phase: 'idle', message: 'Add your Anthropic API key in Settings to start' })
      else if (r.status === 'no_accounts') emitStatus(win, { phase: 'idle', message: 'Add a Gmail account to start' })
      send(win, CH.evDataChanged)
      refreshBadge()
      return r
    },
    intervalMin: () => loadSettings(dataDir).checkIntervalMin,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as NodeJS.Timeout)
  })

  const ctx: AppContext = {
    dataDir,
    repo,
    secrets,
    accounts,
    getWindow: win.getWindow,
    runNow: async () => {
      if (scanner.isRunning()) return { status: 'already_running', stopReason: 'done', triaged: 0, drafted: 0 }
      return toView(await scheduler.runNow())
    },
    draftOne: (emailId) => scanner.draftOne(emailId),
    onSettingsChanged: () => scheduler.reschedule(),
    writeClipboard: (text) => clipboard.writeText(text),
    refreshBadge,
    getCalendar: async (id) => calendarFor(await accounts.getAuth(id)) as unknown as CalendarLike
  }
  registerIpc(ctx)

  let started = false
  const onLoaded = (): void => {
    refreshBadge()
    if (!started) {
      started = true
      if (!app.isPackaged && process.env.MA_SCREENSHOT && mainWindow) {
        void devScreenshots(mainWindow, process.env.MA_SCREENSHOT)
        return
      }
      scheduler.start()
    }
  }
  mainWindow = createWindow(onLoaded)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(onLoaded)
  })
})

process.on('unhandledRejection', (e) => log.error('unhandled_rejection', redactError(e)))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
