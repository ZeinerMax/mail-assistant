// Pure logic here; the Electron bindings (Notification, app.setBadgeCount) are passed in from index.ts.
// VERIFIED in electron.d.ts (Electron 45): Notification.isSupported(), app.setBadgeCount(count).
// TO VERIFY on a real Mac: notifications and the dock badge for an unsigned (ad-hoc signed) app.

export function draftsText(n: number): string {
  return n === 1 ? '1 new draft ready' : `${n} new drafts ready`
}

export function notifyDraftsReady(
  count: number,
  deps: { show: (title: string, body: string) => void; setBadge: (n: number) => void; unseen: () => number }
): void {
  if (count > 0) deps.show('Mail Assistant', draftsText(count))
  deps.setBadge(deps.unseen())
}
