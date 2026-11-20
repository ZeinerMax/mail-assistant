import { join } from 'path'
import type { UpdateState } from '@shared/ipc'
import { log, redactError } from '../log'
import { downloadVerified, fetchFollowingAllowed, type FetchLike } from './download'
import { MANIFEST_URL, fileUrl, isNewer, parseManifest, platformKey, type UpdateFile } from './manifest'

export const UPDATE_CHECK_FIRST_MS = 10_000
export const UPDATE_CHECK_EVERY_MS = 6 * 3600_000
const BUSY_POLL_MS = 2_000

const CHECK_FAILED = 'Could not check for updates. Check your internet connection.'
const DOWNLOAD_FAILED = 'The update could not be downloaded. Try again or download it manually.'

export interface UpdaterDeps {
  currentVersion: string
  platform: string
  arch: string
  /** Folder for downloads, e.g. <userData>/updates */
  workRoot: string
  fetch: FetchLike
  /** True while a mail check runs; the update waits for it. */
  isBusy: () => boolean
  /** Stops the scheduler before installing. May return an undo used if the install fails. */
  beforeInstall: () => void | (() => void)
  /** Platform installer: prepares the swap / starts the setup. Throws a user-facing message on refusal. */
  install: (file: string, version: string) => Promise<void>
  quit: () => void
  emit: (s: UpdateState) => void
  sleep: (ms: number) => Promise<void>
}

export function createUpdater(deps: UpdaterDeps) {
  let state: UpdateState = { phase: 'idle' }
  let offer: { version: string; file: UpdateFile } | null = null
  let inFlight: Promise<void> | null = null
  const key = platformKey(deps.platform, deps.arch)

  const set = (s: UpdateState): UpdateState => {
    state = s
    deps.emit(s)
    return s
  }
  const busyUpdating = (): boolean => ['waiting', 'downloading', 'installing'].includes(state.phase)

  async function check(manual: boolean): Promise<UpdateState> {
    if (busyUpdating()) return state
    if (manual) set({ phase: 'checking' })
    try {
      const res = await fetchFollowingAllowed(deps.fetch, MANIFEST_URL)
      if (res.status === 404) {
        offer = null
        return set(manual ? { phase: 'uptodate', checkedAt: Date.now() } : { phase: 'idle' })
      }
      if (!res.ok) throw new Error(`manifest ${res.status}`)
      const m = parseManifest(await res.json())
      const file = key ? m.files[key] : undefined
      if (!isNewer(m.version, deps.currentVersion) || !file) {
        offer = null
        return set(manual ? { phase: 'uptodate', checkedAt: Date.now() } : { phase: 'idle' })
      }
      offer = { version: m.version, file }
      log.info('update_available', { version: m.version })
      return set({ phase: 'available', version: m.version, notes: m.notes })
    } catch (e) {
      log.warn('update_check_failed', redactError(e))
      return set(manual ? { phase: 'error', message: CHECK_FAILED } : state.phase === 'available' ? state : { phase: 'idle' })
    }
  }

  async function run(): Promise<void> {
    if (!offer) await check(true)
    if (!offer) return
    const { version, file } = offer
    while (deps.isBusy()) {
      set({ phase: 'waiting', version })
      await deps.sleep(BUSY_POLL_MS)
    }
    const dest = join(deps.workRoot, version, file.name)
    set({ phase: 'downloading', version, percent: 0 })
    try {
      await downloadVerified(deps.fetch, fileUrl(version, file.name), dest, file, (percent) =>
        set({ phase: 'downloading', version, percent })
      )
    } catch (e) {
      log.warn('update_download_failed', redactError(e))
      set({ phase: 'error', version, message: DOWNLOAD_FAILED })
      return
    }
    set({ phase: 'installing', version })
    const undo = deps.beforeInstall()
    try {
      await deps.install(dest, version)
    } catch (e) {
      log.warn('update_install_failed', redactError(e))
      if (typeof undo === 'function') undo()
      set({ phase: 'error', version, message: e instanceof Error && e.message ? e.message : DOWNLOAD_FAILED })
      return
    }
    log.info('update_installing', { version, size: file.size })
    deps.quit()
  }

  return {
    check,
    /** "Update and restart". Concurrent calls share one run. */
    update(): Promise<void> {
      if (!inFlight) inFlight = run().finally(() => (inFlight = null))
      return inFlight
    },
    state: (): UpdateState => state
  }
}

export type Updater = ReturnType<typeof createUpdater>
