# Send replies from the app — Design

Date: 2026-11-23 · Status: approved by the developer

## Intent

Once the user has read an email in Mail Assistant, they should be able to answer it right there instead of copying a draft into Gmail. This is for everyone who installs the app.

This deliberately reverses the v1 rule "any code path that could send or change email is a failure" (2026-11-17 design, section 2). The developer approved the change on 2026-11-23. Sending replies is the only new write. Deleting, moving, labelling and flag changes stay forbidden.

## Goals, non-goals, anti-goals

**Goals**
- A **Reply** button on an email. It opens an editable text box, pre-filled with the AI draft if one exists.
- The reply goes from the account that received the email. There's no account picker.
- Subject `Re: <original>` (no double `Re:`), `In-Reply-To`/`References` headers, and for Gmail the same `threadId`, so the reply stays in the conversation.
- A confirmation before sending: "Send to X from Y?"
- Works for Google accounts and IMAP (password) accounts.

**Non-goals**
- Writing new emails from scratch (can be added later).
- Syncing drafts with Gmail's Drafts folder (developer declined).
- Saving a copy to the Sent folder for IMAP accounts (left out to keep it simple).
- Attachments, CC/BCC editing, rich text.

**Anti-goals**
- Mail goes out without the user confirming it.
- Any write besides sending a reply (delete, move, label, flags, Gmail drafts API).
- Email bodies or reply text in logs.

## Approaches

| Approach | Trade-off | Decision |
|---|---|---|
| **Gmail API `messages.send` with the `gmail.send` scope; SMTP via nodemailer for IMAP accounts; MIME built with nodemailer's composer for both** | Narrow Gmail permission. Sent mail lands in Gmail's Sent automatically. Correct encoding for non-ASCII text. | **Chosen** |
| Gmail over SMTP with OAuth (XOAUTH2) | One code path for every account, but Google requires the full `mail.google.com` scope (including delete). | Rejected |
| Hand-built MIME | No new dependency, but encoding Czech text and headers is easy to get wrong. | Rejected |
| Sync with Gmail drafts | Drafts follow the user to the phone. Broader scope and more work. Gmail only. | Declined by the developer |

## Decided

- **Scopes:** add `https://www.googleapis.com/auth/gmail.send` to the existing read-only scopes.
- **Existing Google accounts:** their tokens lack `gmail.send`. When sending fails for lack of permission (403 insufficient scope), the app shows "Sign in again to enable sending" for that account, and the existing re-login flow grants the new scope.
- **IMAP accounts:** SMTP host defaults to the IMAP host with a leading `imap.` replaced by `smtp.` and port 465 (TLS), using the same username and password. Host and port can be edited in Accounts.
- **Safety test:** `test/no-write-paths.test.ts` allows exactly the Gmail `messages.send` call and nodemailer SMTP sending, each in one known file. All other write patterns stay forbidden.

## Left to the builder

- Where the Reply box lives in the UI (Mail viewer and/or the Drafts page).
- How sent replies are recorded locally (for example, `sent_at` on the draft or email) so the list can show "Replied".
- Exact nodemailer version and its types. Check the current docs.
- Error messages for SMTP authentication failures and network errors.
- After the build, update the Obsidian notes in `C:\VS\Claude\notes\Mail Assistant` (overview, Google Cloud setup with the new scope, status and next steps), the README, and the 2026-11-17 design doc's read-only wording.
