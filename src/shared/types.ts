// Types shared by main, preload and renderer. No runtime code here.

export type Tag = 'needs_reply' | 'info' | 'newsletter_junk'

export interface ModelPrice {
  /** USD per million input tokens */
  in: number
  /** USD per million output tokens */
  out: number
}

export interface Settings {
  triageModel: string
  draftModel: string
  draftEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  checkIntervalMin: number
  maxEmailsPerRun: number
  maxDraftsPerRun: number
  maxTokensPerRun: number
  triageBodyChars: number
  draftContextChars: number
  prefilterPromotions: boolean
  prices: Record<string, ModelPrice>
}

export type AccountStatus = 'ok' | 'needs_relogin' | 'error'

export interface Account {
  id: number
  email: string
  label: string
  color: string
  status: AccountStatus
  lastHistoryId: string | null
  lastCheckedAt: number | null
  createdAt: number
}

export interface NewEmail {
  accountId: number
  gmailMessageId: string
  gmailThreadId: string
  receivedAt: number
  fromName: string
  fromEmail: string
  subject: string
}

export type EmailState = 'pending' | 'triaged' | 'failed' | 'skipped'

export interface EmailRow extends NewEmail {
  id: number
  tag: Tag | null
  summary: string | null
  state: EmailState
  attempts: number
}

export interface DraftRow {
  id: number
  emailId: number
  body: string
  createdAt: number
  seenAt: number | null
  copiedAt: number | null
}

export interface UsageRow {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export type StatusPhase = 'idle' | 'listing' | 'summarizing' | 'drafting' | 'error' | 'offline'

export interface StatusEvent {
  phase: StatusPhase
  accountLabel?: string
  index?: number
  total?: number
  etaSec?: number
  message?: string
  lastRunAt?: number
  nextRunAt?: number
}
