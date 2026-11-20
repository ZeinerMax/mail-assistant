// Builds latest.json for a release: which file each platform downloads, with SHA-256 and size.
// Usage: node scripts/make-manifest.mjs <dir with release files> <version> "<what's new>"  > latest.json
import { createHash } from 'crypto'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const [dir, version, notes = ''] = process.argv.slice(2)
if (!dir || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: make-manifest.mjs <dir> <X.Y.Z> [notes]')
  process.exit(1)
}

const PATTERNS = {
  'darwin-arm64': new RegExp(`^Mail-Assistant-${version.replace(/\./g, '\\.')}-arm64-mac\\.zip$`),
  'darwin-x64': new RegExp(`^Mail-Assistant-${version.replace(/\./g, '\\.')}-x64-mac\\.zip$`),
  'win32-x64': new RegExp(`^Mail-Assistant-${version.replace(/\./g, '\\.')}-Setup\\.exe$`)
}

const names = readdirSync(dir)
const files = {}
for (const [key, re] of Object.entries(PATTERNS)) {
  const name = names.find((n) => re.test(n))
  if (!name) {
    console.error(`missing release file for ${key}`)
    process.exit(1)
  }
  const p = join(dir, name)
  files[key] = { name, sha256: createHash('sha256').update(readFileSync(p)).digest('hex'), size: statSync(p).size }
}

process.stdout.write(JSON.stringify({ version, notes, files }, null, 2) + '\n')
