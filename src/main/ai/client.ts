import Anthropic from '@anthropic-ai/sdk'

// SDK options verified in @anthropic-ai/sdk 1.9 client.d.ts: apiKey, maxRetries, timeout (ms).
// maxRetries: 1 — the spec forbids retry loops; at most one SDK retry per request.
/**
 * Anthropic keys contain only letters, digits, '-' and '_'. A key copied from a terminal or web page can carry
 * invisible extras (e.g. a "❯ " prompt, a non-breaking space, a line break); those make every request fail with
 * a TypeError while building the HTTP header. Drop anything that can't be part of a key.
 */
export function cleanApiKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '')
}

export function createAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey: cleanApiKey(apiKey), maxRetries: 1, timeout: 120_000 })
}

/** One tiny request to check the key works. Sends no user data. */
export async function testApiKey(client: Anthropic, model: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.messages.create({
      model,
      max_tokens: 16,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with OK.' }]
    })
    return { ok: true }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Invalid API key' }
    if (e instanceof Anthropic.NotFoundError) return { ok: false, error: `Model "${model}" not found` }
    return { ok: false, error: 'Could not reach Anthropic' }
  }
}
