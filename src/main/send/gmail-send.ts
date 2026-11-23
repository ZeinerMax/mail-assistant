export interface GmailSendLike {
  users: { messages: { send(p: Record<string, unknown>): Promise<{ data: { id?: string | null } }> } }
}

export async function sendViaGmail(g: GmailSendLike, raw: Buffer, threadId: string): Promise<void> {
  await g.users.messages.send({ userId: 'me', requestBody: { raw: raw.toString('base64url'), threadId } })
}
