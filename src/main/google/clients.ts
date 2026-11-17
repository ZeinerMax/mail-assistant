import { OAuth2Client } from 'google-auth-library'
import { gmail, type gmail_v1 } from '@googleapis/gmail'
import { calendar, type calendar_v3 } from '@googleapis/calendar'
import { getClientCredentials } from './oauth'

// VERIFIED against @googleapis/gmail 22 / @googleapis/calendar 20 index.d.ts:
// gmail({ version: 'v1', auth }), calendar({ version: 'v3', auth }).
export function makeAuth(refreshToken: string): OAuth2Client {
  const { clientId, clientSecret } = getClientCredentials()
  const auth = new OAuth2Client({ clientId, clientSecret })
  auth.setCredentials({ refresh_token: refreshToken })
  return auth
}

export function gmailFor(auth: OAuth2Client): gmail_v1.Gmail {
  return gmail({ version: 'v1', auth })
}

export function calendarFor(auth: OAuth2Client): calendar_v3.Calendar {
  return calendar({ version: 'v3', auth })
}

export async function getProfile(refreshToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await gmailFor(makeAuth(refreshToken)).users.getProfile({ userId: 'me' })
  if (!res.data.emailAddress || !res.data.historyId) throw new Error('Could not read the Gmail profile')
  return { emailAddress: res.data.emailAddress, historyId: res.data.historyId }
}
