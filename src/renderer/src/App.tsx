import { useEffect, useState } from 'react'
import StatusBar from './components/StatusBar'
import UpdateBanner from './components/UpdateBanner'
import MailPage from './pages/Mail'
import DraftsPage from './pages/Drafts'
import CalendarPage from './pages/Calendar'
import AccountsPage from './pages/Accounts'
import SettingsPage from './pages/Settings'

export type Page = 'mail' | 'drafts' | 'calendar' | 'accounts' | 'settings'

const NAV: { id: Page; label: string }[] = [
  { id: 'mail', label: 'Mail' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'settings', label: 'Settings' }
]

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('mail')
  const [badge, setBadge] = useState(0)
  useEffect(() => window.api.onBadge(setBadge), [])

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">Mail Assistant</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${page === n.id ? 'active' : ''}`}
            onClick={() => setPage(n.id)}
            aria-current={page === n.id ? 'page' : undefined}
          >
            {n.label}
            {n.id === 'drafts' && badge > 0 && <span className="badge">{badge}</span>}
          </button>
        ))}
      </nav>
      <main className="main">
        <UpdateBanner />
        {page === 'mail' && <MailPage goTo={setPage} />}
        {page === 'drafts' && <DraftsPage />}
        {page === 'calendar' && <CalendarPage />}
        {page === 'accounts' && <AccountsPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      <StatusBar />
    </div>
  )
}
