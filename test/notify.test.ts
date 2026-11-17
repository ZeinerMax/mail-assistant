import { describe, it, expect } from 'vitest'
import { notifyDraftsReady, draftsText } from '../src/main/notify'

function deps(unseen: number) {
  const shown: [string, string][] = []
  const badges: number[] = []
  return {
    shown,
    badges,
    d: { show: (t: string, b: string) => void shown.push([t, b]), setBadge: (n: number) => void badges.push(n), unseen: () => unseen }
  }
}

describe('notifyDraftsReady', () => {
  it('one notification per run with N drafts', () => {
    const { shown, d } = deps(3)
    notifyDraftsReady(3, d)
    expect(shown).toEqual([['Mail Assistant', '3 new drafts ready']])
  })

  it('singular text', () => {
    expect(draftsText(1)).toBe('1 new draft ready')
  })

  it('no notification when 0', () => {
    const { shown, d } = deps(0)
    notifyDraftsReady(0, d)
    expect(shown).toEqual([])
  })

  it('badge equals unseen count', () => {
    const { badges, d } = deps(5)
    notifyDraftsReady(2, d)
    expect(badges).toEqual([5])
  })
})
