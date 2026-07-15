# Mail — Implementation Plan (v2, post-review)

Status: reviewed by two independent agents (adversarial-technical, product/UX);
all BLOCKER/MAJOR findings incorporated. Frozen implementation contracts live
in [CONTRACTS.md](CONTRACTS.md) — that file wins on any conflict.

Repo: `mim-apps/packages/mail/`. One deliberate mim-os change (§8, gate
enforcement); everything else is app-local.

## 1. Product core

Email is the highest-volume work channel and the most AI-blind surface in an
AI-native org. Mail closes that gap around one loop:

> AI drafts → human reviews granular proposals → human gates every send →
> the delta between proposed and sent becomes the lesson → voices improve →
> survival rate climbs → delegation grows.

**The draft is the atom.** Every draft carries its full revision history with
authorship on every change (AI-proposed, human-accepted, human-typed,
human-rejected-with-comment). Everything else feeds or reads that object.

The four essentials:

1. **Proposal-state editing.** The AI never mutates a non-empty draft. It
   emits proposals — validated, paragraph-bounded hunks against a specific
   revision — reviewed one at a time or accepted en masse: accept, reject, or
   comment. Scope and granularity are enforced by validation, not the prompt.
   A full-body rewrite is structurally impossible as a single hunk.
2. **Human gate.** Accept/approve/send are `audience: ['ui']` tools with no
   named grant, and the runtime (with the §8 core fix) refuses to execute
   non-chat-audience tools for the `ai` actor. Defense-in-depth on top:
   `send` requires `state='approved'`, `approve` is itself ui-only, and
   approval expires if the draft changes.
3. **Voices.** 2–3 named personas as legible markdown documents, seeded from
   the user's real sent mail (language- and register-clustered, noise
   filtered), attached per draft, switchable. The AI never silently updates a
   voice: flywheel learnings arrive as proposals against the voice document,
   reviewed with the same hunk mechanic.
4. **Provenance flywheel.** Append-only ledger per draft: first AI text,
   every proposal, every rejection + comment verbatim, every human edit,
   take-overs, final sent text. Distillation runs on real triggers (every 5
   sends, or manually) and exits quietly when signal is thin. Health metrics:
   **first-draft survival** (share of the sent email originating in the first
   AI draft) and **untouched rate** (sends with zero human correction — the
   delegation-readiness signal). Shown as trends, never as bare grades, and
   only after ≥10 scored sends.

v1 scope: the loop above on a thin-but-real Gmail mirror (sync, FTS search,
threads, archive/read-state, label via chat tool, reply/compose, send).

Deferred: triage rules, CRM, sequences, Gmail-visible remote drafts,
delegated auto-send, HTML compose, attachment bodies, label CRUD UI,
char-range scoping (schema keeps the field), multi-account UI (schema
supports it).

## 2. Architecture

```
packages/mail/
  package.json            # mim manifest (§3)
  README.md
  docs/plan.md            # this file
  docs/CONTRACTS.md       # frozen contracts: modules, tools, semantics
  backend/
    index.mjs             # jobs, tools (audience-split), agents export
    store.mjs             # SQLite (node:sqlite, WAL), schema, FTS, queries
    provenance.mjs        # ledger writes, survival + untouched computation
    oauth.mjs             # loopback OAuth + PKCE, token bundle, refresh
    gmail.mjs             # Gmail REST client (list/get/history/modify/send/profile)
    mime.mjs              # RFC 2822/2047 build, threading headers, reply quoting
    sync.mjs              # backfill + incremental history sync (jobs only)
    proposals.mjs         # hunk validate/anchor/apply/re-anchor state machine
    voices.mjs            # voice docs, cluster-based seeding
    flywheel.mjs          # delta distillation → voice-doc proposals
    drafting.mjs          # ctx.ai calls: initial drafts, proposal generation
  ui/
    index.html            # single-page app, tokens.css theming
    icon.svg
    js/                   # vanilla ES modules, co-located tests (Board pattern)
```

**Storage.** `~/.mim/private/mail/mail.sqlite` via `node:sqlite`
(`DatabaseSync`), WAL, `busy_timeout=5000` — user-global (Granola precedent);
FTS5 for search (Knowledge precedent). One connection per module instance;
no transaction spans an `await`; all bulk work batched ~25 rows with yields
(the backend runs in the Electron main process — blocking it blocks the app).

**Concurrency truth (from review).** Package *tools* are serialized per
package; *jobs* run concurrently with tools. Therefore: read tools never
sync inline — if the mirror is >30 s stale they kick the ephemeral sync job
(fire-and-forget) and return local data flagged `stale: true`. All network
sync lives in jobs. Nothing slow ever holds the tool queue.

