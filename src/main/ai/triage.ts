import type Anthropic from '@anthropic-ai/sdk'
import type { Settings, Tag } from '@shared/types'
import { TRIAGE_SCHEMA, TRIAGE_SYSTEM, formatEmailForModel, wrapUntrusted } from './prompts'

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

export class TriageFailed extends Error {
  constructor(
    public reason: 'refusal' | 'bad_output',
    public usage?: TokenUsage
  ) {
    super(`triage failed: ${reason}`)
    this.name = 'TriageFailed'
  }
}

const TAGS: Tag[] = ['needs_reply', 'info', 'newsletter_junk']

export function usageOf(r: { usage?: { input_tokens?: number | null; output_tokens?: number | null } }): TokenUsage {
  return { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 }
}

/**
 * One Haiku call per email. No tools. Output constrained by JSON schema
 * (output_config.format — structured outputs are supported on Claude Haiku 5.5 per Anthropic docs).
 */
export async function triage(
  client: Anthropic,
  input: { fromName: string; fromEmail: string; subject: string; body: string; date?: number },
  settings: Settings
): Promise<{ summary: string; tag: Tag; usage: TokenUsage }> {
  const res = await client.messages.create({
    model: settings.triageModel,
    max_tokens: 1024,
    system: TRIAGE_SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: TRIAGE_SCHEMA as unknown as Record<string, unknown> }
    },
    messages: [
      {
        role: 'user',
        content: `Summarize and tag this email.\n\n${wrapUntrusted('email', formatEmailForModel(input))}`
      }
    ]
  })
  const usage = usageOf(res)
  if (res.stop_reason === 'refusal') throw new TriageFailed('refusal', usage)
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  try {
    const parsed = JSON.parse(text) as { summary?: unknown; tag?: unknown }
    if (typeof parsed.summary !== 'string' || !TAGS.includes(parsed.tag as Tag)) throw new Error('shape')
    return { summary: parsed.summary.trim().slice(0, 600), tag: parsed.tag as Tag, usage }
  } catch {
    throw new TriageFailed('bad_output', usage)
  }
}
