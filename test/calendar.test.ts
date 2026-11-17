import { describe, it, expect } from 'vitest'
import { fetchEvents, type CalendarLike } from '../src/main/google/calendar'
import { ReloginRequired } from '../src/main/google/accounts'
import type { Account } from '@shared/types'
import type { calendar_v3 } from '@googleapis/calendar'

const acc = (id: number, color: string, status: Account['status'] = 'ok'): Account => ({
  id, email: `a${id}@gmail.com`, label: `A${id}`, color, status, lastHistoryId: null, lastCheckedAt: null, createdAt: 0
})

function cal(events: Record<string, unknown[][]>, calendars = [{ id: 'primary' }]): CalendarLike & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  const pageIdx: Record<string, number> = {}
  return {
    calls,
    calendarList: { list: async () => ({ data: { items: calendars } }) },
    events: {
      list: async (p) => {
        calls.push(p)
        const id = p.calendarId as string
        const i = (pageIdx[id] = (pageIdx[id] ?? -1) + 1)
        const pages = events[id] ?? [[]]
        return {
          data: {
            items: (pages[i] ?? []) as calendar_v3.Schema$Event[],
            nextPageToken: i + 1 < pages.length ? `p${i + 1}` : undefined
          }
        }
      }
    }
  }
}

const S = '2026-11-16T00:00:00.000Z'
const E = '2026-11-23T00:00:00.000Z'

describe('fetchEvents', () => {
  it('merges events from 2 accounts with account colors', async () => {
    const c1 = cal({ primary: [[{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-17T09:00:00+01:00' }, end: { dateTime: '2026-11-17T10:00:00+01:00' } }]] })
    const c2 = cal({ primary: [[{ id: 'e2', summary: 'Football', start: { dateTime: '2026-11-18T17:00:00+01:00' }, end: { dateTime: '2026-11-18T18:00:00+01:00' }, location: 'Park' }]] })
    const r = await fetchEvents({ accounts: [acc(1, '#111'), acc(2, '#222')], getCalendar: async (id) => (id === 1 ? c1 : c2) }, S, E)
    expect(r.events).toEqual([
      { id: '1:primary:e1', accountId: 1, color: '#111', title: 'Dentist', start: '2026-11-17T09:00:00+01:00', end: '2026-11-17T10:00:00+01:00', allDay: false },
      { id: '2:primary:e2', accountId: 2, color: '#222', title: 'Football', start: '2026-11-18T17:00:00+01:00', end: '2026-11-18T18:00:00+01:00', allDay: false, location: 'Park' }
    ])
    expect(c1.calls[0]).toMatchObject({ calendarId: 'primary', timeMin: S, timeMax: E, singleEvents: true, orderBy: 'startTime' })
  })

  it('all-day event uses date fields and allDay true', async () => {
    const c = cal({ primary: [[{ id: 'e', summary: 'Holiday', start: { date: '2026-11-17' }, end: { date: '2026-11-18' } }]] })
    const r = await fetchEvents({ accounts: [acc(1, '#1')], getCalendar: async () => c }, S, E)
    expect(r.events[0]).toMatchObject({ allDay: true, start: '2026-11-17', end: '2026-11-18' })
  })

  it('needs_relogin account is skipped and reported, others still returned', async () => {
    const c = cal({ primary: [[{ id: 'e', summary: 'X', start: { date: '2026-11-17' }, end: { date: '2026-11-18' } }]] })
    const r = await fetchEvents(
      {
        accounts: [acc(1, '#1', 'needs_relogin'), acc(2, '#2'), acc(3, '#3')],
        getCalendar: async (id) => {
          if (id === 3) throw new ReloginRequired(3)
          return c
        }
      },
      S,
      E
    )
    expect(r.events).toHaveLength(1)
    expect(r.skipped).toEqual([
      { accountId: 1, label: 'A1', reason: 'needs_relogin' },
      { accountId: 3, label: 'A3', reason: 'needs_relogin' }
    ])
  })

  it('follows pageToken', async () => {
    const ev = (id: string) => ({ id, summary: id, start: { date: '2026-11-17' }, end: { date: '2026-11-18' } })
    const c = cal({ primary: [[ev('a')], [ev('b')]] })
    const r = await fetchEvents({ accounts: [acc(1, '#1')], getCalendar: async () => c }, S, E)
    expect(r.events.map((e) => e.title)).toEqual(['a', 'b'])
    expect(c.calls[1].pageToken).toBe('p1')
  })

  it('cancelled events excluded, untitled get "(busy)", hidden calendars skipped', async () => {
    const c = cal(
      {
        primary: [[
          { id: 'x', status: 'cancelled', start: { date: '2026-11-17' }, end: { date: '2026-11-18' } },
          { id: 'y', start: { date: '2026-11-17' }, end: { date: '2026-11-18' } }
        ]],
        hidden: [[{ id: 'z', summary: 'nope', start: { date: '2026-11-17' }, end: { date: '2026-11-18' } }]]
      },
      [{ id: 'primary' }, { id: 'hidden', selected: false } as { id: string }]
    )
    const r = await fetchEvents({ accounts: [acc(1, '#1')], getCalendar: async () => c }, S, E)
    expect(r.events.map((e) => e.title)).toEqual(['(busy)'])
  })

  it('other errors mark account as error', async () => {
    const r = await fetchEvents(
      { accounts: [acc(1, '#1')], getCalendar: async () => { throw new Error('500') } },
      S,
      E
    )
    expect(r.skipped).toEqual([{ accountId: 1, label: 'A1', reason: 'error' }])
  })
})
