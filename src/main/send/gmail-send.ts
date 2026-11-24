export interface GmailSendLike {
  users: { messages: { send(p: Record<string, unknown>): Promise<{ data: { id?: string | null } }> } }
}

/** threadId threads a reply into its conversation; omit it for a standalone message. */
export async function sendViaGmail(g: GmailSendLike, raw: Buffer, threadId?: string): Promise<void> {
  const requestBody: Record<string, unknown> = { raw: raw.toString('base64url') }
  if (threadId) requestBody.threadId = threadId
  await g.users.messages.send({ userId: 'me', requestBody })
}