**Why an app.** The gate blocks packages from core Google tools (both from
chat and from `ctx.tools.call`), and core holds only `gmail.readonly`+`send`
scopes. Self-contained OAuth (`ctx.http` + `ctx.secrets` + loopback listener;
core's own Google flow is the direct precedent) is genuinely required, not a
style choice.

## 3. Manifest

As in CONTRACTS §1. Highlights: `id: "mail"`, one work view, `ai: true`,
`http: ["gmail.googleapis.com", "oauth2.googleapis.com"]`,
`secrets: ["google_oauth_client", "google_oauth_tokens"]`, named grants for
the chat/MCP tool set only. No `workspace` permission: mail never touches
workspace files. Scopes: **`gmail.modify` only** (covers read, labels, send,
profile; the account email comes from `users.getProfile`, so no
`userinfo.email`). OAuth client must be a **Desktop app** client; PKCE on.

## 4. Data model

Full schema in CONTRACTS §2. Structure:

- **Mirror:** `accounts`, `labels`, `threads`, `messages` (+`messages_fts`
  FTS5), `attachments` (metadata only).
- **Drafting loop:** `drafts` (state: `composing | approved | sent |
  send_failed | discarded`, plus `last_send_error`), `revisions` (source:
  `ai_initial | human_edit | proposal_accept | revert`), `proposals`
  (`target_kind: draft | voice`; status: `pending | resolved | superseded |
  invalidated | dismissed`), `hunks` (status: `pending | accepted | rejected
  | stale | dropped`).
- **Voices:** `voices`, `voice_revisions` (voice proposals'
  `base_revision_id` references `voice_revisions.id`; polymorphic by
  `target_kind`).
- **Learning:** `provenance` (append-only; kinds include `human_takeover`,
  `hunks_dropped`), `sends` (`survival_rate`, `untouched`, `first_ai_text`,
  `final_text`, `voice_id`).

**Survival rate** = tokenLCS(`first_ai_text`, `final_text`) /
tokens(`final_text`) — the share of the sent email originating in the first
AI draft. `untouched` = no human_edit revisions and no rejected hunks after
the last AI contribution. NULL survival for never-AI-drafted sends (excluded,
not zero). Tokenizer and cost cap frozen in CONTRACTS §6.

## 5. Gmail: OAuth + sync

**Connect.** Onboarding validates a pasted Desktop-app OAuth client JSON
(instant, specific errors), stores it via UI `runtime.secrets`; ui-only
`connect_start` spins a loopback `node:http` listener (127.0.0.1, random
port, `state` nonce, PKCE, 120 s timeout, self-terminating, single pending
flow), returns the consent URL; UI opens it (`window.open` → system browser;
null return → copy-URL fallback). Token bundle stored as
`google_oauth_tokens`. Refresh mirrors core semantics (60 s-early check,
preserve prior `refresh_token`/`scope` when response omits them).

**Sync state machine (CONTRACTS §5).** At backfill start, capture
`historyId` from `users.getProfile` **first**, then backfill
`messages.list` pages (`q=newer_than:{window}d`, default 180 d) →
`messages.get format=full`, concurrency 4, 429/403 backoff, resumable
cursor, newest-first so the inbox streams in and is usable in seconds.
Incremental: `history.list` from the stored id; on 404, re-list 7 days AND
reset `history_id` from a fresh `getProfile`. Triggers: UI load, UI timer
(75 s while visible), stale-flag kicks from read tools, manual refresh,
`mail.sync` (which starts/observes the job — never syncs inline).

**Writeback.** Archive/read-state (UI) and `mail.label` (chat, gated) via
`messages.modify`. Send via `messages.send` (MIME contract in CONTRACTS §7);
on success, insert the sent message into the local mirror immediately —
the user must see their own email in the thread without waiting for sync.
On failure: `state='send_failed'` + `last_send_error` + a visible retry path.

## 6. Proposal engine (the heart)

Draft body is plain text; paragraphs (blocks split on blank lines) are the
shared scope vocabulary of UI, tools, and AI. Precise semantics frozen in
CONTRACTS §4; the contract in brief:

- **Only an empty body may be written directly by AI** (`ai_initial`). One
  human-typed sentence makes every subsequent AI change a proposal.
- Proposals target the current revision and carry `intent_text` + optional
  paragraph scope. Hunks are `{original_text, proposed_text, note}`.
- **Validation (before anything is stored):** NFC-normalized exact match;
  `original_text` non-empty and unique within the scope region; **no hunk
  may cross a paragraph boundary** (crossing hunks are split on blank lines
  and each fragment re-validated; unsplittable remainders are dropped);
  overlapping hunks rejected (later seq loses). Granularity is structural.
- **Dropped is visible, never silent:** the proposal header reads
  "3 changes proposed · 2 couldn't be anchored safely."
- Review actions (ui-only): accept hunk (apply → new revision → re-anchor
  pending hunks against the whole new text; non-unique → `stale`), reject
  (+ optional comment, recorded verbatim), comment → revise (new proposal
  supersedes old), **take over** (dismiss all pending, `human_takeover`
  provenance — the strongest rejection signal), accept-all / dismiss-all.
- Human typing → debounced `human_edit` revision (≤1 s, flush on blur);
  overlapping hunks demote visually immediately. Stale hunks never render
  as cards — they collapse to one line: "2 proposals no longer apply —
  dismiss · re-propose."
- Any content change after `approved` reverts state to `composing`.
- Undo = revert to a prior revision (new revision, `source='revert'`).

**Drafting context (day-one personalization):** voice document + thread
context + **the user's 2–3 most recent sent messages to the same recipient
(fallback: same domain, then voice exemplars)** + paragraph-numbered draft +
intent + scope. Recipient exemplars are the cheapest high-fidelity "sounds
like me writing to Anna" signal and ship in v1.

## 7. Voices + flywheel

**Seeding** (`seed_voices` job, runs in background after sent-folder
backfill, nudge when ready): filter noise (short bodies, receipts/automated,
mostly-quoted), then model-driven **clustering by language, register, and
audience** — a bilingual sent folder must yield language-coherent voices —
into 2–3 voice docs (register, greeting/sign-off norms, rhythm, dos/don'ts,
verbatim exemplars), presented as explicit first-read drafts ("Here's my
first read — correct me") for rename/edit/merge.

**Flywheel triggers (the pump):** after every 5 sends (checked post-send,
kicks the ephemeral job), manual "Distill lessons", and on Voices open with
≥5 undistilled sends. Weights: rejection comments > human-edit deltas on AI
text > survival trends. Thin signal (<5 sends since last run) → exit without
proposals; never invent lessons from noise. Output: hunk proposals against
voice documents, reviewed in the Voices manager with the standard mechanic.

## 8. Security: the gate

**Core fix (the one mim-os change).** Review proved `audience: ['ui']` alone
is listing-level, not dispatch-level: core `package.tools.execute` lets the
chat model execute any package tool by public name. Fix in
`packageRuntime.ts#executeTool`: when `ctx.actor === 'ai'` and the tool's
audience does not include `'chat'`, throw. TDD in `packageRuntime.test.ts`.
This makes `audience` mean what apps need it to mean, for every app. Also
log the related gate issue (generic `package.tools.execute` approval prompt
masks per-tool policy; session always-allow over-grants) in
`docs/issues.md` per repo ownership rules.

**Tool surface (inventory frozen in CONTRACTS §3):**

- **Chat + MCP (named):** `mail.search`, `mail.thread`, `mail.message`,
  `mail.labels`, `mail.label` (only chat-visible mailbox mutation, gated),
  `mail.sync` (category `network` — job kicker), `mail.drafts`,
  `mail.draft.get`, `mail.draft.create`, `mail.draft.propose`,
  `mail.voices`. The agent researches, starts drafts, proposes. It cannot
  accept, approve, or send.
- **UI-only (`audience: ['ui']`, dot-free export keys, dispatched via
  `package.tools.execute` with the `pkg_<hash>__` public name):**
  `connect_start/status/disconnect`, `hunk_accept`, `hunk_reject`,
  `hunk_comment`, `proposal_revise`, `proposal_dismiss` (take over),
  `draft_edit`, `draft_approve`, `draft_send`, `draft_discard`,
  `voice_update`, `settings_get/set`, `ui_inbox`, `ui_thread`, `ui_draft`,
  `ui_voices`.

**Agents export.** One mounted "Mail" agent; instructions from a
`ctx.data` snapshot written by sync (3 s budget — precomputed, never live);
allowlist = the named set only.

## 9. UI / UX

Five surfaces (flywheel panel merged into Voices — cut as a route):

1. **Onboarding** — guided BYO-client setup: numbered steps with deep links
   (project → enable Gmail API → consent screen → **Desktop app** client),
   instant JSON validation with specific errors, honest trade framing
   ("One-time, ~5 minutes; your mail syncs to one local file and never
   touches a third-party server"), in-product Testing-mode warning (7-day
   refresh-token expiry; Workspace domains should use Internal). After
   connect: **streaming inbox** — usable in seconds, quiet header progress
   ("Syncing — 1,240 of ~4,800"), never a blocking screen. Auth failure
   always has a face: reconnect banner, never a silently stale inbox.
2. **Inbox** — dense thread list, FTS search, Inbox/All/Sent/Drafts tabs,
   `j/k/o/e/r` keyboard model.
3. **Thread view** — collapsed history, newest expanded; **the studio docks
   inside the thread view** (the message being answered stays visible).
4. **Drafting studio** — a plain, always-editable editor with a proposal
   layer. Pending hunks tint inline (`color-mix` from `--color-add`/
   `--color-rem` at ~12%; removal tint is background-only — `--color-rem`
   collides with accent in the default theme). **One active hunk at a
   time**: Tab/j/k cycles; the active hunk shows one inline action strip
   (AI's note + accept ⏎ / reject ⌫ / comment c); others are tint-only.
   Sticky header: "N proposed changes · Accept all / Dismiss all" (+ dropped
   count when >0) and proposal origin ("from chat: 'reply to Anna'").
   Paragraph gutter: hover-only ¶ that scopes Ask-AI. History is a menu
   action (view/restore) — no persistent timeline strip. Send: Approve →
   confirm card (recipients, subject, voice — **no survival score at the
   send moment**) → Send. ⌘⏎ is nowhere near Accept-all.
5. **Voices & Learning** — voice docs as editable documents; pending
   flywheel proposals reviewed with the standard hunk UI; per-voice
   first-draft-survival trend (shown after ≥10 scored sends, "collecting —
   4 of 10" before), untouched-rate funnel (drafts → sent → sent untouched),
   recent lessons (rejection comments).

UX contract owned by a dedicated Fable UX agent (spec first, audit last):
tokens.css only; light+dark verified; WCAG AA; Mim interaction rules (no
`cursor: pointer`, hover-background affordances); visible focus rings, full
keyboard reachability, ARIA on list/dialog/menu; the *decision*
(accept/reject/send) is always visually primary; optimistic UI only for
local ops, explicit progress for network.

## 10. Testing

Vitest, co-located `*.test.mjs` (runs from repo root config). Every module
is a factory `create*(deps)` — injection seams frozen in CONTRACTS §8. Mock
only boundaries: injected `fetch` (Gmail fixtures incl. 429/403/history-404),
stubbed `ctx.ai`, in-memory secrets, temp-file SQLite. Priority:

1. `proposals.mjs` — anchoring uniqueness, NFC normalization, paragraph
   splitting, overlap rejection, re-anchor/stale, supersede, takeover,
   nasty tables (repeated sentences, unicode, whitespace).
2. `mime.mjs` — RFC 2822/2047, threading headers, quoted reply.
3. `sync.mjs` — getProfile-first historyId, paging/resume, history apply,
   404 reconcile+reset.
4. `provenance.mjs` — survival LCS + cost cap, untouched flag.
5. `oauth.mjs` — PKCE, refresh preservation, expiry buffer.
6. `store.mjs` — WAL/migrations, FTS round-trip, thread aggregation.
7. UI pure modules — state reducers, hunk view-model, keyboard map.
8. `index.mjs` integration — full loop: sync fixtures → draft → propose →
   accept/reject+comment → human edit → approve → send → provenance chain +
   survival + untouched asserted.

Overnight verification = unit + integration + `npm run test:packages:compat`
(mim-os). Live Gmail, real enablement, and consent are morning steps with
the user (BYO client, trust/enable prompts are user-only by design).

## 11. Execution waves

- **Wave 0 (supervisor):** this plan; CONTRACTS.md; scaffold; mim-os core
  fix (TDD) + issues.md entry; node:sqlite smoke check.
- **Wave 1 (3 Fable agents, parallel, strict file ownership):**
  A `store.mjs`+`provenance.mjs`; B `oauth.mjs`+`gmail.mjs`+`mime.mjs`+
  `sync.mjs`; C `proposals.mjs`+`voices.mjs`+`flywheel.mjs`+`drafting.mjs`.
  UX agent drafts the UX spec in parallel.
- **Wave 2 (1 Fable):** `backend/index.mjs` wiring, jobs, agents export,
  integration tests, drift fixes.
- **Wave 3 (2 Fable):** UI implementation per UX spec; UX-owner audit + fix
  pass (contrast, keyboard, hierarchy, both themes).
- **Wave 4 (supervisor):** full suite, personal review of send path +
  audience split + proposal engine, README, morning note.

## 12. Risks

- `gmail.modify` is a restricted scope: BYO client; Workspace-Internal
  consent screen avoids verification and token expiry (onboarding warns).
- No app scheduler: sync rides UI presence + stale-kicks + manual. Known
  core gap, acceptable v1.
- Main-process SQLite: WAL + batching discipline is mandatory, reviewed in
  Wave 4.
- Plain-text only v1 (HTML→text on ingest; plain-text send).
- The gate depends on the §8 core fix; if it were ever reverted, defense-in-
  depth (approved-state machine, approval expiry on change) still stands,
  but the README claim must be softened. Morning note calls this out.
