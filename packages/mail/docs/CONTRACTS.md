# Mail — Frozen Implementation Contracts

This file is the authority for all implementation agents. If plan.md and this
file disagree, this file wins. Do not change contracts unilaterally: if a
contract is wrong, note it in your final report; the supervisor resolves it
in Wave 2.

## 0. Module ownership (hard boundaries)

| Agent | Owns (creates + tests) | Consumes |
|---|---|---|
| A | `backend/store.mjs`, `backend/provenance.mjs` | schema (§2), store API (§8.1) |
| B | `backend/oauth.mjs`, `backend/gmail.mjs`, `backend/mime.mjs`, `backend/sync.mjs` | store API (§8.1) via injected instance |
| C | `backend/proposals.mjs`, `backend/voices.mjs`, `backend/flywheel.mjs`, `backend/drafting.mjs` | store API (§8.1), injected `ai` (§9) |
| Wave 2 | `backend/index.mjs`, `package.json` finalization | everything |
| Wave 3 | `ui/**` | tool inventory (§3) |

No agent edits files outside its ownership. If a consumed API is wrong or
missing, code against this contract, add a `// CONTRACT-GAP:` comment, and
report it — Wave 2 reconciles. Every module exports a factory (§8) and has a
co-located `*.test.mjs`. Plain JS (ESM `.mjs`), no TypeScript, no build step.

## 1. Manifest (`package.json`)

```json
{
  "name": "@mim/mail",
  "version": "0.1.0",
  "type": "module",
  "mim": {
    "manifestVersion": 1,
    "id": "mail",
    "name": "Mail",
    "icon": "./ui/icon.svg",
    "description": "AI-native Gmail: collaborative drafting with proposal review, legible voices, a hard human send gate, and a provenance flywheel.",
    "views": [{ "id": "main", "label": "Mail", "src": "./ui/index.html", "role": "work" }],
    "backend": "./backend/index.mjs",
    "permissions": {
      "ai": true,
      "http": ["gmail.googleapis.com", "oauth2.googleapis.com"],
      "secrets": ["google_oauth_client", "google_oauth_tokens"]
    },
    "provides": {
      "tools": [
        { "name": "mail.search",        "category": "read",    "risk": "low" },
        { "name": "mail.thread",        "category": "read",    "risk": "low" },
        { "name": "mail.message",       "category": "read",    "risk": "low" },
        { "name": "mail.labels",        "category": "read",    "risk": "low" },
        { "name": "mail.label",         "category": "write",   "risk": "medium" },
        { "name": "mail.sync",          "category": "network", "risk": "medium" },
        { "name": "mail.drafts",        "category": "read",    "risk": "low" },
        { "name": "mail.draft.get",     "category": "read",    "risk": "low" },
        { "name": "mail.draft.create",  "category": "write",   "risk": "medium" },
        { "name": "mail.draft.propose", "category": "write",   "risk": "medium" },
        { "name": "mail.voices",        "category": "read",    "risk": "low" }
      ]
    },
    "engines": { "mim": "runtime-v1" }
  }
}
```

OAuth scopes requested: `https://www.googleapis.com/auth/gmail.modify` ONLY.
Account email comes from `users/me/profile`. Client must be a Google
**Desktop app** OAuth client (`installed` key in the JSON). PKCE (S256)
required.

## 2. SQLite schema (Agent A owns; others read-only knowledge)

