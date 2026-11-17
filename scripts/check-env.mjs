// Fails the installer build early if the Google OAuth client is missing.
// electron-vite reads MAIN_VITE_* from the environment or from .env (see README).
import { existsSync, readFileSync } from 'fs'

const NAMES = ['MAIN_VITE_GOOGLE_CLIENT_ID', 'MAIN_VITE_GOOGLE_CLIENT_SECRET']

const fromFile = {}
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const missing = NAMES.filter((n) => !(process.env[n] || fromFile[n]))
if (missing.length) {
  console.error(
    `Missing ${missing.join(' and ')}.\n` +
      'Set them in .env (local) or as GitHub repository secrets GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (CI). See README.'
  )
  process.exit(1)
}
console.log('Google client credentials found.')
