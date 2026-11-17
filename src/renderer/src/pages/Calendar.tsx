import { useEffect, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import type { EventSourceFunc } from '@fullcalendar/core'
import type { Account } from '@shared/types'
import type { CalResult } from '@shared/ipc'

// Combined read-only calendar for all accounts. No AI, no reminders.
export default function CalendarPage(): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [skipped, setSkipped] = useState<CalResult['skipped']>([])

  useEffect(() => {
    void window.api.accounts.list().then(setAccounts)
  }, [])

  const source: EventSourceFunc = (info, success, failure) => {
    window.api.calendar
      .events(info.start.toISOString(), info.end.toISOString())
      .then((r) => {
        setSkipped(r.skipped)
        success(
          r.events.map((e) => ({
            id: e.id,
            title: e.location ? `${e.title} · ${e.location}` : e.title,
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            backgroundColor: e.color,
            borderColor: e.color
          }))
        )
      })
      .catch((err: Error) => failure(err))
  }

  return (
    <>
      <div className="page-head">
        <h1>Calendar</h1>
      </div>
      {skipped.map((s) => (
        <div key={s.accountId} className="msg err">
          {s.reason === 'needs_relogin'
            ? `${s.label} needs you to sign in again (Accounts page).`
            : `Could not load the calendar for ${s.label}.`}
        </div>
      ))}
      {accounts.length > 0 && (
        <div className="legend" style={{ marginTop: 10 }}>
          {accounts.map((a) => (
            <span key={a.id}>
              <span className="acct-dot" style={{ background: a.color }} />
              {a.label}
            </span>
          ))}
        </div>
      )}
      <div className="cal-wrap">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'timeGridWeek,dayGridMonth' }}
          buttonText={{ today: 'Today', week: 'Week', month: 'Month' }}
          firstDay={1}
          nowIndicator
          height="auto"
          slotMinTime="06:00:00"
          slotMaxTime="23:00:00"
          eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          events={source}
        />
      </div>
    </>
  )
}
