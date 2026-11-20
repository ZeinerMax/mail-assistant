import type { gmail_v1 } from '@googleapis/gmail'
import { extractHeaders } from '../google/clean'

/**
 * True when the owner already replied to the target message:
 * - the target carries the IMAP \Answered flag (label ANSWERED), or
 * - a later message in the conversation was sent by the owner (label SENT, or From = one of the owner's addresses).
 */
export function isAnswered(thread: gmail_v1.Schema$Thread, targetId: string, ownerEmail?: string | string[]): boolean {
  const msgs = thread.messages ?? []
  const idx = msgs.findIndex((m) => m.id === targetId)
  if (idx < 0) return false
  if (msgs[idx].labelIds?.includes('ANSWERED')) return true
  const owners = new Set((Array.isArray(ownerEmail) ? ownerEmail : ownerEmail ? [ownerEmail] : []).map((o) => o.toLowerCase()))
  const targetAt = Number(msgs[idx].internalDate) || 0
  return msgs.some(
    (m, i) =>
      i !== idx &&
      (i > idx || (Number(m.internalDate) || 0) > targetAt) &&
      ((m.labelIds ?? []).includes('SENT') || owners.has(extractHeaders(m).fromEmail.toLowerCase()))
  )
}

/** Makes sure the target message is part of the thread (a server search can miss it). */
export function withTarget(thread: gmail_v1.Schema$Thread, target: gmail_v1.Schema$Message): gmail_v1.Schema$Thread {
  const msgs = thread.messages ?? []
  if (msgs.some((m) => m.id === target.id)) return thread
  const all = [...msgs, target].sort((a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0))
  return { ...thread, messages: all }
}
