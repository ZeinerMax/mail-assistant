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
    rename: (id, label) => inv(CH.accountsRename, id, label),
    addImap: (form) => inv(CH.accountsAddImap, form),
    setImapPassword: (id, password) => inv(CH.accountsImapPassword, id, password),
    setSmtp: (id, s) => inv(CH.accountsSetSmtp, id, s)
  },
  mail: {
    list: (f) => inv(CH.mailList, f),
    message: (id) => inv(CH.mailMessage, id),
    thread: (id) => inv(CH.mailThread, id),
    setFinished: (id, finished) => inv(CH.mailSetFinished, id, finished),
    unsubscribe: (id) => inv(CH.mailUnsubscribe, id)
  },
  drafts: {
    list: () => inv(CH.draftsList),
    markSeen: (id) => inv(CH.draftsMarkSeen, id),
    copy: (id) => inv(CH.draftsCopy, id),
    create: (emailId) => inv(CH.draftsCreate, emailId),
    save: (emailId, body) => inv(CH.draftsSave, emailId, body)
  },
  reply: { preview: (id) => inv(CH.replyPreview, id), send: (id, text) => inv(CH.replySend, id, text) },
  usage: { summary: () => inv(CH.usageSummary) },
  scan: { runNow: (sinceMs) => inv(CH.scanRunNow, sinceMs) },
  calendar: { events: (s, e) => inv(CH.calendarEvents, s, e) },
  update: {
    state: () => inv(CH.updateState),
    check: () => inv(CH.updateCheck),
    install: () => inv(CH.updateInstall)
  },
  onUpdate: on(CH.evUpdate),
  onStatus: on(CH.evStatus),
  onBadge: on(CH.evBadge),
  onDataChanged: on(CH.evDataChanged)
}

contextBridge.exposeInMainWorld('api', api)