DB path: `join(os.homedir(), '.mim', 'private', 'mail', 'mail.sqlite')`
(directory created recursively). Open: `new DatabaseSync(path)` from
`node:sqlite`, then `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;`. Migrations: `meta(key,value)` table with
`schema_version`; idempotent forward migrations only. No transaction spans
an `await`. All ids are `crypto.randomUUID()` strings unless noted.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL,
  history_id TEXT, pending_history_id TEXT,
  backfill_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (backfill_state IN ('pending','running','done','error')),
  backfill_cursor TEXT, backfill_total INTEGER, backfill_done INTEGER,
  sync_window_days INTEGER NOT NULL DEFAULT 180,
  last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE labels (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_id TEXT NOT NULL,
  name TEXT NOT NULL, type TEXT NOT NULL, UNIQUE(account_id, gmail_id)
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_id TEXT NOT NULL,
  subject TEXT, snippet TEXT, last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  is_unread INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id, gmail_id)
);
CREATE INDEX idx_threads_recent ON threads(account_id, last_message_at DESC);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  from_name TEXT, from_email TEXT, to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT, subject TEXT, snippet TEXT, body_text TEXT,
  internal_date INTEGER, is_unread INTEGER NOT NULL DEFAULT 0,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  rfc822_message_id TEXT, references_json TEXT NOT NULL DEFAULT '[]',
  label_ids_json TEXT NOT NULL DEFAULT '[]',
  has_attachments INTEGER NOT NULL DEFAULT 0, fetched_at TEXT,
  UNIQUE(account_id, gmail_id)
);
CREATE INDEX idx_messages_thread ON messages(thread_id, internal_date);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED, subject, from_text, body);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  gmail_attachment_id TEXT, filename TEXT, mime TEXT, size INTEGER
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  thread_id TEXT REFERENCES threads(id), reply_to_message_id TEXT,
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]', subject TEXT,
  voice_id TEXT,
  state TEXT NOT NULL DEFAULT 'composing' CHECK (state IN
    ('composing','approved','sent','send_failed','discarded')),
  current_revision_id TEXT,
  approved_revision_id TEXT, approved_at TEXT,
  last_send_error TEXT, gmail_sent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
  seq INTEGER NOT NULL, body_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN
    ('ai_initial','human_edit','proposal_accept','revert')),
  proposal_id TEXT, hunk_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(draft_id, seq)
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('draft','voice')),
  target_id TEXT NOT NULL,          -- drafts.id or voices.id
  base_revision_id TEXT NOT NULL,   -- revisions.id or voice_revisions.id
  intent_text TEXT NOT NULL, scope_json TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user_request','chat_agent','flywheel')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','resolved','superseded','invalidated','dismissed')),
  model_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE hunks (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
  seq INTEGER NOT NULL, original_text TEXT NOT NULL, proposed_text TEXT NOT NULL,
  note TEXT, paragraph_index INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','accepted','rejected','stale','dropped')),
  drop_reason TEXT, comment TEXT, resolved_at TEXT
);
CREATE TABLE voices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  body_md TEXT NOT NULL, current_revision_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE voice_revisions (
  id TEXT PRIMARY KEY, voice_id TEXT NOT NULL REFERENCES voices(id),
  seq INTEGER NOT NULL, body_md TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seed','human_edit','proposal_accept')),
  proposal_id TEXT, created_at TEXT NOT NULL, UNIQUE(voice_id, seq)
);
CREATE TABLE provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id TEXT,
  ts TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_provenance_draft ON provenance(draft_id, id);
