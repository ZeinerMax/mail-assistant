import type Anthropic from '@anthropic-ai/sdk'

// Fallback for newsletters with no List-Unsubscribe header: ask a cheap model (Haiku)
// to spot the unsubscribe link in the email body. Quality is not critical here, so the
// smallest model is fine. The body text stays inside this call and is never stored.

const MAX_BODY = 6000

const PROMPT =
  'The text below is a marketing or newsletter email. Find the link a recipient would click to ' +
  'unsubscribe or stop receiving these emails. Reply with ONLY that URL (starting with http), and ' +
  'nothing else. If there is no unsubscribe link, reply with exactly: NONE'

/** Returns an https(s) unsubscribe URL found in the body, or null. */
export function makeUnsubscribeFinder(client: Anthropic, model: string) {
  return async function findUnsubscribeUrl(bodyText: string): Promise<string | null> {
    const text = bodyText.slice(0, MAX_BODY).trim()
    if (!text) return null
    const r = await client.messages.create({
      model,
      max_tokens: 200,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `${PROMPT}\n\n---\n${text}` }]
    })
    const out = r.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
    const url = /\bhttps?:\/\/[^\s<>"')]+/i.exec(out)?.[0] ?? null
    return url
  }
}

export type UnsubscribeFinder = ReturnType<typeof makeUnsubscribeFinder>
