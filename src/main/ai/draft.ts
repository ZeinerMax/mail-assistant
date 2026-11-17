import type Anthropic from '@anthropic-ai/sdk'
import type { gmail_v1 } from '@googleapis/gmail'
import type { Settings } from '@shared/types'
import { cleanBody, extractHeaders } from '../google/clean'
import { DRAFT_SYSTEM, formatEmailForModel, wrapUntrusted } from './prompts'
import { usageOf, type TokenUsage } from './triage'

export class DraftFailed extends Error {
  constructor(
    public reason: 'refusal' | 'empty',
    public usage?: TokenUsage
  ) {
    super(`draft failed: ${reason}`)
    this.name = 'DraftFailed'
  }
}

/**
 * Thread context for the draft, oldest → newest, ending with the TARGET message.
 * Each message is cleaned (quotes/attachments stripped) and wrapped in its own nonce tag.
 * Earlier messages are added newest-first until maxChars is used up. Lives in memory only.
 */
export function buildDraftContext(
  thread: gmail_v1.Schema$Thread,
  targetId: string,
  maxChars: number,
  ownerEmail?: string
): string {
  const msgs = thread.messages ?? []
  const idx = msgs.findIndex((m) => m.id === targetId)
  if (idx < 0) throw new Error('target message not in thread')

  const render = (m: gmail_v1.Schema$Message, budget: number): { text: string; len: number } => {
    const h = extractHeaders(m)
    const body = cleanBody(m, Math.max(200, budget))
    const isOwner = !!ownerEmail && h.fromEmail.toLowerCase() === ownerEmail.toLowerCase()
    const text = formatEmailForModel({ ...h, fromName: h.fromName + (isOwner ? ' (the account owner)' : ''), date: h.receivedAt, body })
    return { text, len: text.length }
  }

  const target = render(msgs[idx], maxChars)
  let remaining = maxChars - target.len
  const earlier: string[] = []
  for (let i = idx - 1; i >= 0 && remaining > 200; i--) {
    const r = render(msgs[i], remaining)
    if (r.len > remaining) break
    earlier.unshift(r.text)
    remaining -= r.len
  }

  const parts = earlier.map((t, i) => `Earlier message ${i + 1}:\n${wrapUntrusted('email', t)}`)
  parts.push(`TARGET — reply to this message:\n${wrapUntrusted('email', target.text)}`)
  return parts.join('\n\n')
}

/**
 * Sonnet draft. Parameters per current Anthropic docs for Claude Sonnet 5.5:
 * thinking {type:"adaptive"} + output_config.effort (budget_tokens / disabled are rejected on this model);
 * server-side refusal fallback via beta "server-side-fallback-2026-07-01" with fallbacks: "default".
 * No tools.
 */
export async function draftReply(
  client: Anthropic,
  ctx: string,
  settings: Settings
): Promise<{ body: string; usage: TokenUsage }> {
  const res = await client.beta.messages.create({
    model: settings.draftModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.draftEffort },
    system: DRAFT_SYSTEM,
    messages: [{ role: 'user', content: `Write a reply draft for the TARGET message.\n\n${ctx}` }]
  })
  const usage = usageOf(res)
  if (res.stop_reason === 'refusal') throw new DraftFailed('refusal', usage)
  const body = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!body) throw new DraftFailed('empty', usage)
  return { body, usage }
}
