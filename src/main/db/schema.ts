import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

// Stored on purpose: ids, sender name/address, subject, date, summary, tag, drafts, bookkeeping.
// NEVER stored: email bodies, quoted text, attachments, thread text (enforced by test/repo.test.ts).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_relogin','error')),
    last_history_id TEXT,
    last_checked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE emails (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL,
    gmail_thread_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    tag TEXT CHECK (tag IN ('needs_reply','info','newsletter_junk')),
    summary TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','triaged','failed','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, gmail_message_id)
  );
  CREATE INDEX emails_by_time ON emails(received_at DESC);
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    email_id INTEGER NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER,
    copied_at INTEGER
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT,
    emails_seen INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT
  );
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY,
    run_id INTEGER,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'gmail' CHECK (kind IN ('gmail','imap'));
  ALTER TABLE accounts ADD COLUMN imap_host TEXT;
  ALTER TABLE accounts ADD COLUMN imap_port INTEGER;
  ALTER TABLE accounts ADD COLUMN imap_user TEXT;
  ALTER TABLE emails ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE emails ADD COLUMN thread_size INTEGER;
  `
]

export type Db = Database.Database

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}