CREATE TABLE sends (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id),
  gmail_message_id TEXT, sent_at TEXT NOT NULL,
  final_text TEXT NOT NULL, first_ai_text TEXT,
  survival_rate REAL, untouched INTEGER NOT NULL DEFAULT 0,
  voice_id TEXT, distilled INTEGER NOT NULL DEFAULT 0
);
```

Provenance kinds (closed set): `draft_created`, `ai_drafted`,
`proposal_created`, `hunks_dropped`, `hunk_accepted`, `hunk_rejected`,
`hunk_commented`, `human_edit`, `human_takeover`, `voice_attached`,
`approved`, `approval_revoked`, `sent`, `send_failed`, `discarded`,
`flywheel_distilled`. Payloads: JSON, never tokens/keys, comments verbatim.

## 3. Tool inventory

### 3.1 Chat + MCP (named; export key → public name via manifest grant)

Export keys are dot-free capability ids; `name` field on the tool object
gives the dotted public name. `audience: ['chat']` (default) on all of these.

| Export key | `name` | Input (JSON Schema essence) | Returns |
|---|---|---|---|
| `search` | `mail.search` | `{query?, tab?: 'inbox'\|'all'\|'sent', limit?≤50, offset?}` | `{threads: [{id, subject, from, date, snippet, unread, message_count}], stale}` |
| `thread` | `mail.thread` | `{thread_id}` | `{thread, messages: [{id, from, to, cc, date, body_text}]}` (bodies truncated to fit; marker `…[truncated]`) |
| `message` | `mail.message` | `{message_id}` | full message row (parsed json fields) |
| `labels` | `mail.labels` | `{}` | `{labels: [{id, name, type}]}` |
| `label` | `mail.label` | `{thread_id?, message_id?, add?: string[], remove?: string[]}` | `{ok, applied}` — calls `messages.modify` |
| `sync` | `mail.sync` | `{}` | `{started, backfill_state, last_sync_at}` — kicks job, never inline network |
| `drafts` | `mail.drafts` | `{state?}` | `{drafts: [meta]}` |
| `draft_get` | `mail.draft.get` | `{draft_id}` | `{draft, body, pending_proposal?}` |
| `draft_create` | `mail.draft.create` | `{reply_to_message_id?, thread_id?, to?: string[], subject?, voice_id?, instruction?}` | creates draft; if `instruction` and body empty → `ai_initial` generation. Returns `{draft, body}` |
| `draft_propose` | `mail.draft.propose` | `{draft_id, intent, paragraphs?: number[]}` | `{proposal_id, hunks: [{id, original_text, proposed_text, note}], dropped}` |
| `voices_list` | `mail.voices` | `{}` | `{voices: [{id, name, description, body_md}]}` |

### 3.2 UI-only (`audience: ['ui']`, NO named grant, NO dots in ids)

Public names are `pkg_<hash>__<export key>`; the UI must **discover** them at
boot via `runtime.call('package.capabilities.list', {})`, match
`packageId === 'mail'`, build an `id → publicName` map, and invoke via
`runtime.call('package.tools.execute', { name: publicName, input })`.
Never hardcode the hash.

| Export key | Input | Behavior |
|---|---|---|
| `connect_start` | `{}` | validates stored client JSON, starts loopback+PKCE flow, returns `{consent_url}`; errors return `{error}` |
| `connect_status` | `{}` | `{connected, email, backfill_state, backfill_done, backfill_total, last_sync_at, token_ok}` |
| `connect_disconnect` | `{}` | deletes token secret, keeps mirror |
| `ui_inbox` | `{tab, query?, limit?, offset?}` | thread rows for list rendering (FTS when `query`) |
| `ui_thread` | `{thread_id}` | thread + full messages + any drafts on the thread |
| `ui_draft` | `{draft_id}` | draft + body + pending proposal with hunks (+`origin`, dropped count) + revision list (meta only) |
| `ui_voices` | `{}` | voices + pending voice proposals + metrics `{per_voice: [{voice_id, scored_sends, survival_trend: [{week, mean}], untouched_rate}], funnel: {drafts, sent, sent_untouched}, lessons: [recent rejection comments]}` |
| `draft_edit` | `{draft_id, body, base_revision_id}` | stale-write protected: if `base_revision_id !== current` → `{conflict: true, current}`; else new `human_edit` revision + re-anchor pass; returns `{revision_id, hunk_changes}` |
| `hunk_accept` | `{hunk_id}` | apply → new revision → re-anchor; returns `{revision_id, body, hunk_changes}` |
| `hunk_reject` | `{hunk_id, comment?}` | mark rejected, provenance verbatim |
| `hunk_comment` | `{hunk_id, comment}` | revise: new proposal supersedes parent; returns like `draft_propose` |
| `proposal_dismiss` | `{proposal_id, takeover?}` | dismiss pending hunks; `takeover: true` records `human_takeover` |
| `draft_approve` | `{draft_id, revision_id}` | requires `revision_id === current_revision_id`; sets state `approved`, `approved_revision_id`, `approved_at` |
| `draft_send` | `{draft_id, include_quote?}` | requires state `approved` AND `current_revision_id === approved_revision_id`; builds MIME, sends, mirrors sent message locally, records `sends` row + survival + untouched; failure → `send_failed` + `last_send_error` |
| `draft_discard` | `{draft_id}` | state `discarded` |
| `draft_update_meta` | `{draft_id, to?, cc?, bcc?, subject?, voice_id?}` | recipients/subject/voice changes; `voice_id` change → provenance `voice_attached` |
| `voice_update` | `{voice_id, body_md}` | human edit → new voice revision |
| `settings_get` / `settings_set` | `{}` / `{sync_window_days?}` | app settings |
| `jobs_kick` | `{job: 'sync'\|'backfill'\|'seed_voices'\|'flywheel'}` | starts the job (UI path; also used by post-send flywheel counter) |
| `ui_propose` | `{draft_id, intent, paragraphs?}` | UI's Ask-AI: same engine as `mail.draft.propose` but `origin: 'user_request'`; when the body is empty, routes to `initialDraft` with `intent` as the instruction. (Origin cannot be derived from the caller — tools never see the actor — so the chat tool hard-codes `chat_agent` and this tool hard-codes `user_request`.) |
| `revision_get` | `{revision_id}` | full revision body for History view |
| `draft_revert` | `{draft_id, revision_id}` | new revision `source: 'revert'` with that body |
| `ui_mark` | `{thread_id?, message_id?, archive?, read?}` | batch archive/read-state writeback via `messages.modify` + mirror update |

**Supervisor rulings (post-Wave-1, binding):**
- `voice_update` input extended to `{voice_id, body_md?, name?, description?, archived?}`.
- `connect_status` gains `seed_state: 'none'|'running'|'ready'` (kv-backed) for the voices-ready nudge.
- `ui_inbox` `tab` enum is `'inbox'|'all'|'sent'|'drafts'`; `drafts` reads the local drafts table, not Gmail labels.
- `ui_draft.pending_proposal` includes `intent_text`, `origin`, and the dropped-hunk count.
- **Single-pending invariant ratified:** at most one `pending` proposal per target; a new surviving proposal supersedes a pending predecessor (invalidated proposals supersede nothing). `hunk_comment` = `propose(comment + parent intent)`.
- Provenance kind added: `proposal_dismissed` (plain dismiss; `human_takeover` stays the takeover signal).
- Store API additions: `getHunk(id)`; `listProposals({targetKind, targetId})` (promote the internal `_untouchedCheck` queries as its basis).
- Canonical thread key on message upserts: `thread_gmail_id` (set by `gmail.parseMessage`).
- **Post-Wave-2 ratifications:** `draft_update_meta` recipient/subject changes
  on an `approved` draft revoke approval (`approval_revoked`, reason
  `meta_changed`) — ratified as deliberate gate hardening: what was approved
  is the exact (body, recipients, subject) tuple. Thread rollup subject
  tracking the newest message is accepted for v1 (cosmetic; revisit if
  Re:-retitling annoys in practice).

**State-machine invariants (enforced in backend, tested):** any new revision
(human_edit / proposal_accept / revert) while state is `approved` reverts
state to `composing` and appends `approval_revoked`. `ai_initial` is
rejected when the current body is non-empty. Accept/reject/comment only
valid on `pending` hunks; hunks on non-`pending` proposals are immutable.

## 4. Proposal engine semantics (Agent C; the heart)

1. **Paragraphs.** Body split on `/\n{2,}/`; indices are **1-based**
   everywhere (UI, tools, prompts). Scope = optional list of paragraph
   indices; absent scope = all paragraphs.
2. **Normalization.** NFC-normalize the base body and every hunk's
   `original_text` before matching. Matching is exact substring equality on
   the normalized text. No trimming, no whitespace-insensitive matching.
3. **Validation at creation (in order, per hunk):**
   a. `original_text` non-empty → else drop (`drop_reason: 'empty'`).
   b. Find all matches in the ENTIRE body. Zero → drop (`'no_match'`); >1 →
      drop (`'ambiguous'` — even when only one occurrence is inside scope,
      because acceptance re-locates by unique whole-body match per §4.4-4.5
      and a creation-valid hunk must always be acceptable against an
      unchanged body); exactly one, but not touching a scoped paragraph →
      drop (`'no_match'`). [Supervisor ruling post-Wave-1: this replaces the
      earlier scope-local uniqueness rule, which allowed hunks that instantly
      staled on accept when a duplicate existed outside scope.]
   c. The match must lie entirely within a single paragraph → else drop
      (`'crosses_paragraphs'`). (Merging paragraphs = rewrite one + delete
      the other with `proposed_text: ""`. The drafting prompt says this.)
   d. Overlap check: sort valid hunks by match position; a hunk whose span
      intersects any earlier valid hunk's span → drop (`'overlap'`).
   Record `paragraph_index` on each surviving hunk. Dropped hunks are stored
   with status `dropped` (visible), counted in the response, and logged as
   one `hunks_dropped` provenance event.
   All-dropped proposal → status `invalidated`.
4. **Accept.** Re-locate by unique match in the **current** body (see 5);
   replace span; if `proposed_text === ''`, collapse the seam's 3+ newlines
   to 2. New revision (`proposal_accept`, with `proposal_id`/`hunk_id`).
   Then re-anchor pass.
5. **Re-anchor pass (after every new revision, any source).** Each `pending`
   hunk: `original_text` must match exactly once in the ENTIRE new body →
   stays pending; zero or multiple → status `stale`. Scope is enforced at
   creation only and never re-mapped. Stale is terminal for the hunk
   (re-propose creates a new proposal).
6. **Proposal resolution.** A proposal with no `pending` hunks left becomes
   `resolved`. `hunk_comment` → new proposal (origin inherited,
   `intent_text` = comment + parent intent); parent → `superseded` and its
   pending hunks resolve as superseded-implicit (mark `stale`).
7. **Insertions** are expressed as replacement of an adjacent existing span.
   The drafting prompt must instruct: copy spans verbatim from the numbered
   draft; one hunk per paragraph; never restate unchanged paragraphs.

## 5. Sync state machine (Agent B)

- `connect` → account row (`backfill_state: 'pending'`).
- **backfill** job (`concurrency: 'single'`, resumable):
  1. `GET users/me/profile` → store `email`, `pending_history_id` =
     `historyId` (CAPTURED BEFORE LISTING — this ordering is load-bearing).
  2. `GET users/me/labels` → upsert.
  3. Loop `GET users/me/messages?q=newer_than:{window}d&maxResults=100`
     (+`pageToken` from `backfill_cursor`): fetch each id
     `GET users/me/messages/{id}?format=full` with concurrency 4; upsert in
     batches of 25 with an event-loop yield (`await new Promise(setImmediate)`)
     between batches; update `backfill_cursor`, `backfill_done`,
     `backfill_total` (from `resultSizeEstimate`), `ctx.progress`.
  4. Done → `history_id = pending_history_id`, `backfill_state: 'done'`.
- **sync** job (`concurrency: 'single'`, `ephemeral: true`): requires
  backfill done. Loop `GET users/me/history?startHistoryId={history_id}`
  (+pageToken): apply `messagesAdded` (fetch full), `messagesDeleted`
  (delete rows + FTS), `labelsAdded/labelsRemoved` (update
  `label_ids_json`, unread, thread rollups). Store the response's top-level
  `historyId` when complete + `last_sync_at`. HTTP 404 → re-list
  `newer_than:7d` (reconcile upserts) AND reset `history_id` from a fresh
  `getProfile`.
- **Retry/backoff:** on 429 honor `Retry-After` ≤ 5 s once; on 403
  rate-limit errors exponential backoff (1 s, 2 s, 4 s; then fail the job
  with `last_error`). 401 → one token refresh attempt, then fail with
  `token_ok: false` surfaced to `connect_status`.
- **Read tools never touch the network.** They return mirror data +
  `stale: true` when `last_sync_at` older than 30 s. The UI timer (75 s,
  visible only) and `jobs_kick`/`mail.sync` are the pumps.
- Message body extraction: prefer `text/plain` part; fall back to
  `text/html` stripped to text (tags removed, entities decoded, block
  elements → newlines — small pure helper in `gmail.mjs`, tested). Skip
  attachment parts (`filename` non-empty); record attachment metadata.
  Decode base64url. `internalDate` is a ms-epoch string → INTEGER.

## 6. Survival + untouched (Agent A, `provenance.mjs`)

- `first_ai_text` = body of the draft's first `ai_initial` revision, else
  NULL (then `survival_rate` NULL — excluded from aggregates, not zero).
- Tokenizer: NFC → `split(/\s+/)` → drop empty strings. Case-sensitive,
  punctuation attached.
- `survival_rate = LCS(tokens(first_ai_text), tokens(final_text)).length /
  max(1, tokens(final_text).length)`, clamped [0,1].
- Cost cap: if `n*m > 25_000_000`, compute on lines (`split(/\n/)`) instead.
- `untouched = 1` iff the draft has zero `human_edit` revisions AND zero
  hunks with status `rejected` AND zero proposals with status `dismissed`.
  (Accepting every hunk untouched-ly is supervision, not correction.)
- Aggregation for `ui_voices`: per voice, ISO-week mean of `survival_rate`
  over scored sends; `scored_sends` count; `untouched_rate` overall;
  UI shows survival only when `scored_sends >= 10`.

## 7. MIME contract (Agent B, `mime.mjs` — pure functions)

- `buildMessage({from, to, cc, bcc, subject, bodyText, inReplyTo?,
  references?, quote?})` → RFC 2822 string:
  - Headers: `From`, `To`, `Cc`/`Bcc` (only when non-empty), `Subject`
    (RFC 2047 UTF-8 base64 encoded-word when non-ASCII), `Date` (RFC 2822),
    `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64` (body base64, 76-char lines).
    No `Message-ID` (Gmail assigns).
  - Reply: `In-Reply-To: <orig Message-ID>`; `References` = original
    `References` list + original `Message-ID` (space-separated, RFC 5322
    §3.6.4). `Re: ` prefix added case-insensitively once.
  - `quote` (optional `{date, fromDisplay, bodyText}`): appended at send
    time as `\n\nOn {date}, {fromDisplay} wrote:\n` + `> `-prefixed lines.
    Draft bodies stay clean prose; quoting is send-time assembly
    (`include_quote`, default true for replies). Survival uses the clean
    body, never the quoted assembly.
- `encodeRaw(rfc2822)` → base64url. Send: `POST
  users/me/messages/send` body `{raw, threadId?}`.

## 8. Factories & injection seams (everyone)

Every module exports a single factory; no module-level I/O at import time
(the backend is re-imported with a cache-buster on reload).

```js
// 8.1 Agent A
createStore({ dbPath })  // opens lazily on first call, WAL, stays open
// Mirror: upsertAccount, getAccount, updateAccount(patch),
//   upsertLabels(accountId, rows), listLabels(accountId),
//   upsertMessage(accountId, msg) /* creates/updates thread rollup + FTS;
//     msg.thread_gmail_id (canonical key, set by gmail.parseMessage) resolves
//     or creates the thread row */,
//   deleteMessageByGmailId(accountId, gmailId),
//   applyLabelChange(accountId, gmailId, addIds, removeIds),
//   searchThreads({accountId, tab, query, limit, offset}),
//   getThread(threadId), getThreadMessages(threadId), getMessage(id),
//   recentSentTo({accountId, email, domain, limit}) // recipient exemplars
// Drafting: createDraft(fields), getDraft(id), updateDraft(id, patch),
//   listDrafts({state}), appendRevision({draftId, body, source, proposalId?,
//   hunkId?}) /* bumps current_revision_id, handles approved→composing +
//   approval_revoked provenance */, getRevision(id), listRevisions(draftId),
//   createProposal({...,hunks:[...]}), getProposal(id, {withHunks}),
//   pendingProposal(targetKind, targetId), updateHunk(id, patch),
//   updateProposal(id, patch)
// Voices: createVoice, listVoices({archived}), getVoice(id),
//   appendVoiceRevision({voiceId, body, source, proposalId?})
// Learning: appendProvenance({draftId, kind, payload}),
//   listProvenance({draftId?, sinceId?}), recordSend(row),
//   undistilledSends(), markDistilled(draftIds), voiceMetrics()
createProvenance({ store })   // survivalRate(a,b), untouched(draftId),
                              // finalizeSend({draftId, gmailMessageId, finalText})

