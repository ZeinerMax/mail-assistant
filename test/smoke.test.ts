import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

describe('smoke', () => {
  it('better-sqlite3 loads under the test runtime', () => {
    const db = new Database(':memory:')
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 })
    db.close()
  })
})
