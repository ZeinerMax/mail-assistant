import type { calendar_v3 } from '@googleapis/calendar'
import type { Account } from '@shared/types'
import type { CalEvent, CalResult } from '@shared/ipc'
import { ReloginRequired } from './accounts'
import { log, redactError } from '../log'

// READ-ONLY. Params verified against @googleapis/calendar 20 v3.d.ts:
//   calendarList.list { pageToken } ; events.list { calendarId, timeMin, timeMax, singleEvents, orderBy, pageToken }
// No AI, no reminders. Events are kept in memory only.

type Resp<T> = Promise<{ data: T }>
type P = Record<string, unknown>

export interface CalendarLike {
  calendarList: { list(p: P): Resp<{ items?: calendar_v3.Schema$CalendarListEntry[] | null; nextPageToken?: string | null }> }
  events: { list(p: P): Resp<{ items?: calendar_v3.Schema$Event[] | null; nextPageToken?: string | null }> }
}

const MAX_PAGES = 10

async function listCalendars(c: CalendarLike): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data } = await c.calendarList.list(pageToken ? { pageToken } : {})
    for (const cal of data.items ?? []) if (cal.id && cal.selected !== false && !cal.deleted && !cal.hidden) ids.push(cal.id)
    pageToken = data.nextPageToken ?? undefined
    if (!pageToken) break
  }
  return ids
}

function toEvent(acc: Account, calendarId: string, e: calendar_v3.Schema$Event): CalEvent | null {
  if (e.status === 'cancelled' || !e.id) return null
  const allDay = !!e.start?.date
  const start = e.start?.dateTime ?? e.start?.date
  const end = e.end?.dateTime ?? e.end?.date ?? start
  if (!start || !end) return null
  return {
    id: `${acc.id}:${calendarId}:${e.id}`,
    accountId: acc.id,
    color: acc.color,
    title: e.summary?.trim() || '(busy)',
    start,
    end,
    allDay,
    ...(e.location ? { location: e.location } : {})
  }
}

export async function fetchEvents(
  deps: { accounts: Account[]; getCalendar: (accountId: number) => Promise<CalendarLike> },
  startIso: string,
  endIso: string
): Promise<CalResult> {
  const events: CalEvent[] = []
  const skipped: CalResult['skipped'] = []
  for (const acc of deps.accounts) {
    if (acc.status === 'needs_relogin') {
      skipped.push({ accountId: acc.id, label: acc.label, reason: 'needs_relogin' })
      continue
    }
    try {
      const c = await deps.getCalendar(acc.id)
      for (const calendarId of await listCalendars(c)) {
        let pageToken: string | undefined
        for (let i = 0; i < MAX_PAGES; i++) {
          const { data } = await c.events.list({
            calendarId,
            timeMin: startIso,
            timeMax: endIso,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250,
            ...(pageToken ? { pageToken } : {})
          })
          for (const e of data.items ?? []) {
            const ev = toEvent(acc, calendarId, e)
            if (ev) events.push(ev)
          }
          pageToken = data.nextPageToken ?? undefined
          if (!pageToken) break
        }
      }
    } catch (e) {
      if (e instanceof ReloginRequired) {
        skipped.push({ accountId: acc.id, label: acc.label, reason: 'needs_relogin' })
      } else {
        log.warn('calendar_failed', { account: acc.id, ...redactError(e) })
        skipped.push({ accountId: acc.id, label: acc.label, reason: 'error' })
      }
    }
  }
  return { events, skipped }
}
