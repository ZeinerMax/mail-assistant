import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH, type Api } from '../shared/ipc'

// Narrow bridge: the renderer can only call these named channels. No keys or tokens ever flow here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- return types are enforced by the Api interface below
const inv = (ch: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(ch, ...args)
const on =
  <T>(ch: string) =>
  (cb: (v: T) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, v: T): void => cb(v)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.removeListener(ch, h)
  }

const api: Api = {
  settings: { get: () => inv(CH.settingsGet), save: (p) => inv(CH.settingsSave, p) },
  apiKey: {
    set: (k) => inv(CH.apiKeySet, k),
    status: () => inv(CH.apiKeyStatus),
    test: () => inv(CH.apiKeyTest)
  },
  accounts: {
    list: () => inv(CH.accountsList),
    add: () => inv(CH.accountsAdd),
    relogin: (id) => inv(CH.accountsRelogin, id),
    remove: (id) => inv(CH.accountsRemove, id),
    rename: (id, label) => inv(CH.accountsRename, id, label)
  },
  mail: { list: (f) => inv(CH.mailList, f) },
  drafts: {
    list: () => inv(CH.draftsList),
    markSeen: (id) => inv(CH.draftsMarkSeen, id),
    copy: (id) => inv(CH.draftsCopy, id),
    create: (emailId) => inv(CH.draftsCreate, emailId)
  },
  usage: { summary: () => inv(CH.usageSummary) },
  scan: { runNow: (sinceMs) => inv(CH.scanRunNow, sinceMs) },
  calendar: { events: (s, e) => inv(CH.calendarEvents, s, e) },
  onStatus: on(CH.evStatus),
  onBadge: on(CH.evBadge),
  onDataChanged: on(CH.evDataChanged)
}

contextBridge.exposeInMainWorld('api', api)
