# Mail

AI-native Gmail. Your mailbox becomes a local, fully searchable mirror that
you and the AI work together — with one hard rule: **the AI proposes, you
decide.**

Four things make it different:

1. **Proposal-state editing.** The AI never overwrites a draft. It emits
   paragraph-bounded, individually reviewable hunks — accept ⏎, reject ⌫
   (with a comment if you like), or send it back with feedback. "Work on
   paragraph 3" is enforced by validation, not by asking the model nicely.
2. **A hard human send gate.** Approve and Send are UI-only actions; they do
   not exist in the AI toolset or over MCP, and the Mim runtime refuses them
   for AI callers at dispatch. Approval binds to the exact body, recipients,
   and subject you reviewed — any later change revokes it.
3. **Legible voices.** 2–3 writing personas seeded from your real sent mail
   (language- and register-clustered), stored as markdown documents you can
   read and edit, attached per draft. The AI never silently updates a voice.
4. **A provenance flywheel.** Every draft keeps its full history — first AI
   text, every accepted/rejected hunk, your comments verbatim, what you
   actually sent. Every 5 sends, the flywheel distills lessons into proposed
   voice-document edits, reviewed with the same hunk mechanic. Health
   metrics: **first-draft survival** and **untouched rate**, shown as trends
   once ≥10 sends are scored.

## Setup

Mail connects with your own Google OAuth client (one-time, ~5 minutes; the
in-app onboarding walks through it):

1. Google Cloud Console → create/select a project → enable the **Gmail API**.
2. OAuth consent screen: **Internal** if your domain is Google Workspace
   (recommended — no verification, no token expiry); otherwise External. In
   External **Testing** mode, refresh tokens expire after 7 days.
3. Credentials → Create OAuth client → **Desktop app** → download the JSON.
4. Paste the JSON into Mail's onboarding, connect, and pick a sync window.

Requested scope: `gmail.modify` only. Mail syncs to one local SQLite file
(`~/.mim/private/mail/mail.sqlite`); tokens live in the OS keychain. Nothing
touches a third-party server.

## Tools

Chat + MCP (the agent can research, label, and propose — never send):
`mail.search`, `mail.thread`, `mail.message`, `mail.labels`, `mail.label`,
`mail.sync`, `mail.drafts`, `mail.draft.get`, `mail.draft.create`,
`mail.draft.propose`, `mail.voices`.

Review, approval, and sending are UI-only by construction.

## Limitations (v1)

Plain-text compose (HTML mail is mirrored as extracted text). Attachment
metadata only. One account. Sync runs while Mim is open (on view, on a 75 s
heartbeat, and before stale reads). Local drafts are not mirrored to Gmail's
drafts folder.

## Development

Backend modules and UI are plain ESM with co-located vitest tests:
`npx vitest run packages/mail` from the repo root. Design/engineering
contracts live in `docs/plan.md`, `docs/CONTRACTS.md`, and `docs/UX-SPEC.md`.