// 8.2 Agent B
createOAuth({ secrets, fetch, createServer })  // node:http injectable
//   startFlow() → {consentUrl, waitForToken(): Promise<bundle>}
//   accessToken() → refresh-if-needed (60s buffer; preserve refresh_token/
//   scope when response omits them), status()
createGmailClient({ oauth, fetch })  // request(path, {method, query, body})
//   → parsed JSON; auth header; retry per §5; typed helpers: profile(),
//   listLabels(), listMessages(q, pageToken), getMessage(id), history(...),
//   modifyMessage(id, add, remove), send(raw, threadId)
createMime()                          // pure, §7
createSync({ store, gmail, progress, signal })  // backfill(), incremental()

// 8.3 Agent C
createProposals({ store })  // validateAndCreate({targetKind, targetId, intent,
//   scope, origin, modelId, rawHunks}) → {proposal, dropped},
//   acceptHunk(id), rejectHunk(id, comment), reanchor(targetKind, targetId),
//   dismiss(proposalId, {takeover}), applyToBody(body, hunk) [pure, exported
//   for tests]
createDrafting({ store, ai })  // ai = { generateObject({system,prompt,schema}) }
//   initialDraft({draftId, instruction}) → ai_initial revision
//   propose({draftId, intent, paragraphs, origin}) → via createProposals
//   context assembly: voice doc + thread + recipient exemplars
//   (store.recentSentTo, 2-3 messages, fallback domain → voice exemplars)
//   + paragraph-numbered body + intent
createVoices({ store, ai })    // seed({accountId}) per plan §7 (filter noise,
//   cluster by language/register/audience, 2-3 docs, ≤80 samples ×
//   ≤500 chars in the prompt)
createFlywheel({ store, ai })  // distill(): exit silently if
//   undistilledSends().length < 5; else voice-doc proposals via
//   createProposals(target_kind 'voice'), mark distilled, provenance
```

`ai` adapter (Wave 2 wires): `generateObject` calls `ctx.ai.generateObject`
and returns `result.object` — **the payload is at `.object`**, and the hunks
schema is `{type:'object', properties:{hunks:{type:'array', items:{type:
'object', properties:{original_text:{type:'string'}, proposed_text:
{type:'string'}, note:{type:'string'}}, required:['original_text',
'proposed_text']}}}, required:['hunks']}`. Model failure → proposal
`invalidated`, error message in the tool result, never a throw that loses
the draft.

## 9. Testing contract

- Vitest from repo root (`packages/**/*.test.mjs` is already included).
- Temp SQLite per test (`mkdtemp` + file path), no shared state.
- Gmail fixtures: a `fakeFetch(routes)` helper in `backend/testUtils.mjs`
  (Agent B creates; A/C may add their own local helpers, not share).
- `ctx.ai` stub: `{ generateObject: async () => ({ object: {...} }) }`.
- Never call the network, never touch `~/.mim`, never import `electron`.

## 10. Conventions

- Match Board/GitHub Monitor style: plain ESM, small modules, no deps
  beyond `devDependencies: { vitest }` if a package-local runner is wanted
  (root runner already covers `*.test.mjs`).
- Tool `description` fields are written as tool-use guidance for the model.
- UI: vanilla ES modules, tokens.css variables only, no frameworks, no
  build step. Keyboard handlers must guard `event.target` inputs (Board
  `shortcuts.js` pattern).
- Errors returned to tools as `{error: string}` payloads where recoverable;
  thrown only for programmer errors.
