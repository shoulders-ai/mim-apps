// Mail backend — Wave 2 integration (docs/CONTRACTS.md is the authority).
//
// Wires the Wave-1 modules into the Mim runtime contract:
//   jobs   — backfill, sync (ephemeral), seed_voices, flywheel (ephemeral)
//   tools  — the named chat/MCP surface (§3.1) and the ui-only surface (§3.2)
//   agents — one mounted 'Mail' agent whose instructions read only the
//            ctx.data kv snapshot written by the sync jobs (3 s budget)
//
// Injection seams (§8): node:http createServer into createOAuth; a
// synchronous secrets snapshot over the async ctx.secrets keychain API; a
// fetch(url, options) adapter over ctx.http.request; ctx.ai.generateObject
// passed through unchanged (its result already carries the payload at
// .object). No module-level I/O at import time — the backend is re-imported
// with a cache-buster on reload.

import { createServer as nodeCreateServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createProvenance } from './provenance.mjs'
import { createOAuth } from './oauth.mjs'
import { createGmailClient } from './gmail.mjs'
import { createMime } from './mime.mjs'
import { createSync } from './sync.mjs'
import { createProposals } from './proposals.mjs'
import { createDrafting } from './drafting.mjs'
import { createVoices } from './voices.mjs'
import { createFlywheel } from './flywheel.mjs'

// v1 is single-account; the schema supports more, the wiring pins one row.
const ACCOUNT_ID = 'default'
const SECRET_NAMES = ['google_oauth_client', 'google_oauth_tokens']
const SNAPSHOT_KEY = 'agent_state'
const SEED_STATE_KEY = 'seed_state'
const SEED_STATES = ['none', 'running', 'ready']
const JOB_IDS = ['backfill', 'sync', 'seed_voices', 'flywheel']
const STALE_AFTER_MS = 30_000
const FLYWHEEL_MIN_SENDS = 5
const CHAT_BODY_CHARS = 2000

const NOT_CONNECTED = {
  error: 'No Gmail account connected — open the Mail app and connect an account first.',
}

// ---------------------------------------------------------------------------
// Lazy singletons + test seams

const state = {
  dbPath: null, // test override
  createServer: null, // test override
  store: null,
  proposals: null,
  provenance: null,
  mime: null,
  activeFlow: null, // { consentUrl } while a loopback consent flow is pending
  lastConnectError: null,
}

function defaultDbPath() {
  return join(homedir(), '.mim', 'private', 'mail', 'mail.sqlite')
}

function getStore() {
  if (!state.store) state.store = createStore({ dbPath: state.dbPath ?? defaultDbPath() })
  return state.store
}

function getProposals() {
  if (!state.proposals) state.proposals = createProposals({ store: getStore() })
  return state.proposals
}

function getProvenance() {
  if (!state.provenance) state.provenance = createProvenance({ store: getStore() })
  return state.provenance
}

function getMime() {
  if (!state.mime) state.mime = createMime()
  return state.mime
}

/** Test-only: point the singleton store at a temp DB and inject a fake
 *  loopback server factory. Never used by the runtime. */
export function _resetForTests({ dbPath, createServer } = {}) {
  try {
    state.store?.close()
  } catch {
    /* already closed */
  }
  state.store = null
  state.proposals = null
  state.provenance = null
  state.mime = null
  state.activeFlow = null
  state.lastConnectError = null
  state.dbPath = dbPath ?? null
  state.createServer = createServer ?? null
}

/** Test-only: direct store access for assertions. */
export function _storeForTests() {
  return getStore()
}

// ---------------------------------------------------------------------------
// Adapters over the runtime ctx

// ctx.http.request takes a single {url, method, headers, body} input and
// returns a fetch-style response (ok/status/headers.get/json/text); oauth.mjs
// and gmail.mjs expect fetch(url, options).
function fetchAdapter(ctx) {
  return (url, options = {}) =>
    ctx.http.request({
      url,
      ...(options.method ? { method: options.method } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    })
}

// oauth.mjs consumes secrets synchronously; ctx.secrets is async (keychain).
// Snapshot the declared secrets up front, write through on set/delete, and
// flush pending writes after every oauth-touching operation so token
// refreshes are never lost.
async function secretsSnapshot(ctx) {
  const cache = new Map()
  const pending = []
  for (const name of SECRET_NAMES) {
    let value = null
    try {
      value = await ctx.secrets.get(name)
    } catch {
      value = null
    }
    cache.set(name, value ?? null)
  }
  return {
    get: (name) => cache.get(name) ?? null,
    set: (name, value) => {
      cache.set(name, value)
      pending.push(Promise.resolve().then(() => ctx.secrets.set(name, value)))
    },
    delete: (name) => {
      cache.set(name, null)
      pending.push(Promise.resolve().then(() => ctx.secrets.delete(name)))
    },
    flush: () => Promise.allSettled(pending.splice(0)),
  }
}

async function oauthFor(ctx) {
  const secrets = await secretsSnapshot(ctx)
  const oauth = createOAuth({
    secrets,
    fetch: fetchAdapter(ctx),
    createServer: state.createServer ?? nodeCreateServer,
  })
  return { oauth, secrets }
}

function gmailFor(ctx, oauth) {
  return createGmailClient({ oauth, fetch: fetchAdapter(ctx) })
}

// ctx.ai.generateObject already resolves to { object, modelId, ... } — the
// payload is at .object per CONTRACTS §8 — so it passes through unchanged.
function aiFor(ctx) {
  return { generateObject: (input) => ctx.ai.generateObject(input) }
}

function draftingFor(ctx) {
  return createDrafting({ store: getStore(), ai: aiFor(ctx) })
}

// ---------------------------------------------------------------------------
// Shared helpers

function nowIso() {
  return new Date().toISOString()
}

function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function ensureAccount() {
  const store = getStore()
  let account = store.getAccount(ACCOUNT_ID)
  if (!account) {
    store.upsertAccount({ id: ACCOUNT_ID, email: '', created_at: nowIso() })
    account = store.getAccount(ACCOUNT_ID)
  }
  return account
}

// "Connected" for data tools = an account row whose email is known (set by
// backfill step 1). Token health is connect_status's job.
function connectedAccount() {
  const account = getStore().getAccount(ACCOUNT_ID)
  if (!account || !account.email) return null
  return account
}

function isStale(account) {
  if (!account?.last_sync_at) return true
  const at = Date.parse(account.last_sync_at)
  return !Number.isFinite(at) || Date.now() - at > STALE_AFTER_MS
}

function truncateBody(text, max = CHAT_BODY_CHARS) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '…[truncated]' : value
}

function emailList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.includes('@'))
}

function addressEmails(jsonText) {
  return (parseJson(jsonText, []) ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.email))
    .filter((email) => typeof email === 'string' && email !== '')
}

function threadRow(thread) {
  // searchThreads rows precompute the latest sender; rows from getThread
  // (single-thread paths) fall back to one message lookup.
  let fromName = thread.last_from_name
  let fromEmail = thread.last_from_email
  if (fromName === undefined && fromEmail === undefined) {
    const messages = getStore().getThreadMessages(thread.id)
    const last = messages[messages.length - 1]
    fromName = last?.from_name
    fromEmail = last?.from_email
  }
  return {
    id: thread.id,
    subject: thread.subject,
    from: fromName || fromEmail || '',
    from_name: fromName ?? '',
    from_email: fromEmail ?? '',
    date: thread.last_message_at,
    snippet: thread.snippet,
    unread: thread.is_unread === 1,
    message_count: thread.message_count,
  }
}

function publicMessage(row, { fullBody = true } = {}) {
  return {
    id: row.id,
    gmail_id: row.gmail_id,
    thread_id: row.thread_id,
    from: { name: row.from_name ?? '', email: row.from_email ?? '' },
    to: parseJson(row.to_json, []),
    cc: parseJson(row.cc_json, []),
    bcc: parseJson(row.bcc_json, []),
    reply_to: row.reply_to,
    subject: row.subject,
    snippet: row.snippet,
    body_text: fullBody ? row.body_text : truncateBody(row.body_text),
    date: row.internal_date,
    unread: row.is_unread === 1,
    from_me: row.is_from_me === 1,
    labels: parseJson(row.label_ids_json, []),
    has_attachments: row.has_attachments === 1,
  }
}

function draftMeta(d) {
  return {
    id: d.id,
    thread_id: d.thread_id,
    reply_to_message_id: d.reply_to_message_id,
    to: parseJson(d.to_json, []),
    cc: parseJson(d.cc_json, []),
    bcc: parseJson(d.bcc_json, []),
    subject: d.subject,
    voice_id: d.voice_id,
    state: d.state,
    current_revision_id: d.current_revision_id,
    approved_revision_id: d.approved_revision_id,
    approved_at: d.approved_at,
    last_send_error: d.last_send_error,
    gmail_sent_id: d.gmail_sent_id,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }
}

function draftBody(draft) {
  if (!draft.current_revision_id) return ''
  return getStore().getRevision(draft.current_revision_id)?.body_text ?? ''
}

function publicVoice(v) {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    body_md: v.body_md,
    current_revision_id: v.current_revision_id,
    archived: v.archived === 1,
    created_at: v.created_at,
    updated_at: v.updated_at,
  }
}

// Pending proposal for a target, shaped for review UIs: hunk list (all
// statuses so the UI can say "N proposed · M couldn't be anchored"), the
// intent, origin, and dropped count (§3.2 ui_draft ruling).
function pendingProposalView(targetKind, targetId, { pendingOnly = false } = {}) {
  const store = getStore()
  const pending = store.pendingProposal(targetKind, targetId)
  if (!pending) return null
  const full = store.getProposal(pending.id, { withHunks: true })
  const hunks = full.hunks ?? []
  return {
    id: full.id,
    intent_text: full.intent_text,
    origin: full.origin,
    status: full.status,
    base_revision_id: full.base_revision_id,
    created_at: full.created_at,
    dropped: hunks.filter((h) => h.status === 'dropped').length,
    hunks: hunks
      .filter((h) => (pendingOnly ? h.status === 'pending' : true))
      .map((h) => ({
        id: h.id,
        seq: h.seq,
        original_text: h.original_text,
        proposed_text: h.proposed_text,
        note: h.note,
        status: h.status,
        drop_reason: h.drop_reason,
        paragraph_index: h.paragraph_index,
        comment: h.comment,
      })),
  }
}

function resolveTargetMessages({ thread_id, message_id }) {
  const store = getStore()
  if (message_id) {
    const msg = store.getMessage(message_id)
    if (!msg) return { error: `Unknown message: ${message_id}` }
    return { messages: [msg] }
  }
  if (thread_id) {
    const msgs = store.getThreadMessages(thread_id)
    if (msgs.length === 0) return { error: `Unknown or empty thread: ${thread_id}` }
    return { messages: msgs }
  }
  return { error: 'Pass thread_id or message_id.' }
}

async function modifyLabelsOnTargets(ctx, input, add, remove) {
  const account = connectedAccount()
  if (!account) return NOT_CONNECTED
  if (add.length === 0 && remove.length === 0) {
    return { error: 'Nothing to change — pass label ids to add and/or remove.' }
  }
  const targets = resolveTargetMessages(input)
  if (targets.error) return targets
  const { oauth, secrets } = await oauthFor(ctx)
  const gmail = gmailFor(ctx, oauth)
  const applied = []
  try {
    for (const msg of targets.messages) {
      await gmail.modifyMessage(msg.gmail_id, add, remove)
      getStore().applyLabelChange(ACCOUNT_ID, msg.gmail_id, add, remove)
      applied.push(msg.gmail_id)
    }
  } catch (err) {
    return { error: `Label change failed: ${err.message}`, applied }
  } finally {
    await secrets.flush()
  }
  return { ok: true, applied }
}

// The draft-creation core shared by mail.draft.create; reply drafts inherit
// thread, recipients, and subject from the replied-to mirrored message.
function createDraftFromInput(input, origin) {
  const store = getStore()
  let threadId = typeof input.thread_id === 'string' ? input.thread_id : null
  let to = emailList(input.to)
  let subject = typeof input.subject === 'string' ? input.subject : null
  const replyTo = typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id : null

  if (replyTo) {
    const original = store.getMessage(replyTo)
    if (!original) return { error: `Unknown message: ${replyTo}` }
    threadId = original.thread_id
    if (to.length === 0) {
      to = original.is_from_me
        ? addressEmails(original.to_json)
        : [original.reply_to || original.from_email].filter(Boolean)
    }
    if (!subject) subject = original.subject ?? null
  } else if (threadId && !store.getThread(threadId)) {
    return { error: `Unknown thread: ${threadId}` }
  }
  if (input.voice_id && !store.getVoice(input.voice_id)) {
    return { error: `Unknown voice: ${input.voice_id}` }
  }

  const draft = store.createDraft({
    account_id: ACCOUNT_ID,
    thread_id: threadId,
    reply_to_message_id: replyTo,
    to_json: JSON.stringify(to),
    subject,
    voice_id: input.voice_id ?? null,
  })
  store.appendProvenance({
    draftId: draft.id,
    kind: 'draft_created',
    payload: {
      origin,
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
      ...(typeof input.instruction === 'string' && input.instruction !== ''
        ? { instruction: input.instruction }
        : {}),
      ...(input.voice_id ? { voice_id: input.voice_id } : {}),
    },
  })
  return { draft }
}

function readSeedState(ctx) {
  const value = ctx.data.kv.get(SEED_STATE_KEY)
  return SEED_STATES.includes(value) ? value : 'none'
}

// Small kv snapshot the mounted agent's instructions read (3 s budget —
// precomputed by the sync jobs, never a live DB read).
function writeAgentSnapshot(ctx) {
  const store = getStore()
  const account = store.getAccount(ACCOUNT_ID)
  if (!account) return
  const threads = store.searchThreads({ accountId: ACCOUNT_ID, limit: 10000, offset: 0 })
  ctx.data.kv.set(SNAPSHOT_KEY, {
    email: account.email,
    backfill_state: account.backfill_state,
    last_sync_at: account.last_sync_at,
    thread_count: threads.length,
  })
}

async function startJob(ctx, jobId, inputs = {}) {
  // packageJobParams resolves packageId from the package actor's ctx, so no
  // packageId is passed. Single-concurrency rejections ("already running")
  // surface as a thrown error — callers treat that as "already pumping".
  return ctx.tools.call('package.jobs.start', { jobId, ...(Object.keys(inputs).length ? { inputs } : {}) })
}

async function maybeSeedVoices(ctx) {
  const store = getStore()
  const hasAnyVoice =
    store.listVoices({ archived: false }).length > 0 || store.listVoices({ archived: true }).length > 0
  if (hasAnyVoice) return
  const seedState = readSeedState(ctx)
  if (seedState !== 'none') return
  ctx.data.kv.set(SEED_STATE_KEY, 'running')
  try {
    await startJob(ctx, 'seed_voices')
  } catch {
    ctx.data.kv.set(SEED_STATE_KEY, 'none')
  }
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required }
}

// ---------------------------------------------------------------------------
// Jobs (§5)

export const jobs = {
  backfill: {
    label: 'Backfill Gmail mirror',
    concurrency: 'single',
    inputSchema: objectSchema({}),
    async run(ctx) {
      ensureAccount()
      const { oauth, secrets } = await oauthFor(ctx)
      const gmail = gmailFor(ctx, oauth)
      const syncer = createSync({
        store: getStore(),
        gmail,
        progress: (p) => {
          const total = p.backfill_total || 0
          const value = total > 0 ? Math.min(1, (p.backfill_done || 0) / total) : 0
          ctx.progress.progress(value, `Syncing — ${p.backfill_done ?? 0} of ~${total || '?'}`)
        },
        signal: ctx.abort.signal,
      })
      try {
        await syncer.backfill(ACCOUNT_ID)
      } finally {
        await secrets.flush()
      }
      writeAgentSnapshot(ctx)
      await maybeSeedVoices(ctx)
      const account = getStore().getAccount(ACCOUNT_ID)
      return {
        backfill_state: account.backfill_state,
        backfill_done: account.backfill_done,
        backfill_total: account.backfill_total,
        last_sync_at: account.last_sync_at,
      }
    },
  },

  sync: {
    label: 'Sync Gmail',
    concurrency: 'single',
    // Housekeeping: no persisted run record; freshness lives in the mirror.
    ephemeral: true,
    inputSchema: objectSchema({}),
    async run(ctx) {
      const store = getStore()
      const account = store.getAccount(ACCOUNT_ID)
      if (!account) return { synced: false, reason: 'not_connected' }
      if (account.backfill_state !== 'done') {
        return { synced: false, reason: 'backfill_not_done', backfill_state: account.backfill_state }
      }
      const { oauth, secrets } = await oauthFor(ctx)
      const gmail = gmailFor(ctx, oauth)
      const syncer = createSync({
        store,
        gmail,
        progress: () => {},
        signal: ctx.abort.signal,
      })
      try {
        await syncer.incremental(ACCOUNT_ID)
      } finally {
        await secrets.flush()
      }
      writeAgentSnapshot(ctx)
      return { synced: true, last_sync_at: store.getAccount(ACCOUNT_ID).last_sync_at }
    },
  },

  seed_voices: {
    label: 'Seed voices from sent mail',
    concurrency: 'single',
    inputSchema: objectSchema({}),
    async run(ctx) {
      ensureAccount()
      ctx.data.kv.set(SEED_STATE_KEY, 'running')
      const voices = createVoices({ store: getStore(), ai: aiFor(ctx) })
      let result
      try {
        result = await voices.seed({ accountId: ACCOUNT_ID })
      } catch (err) {
        ctx.data.kv.set(SEED_STATE_KEY, 'none')
        throw err
      }
      if (result.error) {
        ctx.data.kv.set(SEED_STATE_KEY, 'none')
        return result
      }
      ctx.data.kv.set(SEED_STATE_KEY, 'ready')
      return { voices: result.voices.map((v) => ({ id: v.id, name: v.name })) }
    },
  },

  flywheel: {
    label: 'Distill lessons into voices',
    concurrency: 'single',
    ephemeral: true,
    inputSchema: objectSchema({}),
    async run(ctx) {
      const flywheel = createFlywheel({ store: getStore(), ai: aiFor(ctx) })
      return flywheel.distill()
    },
  },
}

// ---------------------------------------------------------------------------
// Tools — §3.1 named (chat/MCP, default audience) then §3.2 ui-only

export const tools = {
  // ----- §3.1 named -----

  search: {
    name: 'mail.search',
    label: 'Search mail',
    description:
      'Search the local Gmail mirror. Full-text query over subject, sender, and body; omit query to list recent threads. Never touches the network — check the stale flag and call mail.sync when freshness matters.',
    inputSchema: objectSchema({
      query: { type: 'string', description: 'Full-text search terms; omit to list recent threads' },
      tab: { type: 'string', enum: ['inbox', 'all', 'sent'], description: 'Scope (default all)' },
      limit: { type: 'number', description: 'Max threads, up to 50 (default 20)' },
      offset: { type: 'number' },
    }),
    async execute(ctx, input) {
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit) || 20)))
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0))
      const tab = ['inbox', 'all', 'sent'].includes(input.tab) ? input.tab : 'all'
      const threads = getStore().searchThreads({
        accountId: ACCOUNT_ID,
        tab,
        query: typeof input.query === 'string' && input.query !== '' ? input.query : undefined,
        limit,
        offset,
      })
      return { threads: threads.map(threadRow), stale: isStale(account) }
    },
  },

  thread: {
    name: 'mail.thread',
    label: 'Read thread',
    description:
      'Read a thread from the local mirror with all its messages, oldest first. Long bodies are truncated with an …[truncated] marker; use mail.message for one full message.',
    inputSchema: objectSchema({ thread_id: { type: 'string' } }, ['thread_id']),
    async execute(ctx, input) {
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const store = getStore()
      const thread = store.getThread(input.thread_id)
      if (!thread) return { error: `Unknown thread: ${input.thread_id}` }
      const messages = store.getThreadMessages(thread.id).map((m) => ({
        id: m.id,
        from: { name: m.from_name ?? '', email: m.from_email ?? '' },
        to: parseJson(m.to_json, []),
        cc: parseJson(m.cc_json, []),
        date: m.internal_date,
        body_text: truncateBody(m.body_text),
      }))
      return { thread: threadRow(thread), messages, stale: isStale(account) }
    },
  },

  message: {
    name: 'mail.message',
    label: 'Read message',
    description: 'Read one full message row from the local mirror, including the complete body.',
    inputSchema: objectSchema({ message_id: { type: 'string' } }, ['message_id']),
    async execute(ctx, input) {
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const msg = getStore().getMessage(input.message_id)
      if (!msg) return { error: `Unknown message: ${input.message_id}` }
      return { message: publicMessage(msg), stale: isStale(account) }
    },
  },

  labels: {
    name: 'mail.labels',
    label: 'List labels',
    description: 'List the Gmail labels known to the local mirror (system and user labels).',
    inputSchema: objectSchema({}),
    async execute() {
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const labels = getStore()
        .listLabels(ACCOUNT_ID)
        .map((l) => ({ id: l.gmail_id, name: l.name, type: l.type }))
      return { labels, stale: isStale(account) }
    },
  },

  label: {
    name: 'mail.label',
    label: 'Change labels',
    description:
      'Add or remove Gmail labels on a message or every message of a thread (archive = remove INBOX, mark read = remove UNREAD). Writes to Gmail and mirrors locally. Use label ids from mail.labels.',
    inputSchema: objectSchema({
      thread_id: { type: 'string' },
      message_id: { type: 'string' },
      add: { type: 'array', items: { type: 'string' } },
      remove: { type: 'array', items: { type: 'string' } },
    }),
    async execute(ctx, input) {
      const add = Array.isArray(input.add) ? input.add.filter((s) => typeof s === 'string') : []
      const remove = Array.isArray(input.remove) ? input.remove.filter((s) => typeof s === 'string') : []
      return modifyLabelsOnTargets(ctx, input, add, remove)
    },
  },

  sync: {
    name: 'mail.sync',
    label: 'Sync mailbox',
    description:
      'Start a background mailbox sync job (incremental, or the initial backfill when it has not finished). Returns immediately; never syncs inline.',
    inputSchema: objectSchema({}),
    async execute(ctx) {
      const account = getStore().getAccount(ACCOUNT_ID)
      if (!account) return NOT_CONNECTED
      let started = false
      try {
        await startJob(ctx, account.backfill_state === 'done' ? 'sync' : 'backfill')
        started = true
      } catch {
        started = false // a run is already pumping, or the runtime refused
      }
      const fresh = getStore().getAccount(ACCOUNT_ID)
      return { started, backfill_state: fresh.backfill_state, last_sync_at: fresh.last_sync_at }
    },
  },

  drafts: {
    name: 'mail.drafts',
    label: 'List drafts',
    description: 'List local drafts with their state (composing, approved, sent, send_failed, discarded).',
    inputSchema: objectSchema({
      state: { type: 'string', enum: ['composing', 'approved', 'sent', 'send_failed', 'discarded'] },
    }),
    async execute(ctx, input) {
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const drafts = getStore().listDrafts(input.state ? { state: input.state } : {})
      return { drafts: drafts.map(draftMeta) }
    },
  },

  draft_get: {
    name: 'mail.draft.get',
    label: 'Read draft',
    description: 'Read one draft: metadata, current body, and the pending proposal if one exists.',
    inputSchema: objectSchema({ draft_id: { type: 'string' } }, ['draft_id']),
    async execute(ctx, input) {
      const draft = getStore().getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      const pending = pendingProposalView('draft', draft.id, { pendingOnly: true })
      return {
        draft: draftMeta(draft),
        body: draftBody(draft),
        ...(pending ? { pending_proposal: pending } : {}),
      }
    },
  },

  draft_create: {
    name: 'mail.draft.create',
    label: 'Create draft',
    description:
      'Create a local draft (never visible in Gmail until the human approves and sends). For replies pass reply_to_message_id — recipients and subject are inherited. Pass instruction to have the AI write the first body; without it the draft starts empty.',
    inputSchema: objectSchema({
      reply_to_message_id: { type: 'string' },
      thread_id: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      voice_id: { type: 'string' },
      instruction: { type: 'string', description: 'What the email should say — triggers the AI first draft' },
    }),
    async execute(ctx, input) {
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const created = createDraftFromInput(input, 'chat_agent')
      if (created.error) return created
      let draft = created.draft
      let body = ''
      if (typeof input.instruction === 'string' && input.instruction.trim() !== '') {
        const result = await draftingFor(ctx).initialDraft({
          draftId: draft.id,
          instruction: input.instruction,
        })
        if (result.error) {
          return { draft: draftMeta(getStore().getDraft(draft.id)), body: '', error: result.error }
        }
        body = result.body
        draft = getStore().getDraft(draft.id)
      }
      return { draft: draftMeta(draft), body }
    },
  },

  draft_propose: {
    name: 'mail.draft.propose',
    label: 'Propose draft changes',
    description:
      'Propose changes to a non-empty draft as reviewable hunks (exact find-and-replace). The human accepts or rejects each hunk — this never edits the draft directly. Optionally scope to 1-based paragraph numbers.',
    inputSchema: objectSchema(
      {
        draft_id: { type: 'string' },
        intent: { type: 'string', description: 'What to change and why' },
        paragraphs: { type: 'array', items: { type: 'number' }, description: '1-based paragraph scope' },
      },
      ['draft_id', 'intent'],
    ),
    async execute(ctx, input) {
      return draftingFor(ctx).propose({
        draftId: input.draft_id,
        intent: input.intent,
        paragraphs: input.paragraphs,
        origin: 'chat_agent',
      })
    },
  },

  voices_list: {
    name: 'mail.voices',
    label: 'List voices',
    description: 'List the writing voices (name, when to use, and the full voice document).',
    inputSchema: objectSchema({}),
    async execute() {
      const voices = getStore()
        .listVoices({ archived: false })
        .map((v) => ({ id: v.id, name: v.name, description: v.description, body_md: v.body_md }))
      return { voices }
    },
  },

  // ----- §3.2 ui-only (audience ['ui'], no named grant, dot-free keys) -----

  connect_start: {
    label: 'Connect Gmail',
    description:
      'Validate the stored OAuth client JSON and start the loopback + PKCE consent flow. Returns the consent URL to open in the browser.',
    audience: ['ui'],
    inputSchema: objectSchema({}),
    async execute(ctx) {
      if (state.activeFlow) return { consent_url: state.activeFlow.consentUrl, already_pending: true }
      const { oauth, secrets } = await oauthFor(ctx)
      let flow
      try {
        flow = await oauth.startFlow()
      } catch (err) {
        return { error: err.message }
      }
      state.activeFlow = { consentUrl: flow.consentUrl }
      state.lastConnectError = null
      flow
        .waitForToken()
        .then(async () => {
          state.activeFlow = null
          await secrets.flush()
          ensureAccount()
          try {
            await startJob(ctx, 'backfill')
          } catch {
            /* the UI's jobs_kick path can start it */
          }
        })
        .catch(async (err) => {
          state.activeFlow = null
          state.lastConnectError = err?.message ?? String(err)
          await secrets.flush()
        })
      return { consent_url: flow.consentUrl }
    },
  },

  connect_status: {
    label: 'Connection status',
    description: 'Report Gmail connection, token health, backfill progress, and voice-seeding state.',
    audience: ['ui'],
    inputSchema: objectSchema({}),
    async execute(ctx) {
      const account = getStore().getAccount(ACCOUNT_ID)
      const secrets = await secretsSnapshot(ctx)
      const tokens = parseJson(secrets.get('google_oauth_tokens'), null)
      const connected = Boolean(tokens)
      // A merely-expired access token refreshes on demand; token_ok is false
      // only when there is nothing left to refresh with.
      const tokenOk = connected && (Date.now() < (tokens.expires_at ?? 0) || Boolean(tokens.refresh_token))
      return {
        connected,
        email: account?.email ?? '',
        backfill_state: account?.backfill_state ?? 'pending',
        backfill_done: account?.backfill_done ?? 0,
        backfill_total: account?.backfill_total ?? 0,
        last_sync_at: account?.last_sync_at ?? null,
        token_ok: tokenOk,
        seed_state: readSeedState(ctx),
        ...(state.activeFlow ? { flow_pending: true } : {}),
        ...(state.lastConnectError ? { last_connect_error: state.lastConnectError } : {}),
        ...(account?.last_error ? { last_error: account.last_error } : {}),
      }
    },
  },

  connect_disconnect: {
    label: 'Disconnect Gmail',
    description: 'Delete the stored OAuth tokens. The local mail mirror is kept.',
    audience: ['ui'],
    inputSchema: objectSchema({}),
    async execute(ctx) {
      try {
        await ctx.secrets.delete('google_oauth_tokens')
      } catch (err) {
        return { error: `Could not delete tokens: ${err.message}` }
      }
      state.activeFlow = null
      state.lastConnectError = null
      return { ok: true }
    },
  },

  ui_inbox: {
    label: 'Inbox listing',
    description: 'Thread rows for list rendering (FTS when query); the drafts tab reads the local drafts table.',
    audience: ['ui'],
    inputSchema: objectSchema(
      {
        tab: { type: 'string', enum: ['inbox', 'all', 'sent', 'drafts'] },
        query: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      ['tab'],
    ),
    async execute(ctx, input) {
      const store = getStore()
      const account = store.getAccount(ACCOUNT_ID)
      if (!account) return NOT_CONNECTED
      const tab = ['inbox', 'all', 'sent', 'drafts'].includes(input.tab) ? input.tab : 'inbox'
      const limit = Math.max(1, Math.min(200, Math.floor(Number(input.limit) || 50)))
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0))
      if (tab === 'drafts') {
        const drafts = store
          .listDrafts({})
          .filter((d) => d.state !== 'discarded')
          .slice(offset, offset + limit)
        return { tab, drafts: drafts.map(draftMeta), stale: isStale(account) }
      }
      const threads = store.searchThreads({
        accountId: ACCOUNT_ID,
        tab,
        query: typeof input.query === 'string' && input.query !== '' ? input.query : undefined,
        limit,
        offset,
      })
      return { tab, threads: threads.map(threadRow), stale: isStale(account) }
    },
  },

  ui_thread: {
    label: 'Thread view',
    description: 'A thread with its full messages and any local drafts docked on it.',
    audience: ['ui'],
    inputSchema: objectSchema({ thread_id: { type: 'string' } }, ['thread_id']),
    async execute(ctx, input) {
      const store = getStore()
      const account = store.getAccount(ACCOUNT_ID)
      if (!account) return NOT_CONNECTED
      const thread = store.getThread(input.thread_id)
      if (!thread) return { error: `Unknown thread: ${input.thread_id}` }
      const messages = store.getThreadMessages(thread.id).map((m) => publicMessage(m))
      const drafts = store
        .listDrafts({})
        .filter((d) => d.thread_id === thread.id && d.state !== 'discarded')
        .map(draftMeta)
      return { thread: threadRow(thread), messages, drafts, stale: isStale(account) }
    },
  },

  ui_draft: {
    label: 'Draft studio state',
    description:
      'A draft with its body, the pending proposal (all hunks, intent, origin, dropped count), and revision metadata for the History view.',
    audience: ['ui'],
    inputSchema: objectSchema({ draft_id: { type: 'string' } }, ['draft_id']),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      return {
        draft: draftMeta(draft),
        body: draftBody(draft),
        pending_proposal: pendingProposalView('draft', draft.id),
        revisions: store.listRevisions(draft.id).map((r) => ({
          id: r.id,
          seq: r.seq,
          source: r.source,
          proposal_id: r.proposal_id,
          hunk_id: r.hunk_id,
          created_at: r.created_at,
        })),
      }
    },
  },

  ui_voices: {
    label: 'Voices & learning state',
    description:
      'Voices with pending voice proposals, survival/untouched metrics, and recent rejection-comment lessons.',
    audience: ['ui'],
    inputSchema: objectSchema({}),
    async execute(ctx) {
      const store = getStore()
      const voices = store.listVoices({ archived: false }).map(publicVoice)
      const archived = store.listVoices({ archived: true }).map(publicVoice)
      const pendingProposals = voices
        .map((v) => {
          const view = pendingProposalView('voice', v.id)
          return view ? { voice_id: v.id, ...view } : null
        })
        .filter(Boolean)
      const lessons = store
        .listProvenance({})
        .filter((e) => e.kind === 'hunk_rejected')
        .map((e) => parseJson(e.payload_json, {}))
        .filter((p) => typeof p.comment === 'string' && p.comment !== '')
        .slice(-10)
        .reverse()
        .map((p) => p.comment)
      return {
        voices,
        archived_voices: archived,
        pending_proposals: pendingProposals,
        metrics: store.voiceMetrics(),
        lessons,
        seed_state: readSeedState(ctx),
      }
    },
  },

  draft_edit: {
    label: 'Edit draft body',
    description:
      'Write a new human_edit revision. Stale-write protected: pass the base_revision_id the editor loaded; on mismatch returns {conflict, current}. Runs the re-anchor pass over pending hunks.',
    audience: ['ui'],
    inputSchema: objectSchema(
      {
        draft_id: { type: 'string' },
        body: { type: 'string' },
        base_revision_id: { type: ['string', 'null'] },
      },
      ['draft_id', 'body'],
    ),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      if (draft.state === 'sent' || draft.state === 'discarded') {
        return { error: `Draft is ${draft.state} and can no longer be edited.` }
      }
      const base = input.base_revision_id ?? null
      if ((draft.current_revision_id ?? null) !== base) {
        return {
          conflict: true,
          current: { revision_id: draft.current_revision_id, body: draftBody(draft) },
        }
      }
      const revision = store.appendRevision({
        draftId: draft.id,
        body: String(input.body ?? ''),
        source: 'human_edit',
      })
      store.appendProvenance({
        draftId: draft.id,
        kind: 'human_edit',
        payload: { revision_id: revision.id },
      })
      const pass = getProposals().reanchor('draft', draft.id)
      return { revision_id: revision.id, hunk_changes: pass.hunk_changes }
    },
  },

  hunk_accept: {
    label: 'Accept hunk',
    description: 'Apply one pending hunk: new proposal_accept revision, then the re-anchor pass.',
    audience: ['ui'],
    inputSchema: objectSchema({ hunk_id: { type: 'string' } }, ['hunk_id']),
    async execute(ctx, input) {
      return getProposals().acceptHunk(input.hunk_id)
    },
  },

  hunk_reject: {
    label: 'Reject hunk',
    description: 'Mark one pending hunk rejected; the optional comment is kept verbatim for the flywheel.',
    audience: ['ui'],
    inputSchema: objectSchema({ hunk_id: { type: 'string' }, comment: { type: 'string' } }, ['hunk_id']),
    async execute(ctx, input) {
      return getProposals().rejectHunk(input.hunk_id, input.comment)
    },
  },

  hunk_comment: {
    label: 'Comment on hunk',
    description:
      'Revise via comment: records the comment, then generates a new proposal from the comment plus the parent intent. The parent proposal is superseded when the new one survives validation.',
    audience: ['ui'],
    inputSchema: objectSchema({ hunk_id: { type: 'string' }, comment: { type: 'string' } }, [
      'hunk_id',
      'comment',
    ]),
    async execute(ctx, input) {
      const store = getStore()
      const comment = typeof input.comment === 'string' ? input.comment : ''
      if (comment.trim() === '') return { error: 'Pass a non-empty comment.' }
      const hunk = store.getHunk(input.hunk_id)
      if (!hunk) return { error: `Unknown hunk: ${input.hunk_id}` }
      if (hunk.status !== 'pending') return { error: `Hunk is ${hunk.status}, not pending.` }
      const parent = store.getProposal(hunk.proposal_id)
      if (!parent || parent.status !== 'pending') {
        return { error: 'The parent proposal is no longer pending.' }
      }
      if (parent.target_kind !== 'draft') {
        return {
          error:
            'Commenting is only supported on draft proposals — reject the hunk with a comment instead.',
        }
      }
      store.updateHunk(hunk.id, { comment })
      store.appendProvenance({
        draftId: parent.target_id,
        kind: 'hunk_commented',
        payload: { proposal_id: parent.id, hunk_id: hunk.id, comment },
      })
      // §4.6 (ratified): hunk_comment = propose(comment + parent intent),
      // origin inherited; validateAndCreate supersedes the pending parent.
      const scope = parseJson(parent.scope_json, null)
      return draftingFor(ctx).propose({
        draftId: parent.target_id,
        intent: `${comment}\n\n(Revising the earlier request: ${parent.intent_text})`,
        paragraphs: Array.isArray(scope) ? scope : undefined,
        origin: parent.origin,
      })
    },
  },

  proposal_dismiss: {
    label: 'Dismiss proposal',
    description:
      'Dismiss all pending hunks of a proposal. takeover: true records human_takeover ("I will write it myself") — the strongest flywheel signal.',
    audience: ['ui'],
    inputSchema: objectSchema({ proposal_id: { type: 'string' }, takeover: { type: 'boolean' } }, [
      'proposal_id',
    ]),
    async execute(ctx, input) {
      return getProposals().dismiss(input.proposal_id, { takeover: input.takeover === true })
    },
  },

  draft_approve: {
    label: 'Approve draft',
    description:
      'Human gate step 1: approve the exact revision reviewed. Any later change to the body revokes the approval.',
    audience: ['ui'],
    inputSchema: objectSchema({ draft_id: { type: 'string' }, revision_id: { type: 'string' } }, [
      'draft_id',
      'revision_id',
    ]),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      if (draft.state === 'sent' || draft.state === 'discarded') {
        return { error: `Draft is ${draft.state}.` }
      }
      if (!draft.current_revision_id || draft.current_revision_id !== input.revision_id) {
        return {
          error: 'The draft changed since you reviewed it — re-read before approving.',
          current_revision_id: draft.current_revision_id,
        }
      }
      const approvedAt = nowIso()
      store.updateDraft(draft.id, {
        state: 'approved',
        approved_revision_id: input.revision_id,
        approved_at: approvedAt,
        last_send_error: null,
      })
      store.appendProvenance({
        draftId: draft.id,
        kind: 'approved',
        payload: { revision_id: input.revision_id },
      })
      return { ok: true, state: 'approved', approved_revision_id: input.revision_id, approved_at: approvedAt }
    },
  },

  draft_send: {
    label: 'Send draft',
    description:
      'Human gate step 2: send the approved draft. Requires state approved and an unchanged approved revision. Assembles MIME (reply quote at send time), sends via Gmail, mirrors the sent message, and finalizes provenance.',
    audience: ['ui'],
    inputSchema: objectSchema(
      { draft_id: { type: 'string' }, include_quote: { type: 'boolean' } },
      ['draft_id'],
    ),
    async execute(ctx, input) {
      const store = getStore()
      const account = connectedAccount()
      if (!account) return NOT_CONNECTED
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      if (draft.state !== 'approved') {
        return { error: `Draft is ${draft.state} — approve it before sending.` }
      }
      if (!draft.approved_revision_id || draft.current_revision_id !== draft.approved_revision_id) {
        return { error: 'The draft changed after approval — review and approve it again.' }
      }
      const to = emailList(parseJson(draft.to_json, []))
      if (to.length === 0) return { error: 'The draft has no recipients.' }
      const bodyText = draftBody(draft)
      if (bodyText.trim() === '') return { error: 'The draft body is empty.' }

      // Reply threading + send-time quote from the replied-to mirrored
      // message (§7 — draft bodies stay clean prose; survival uses the clean
      // body, never the quoted assembly).
      const includeQuote = input.include_quote !== false
      let inReplyTo
      let references
      let quote
      if (draft.reply_to_message_id) {
        const original = store.getMessage(draft.reply_to_message_id)
        if (original) {
          inReplyTo = original.rfc822_message_id || undefined
          references = parseJson(original.references_json, [])
          if (includeQuote && original.body_text) {
            quote = {
              date: original.internal_date ? new Date(original.internal_date).toUTCString() : '',
              fromDisplay: original.from_name || original.from_email || 'they',
              bodyText: original.body_text,
            }
          }
        }
      }
      const threadGmailId = draft.thread_id ? store.getThread(draft.thread_id)?.gmail_id : undefined

      const mime = getMime()
      const raw = mime.encodeRaw(
        mime.buildMessage({
          from: account.email,
          to,
          cc: emailList(parseJson(draft.cc_json, [])),
          bcc: emailList(parseJson(draft.bcc_json, [])),
          subject: draft.subject ?? '',
          bodyText,
          ...(inReplyTo ? { inReplyTo, references } : {}),
          ...(quote ? { quote } : {}),
        }),
      )

      const { oauth, secrets } = await oauthFor(ctx)
      const gmail = gmailFor(ctx, oauth)
      let response
      try {
        response = await gmail.send(raw, threadGmailId)
      } catch (err) {
        store.updateDraft(draft.id, { state: 'send_failed', last_send_error: err.message })
        store.appendProvenance({
          draftId: draft.id,
          kind: 'send_failed',
          payload: { error: err.message },
        })
        await secrets.flush()
        return { error: `Send failed: ${err.message}` }
      }

      // Mirror the sent message locally right away. Prefer the real payload;
      // fall back to an optimistic row so the Sent tab is fresh either way.
      try {
        const full = await gmail.getMessage(response.id)
        store.upsertMessage(ACCOUNT_ID, gmail.parseMessage(full))
      } catch {
        store.upsertMessage(ACCOUNT_ID, {
          gmail_id: response.id,
          thread_gmail_id: response.threadId ?? threadGmailId ?? response.id,
          from_name: '',
          from_email: account.email,
          to_json: JSON.stringify(to.map((email) => ({ email, name: '' }))),
          subject: draft.subject ?? '',
          snippet: bodyText.slice(0, 120),
          body_text: bodyText,
          internal_date: Date.now(),
          is_unread: 0,
          is_from_me: 1,
          label_ids_json: JSON.stringify(response.labelIds ?? ['SENT']),
          fetched_at: nowIso(),
        })
      } finally {
        await secrets.flush()
      }

      // Sends row + survival + untouched + 'sent' provenance + state 'sent'.
      getProvenance().finalizeSend({
        draftId: draft.id,
        gmailMessageId: response.id,
        finalText: bodyText,
      })

      // Flywheel trigger: every FLYWHEEL_MIN_SENDS undistilled sends.
      let flywheelStarted = false
      if (store.undistilledSends().length >= FLYWHEEL_MIN_SENDS) {
        try {
          await startJob(ctx, 'flywheel')
          flywheelStarted = true
        } catch {
          /* already running or refused — next send retriggers */
        }
      }

      const sent = store.getDraft(draft.id)
      return {
        ok: true,
        state: sent.state,
        gmail_message_id: response.id,
        ...(flywheelStarted ? { flywheel_started: true } : {}),
      }
    },
  },

  draft_discard: {
    label: 'Discard draft',
    description: 'Mark a draft discarded. The revision history is kept.',
    audience: ['ui'],
    inputSchema: objectSchema({ draft_id: { type: 'string' } }, ['draft_id']),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      if (draft.state === 'sent') return { error: 'The draft was already sent.' }
      store.updateDraft(draft.id, { state: 'discarded' })
      store.appendProvenance({ draftId: draft.id, kind: 'discarded', payload: {} })
      return { ok: true, state: 'discarded' }
    },
  },

  draft_update_meta: {
    label: 'Update draft metadata',
    description:
      'Change recipients, subject, or the attached voice. Changing recipients or subject on an approved draft revokes the approval (the human reviewed different envelope data).',
    audience: ['ui'],
    inputSchema: objectSchema({
      draft_id: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      voice_id: { type: ['string', 'null'] },
    }, ['draft_id']),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      if (draft.state === 'sent' || draft.state === 'discarded') {
        return { error: `Draft is ${draft.state} and can no longer change.` }
      }
      const patch = {}
      let envelopeChanged = false
      if (Array.isArray(input.to)) {
        patch.to_json = JSON.stringify(emailList(input.to))
        envelopeChanged = true
      }
      if (Array.isArray(input.cc)) {
        patch.cc_json = JSON.stringify(emailList(input.cc))
        envelopeChanged = true
      }
      if (Array.isArray(input.bcc)) {
        patch.bcc_json = JSON.stringify(emailList(input.bcc))
        envelopeChanged = true
      }
      if (typeof input.subject === 'string') {
        patch.subject = input.subject
        envelopeChanged = true
      }
      let voiceChanged = false
      if ('voice_id' in input && input.voice_id !== draft.voice_id) {
        if (input.voice_id != null && input.voice_id !== '' && !store.getVoice(input.voice_id)) {
          return { error: `Unknown voice: ${input.voice_id}` }
        }
        patch.voice_id = input.voice_id || null
        voiceChanged = true
      }
      if (Object.keys(patch).length === 0) return { error: 'Nothing to update.' }

      // Defense in depth on the human gate: approval covered specific
      // recipients and subject; changing them reverts to composing.
      if (envelopeChanged && draft.state === 'approved') {
        patch.state = 'composing'
        store.appendProvenance({ draftId: draft.id, kind: 'approval_revoked', payload: { reason: 'meta_changed' } })
      }
      store.updateDraft(draft.id, patch)
      if (voiceChanged) {
        store.appendProvenance({
          draftId: draft.id,
          kind: 'voice_attached',
          payload: { voice_id: patch.voice_id },
        })
      }
      return { draft: draftMeta(store.getDraft(draft.id)) }
    },
  },

  voice_update: {
    label: 'Update voice',
    description:
      'Human edit of a voice: body_md writes a new voice revision (re-anchoring pending voice hunks); name, description, and archived patch the voice row.',
    audience: ['ui'],
    inputSchema: objectSchema({
      voice_id: { type: 'string' },
      body_md: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      archived: { type: 'boolean' },
    }, ['voice_id']),
    async execute(ctx, input) {
      const store = getStore()
      const voice = store.getVoice(input.voice_id)
      if (!voice) return { error: `Unknown voice: ${input.voice_id}` }
      const out = {}
      if (typeof input.body_md === 'string' && input.body_md !== voice.body_md) {
        const revision = store.appendVoiceRevision({
          voiceId: voice.id,
          body: input.body_md,
          source: 'human_edit',
        })
        out.revision_id = revision.id
        out.hunk_changes = getProposals().reanchor('voice', voice.id).hunk_changes
      }
      const patch = {}
      if (typeof input.name === 'string' && input.name.trim() !== '') patch.name = input.name
      if (typeof input.description === 'string') patch.description = input.description
      if (typeof input.archived === 'boolean') patch.archived = input.archived ? 1 : 0
      if (Object.keys(patch).length > 0) store.updateVoice(voice.id, patch)
      return { voice: publicVoice(store.getVoice(voice.id)), ...out }
    },
  },

  settings_get: {
    label: 'Read settings',
    description: 'Read the app settings.',
    audience: ['ui'],
    inputSchema: objectSchema({}),
    async execute() {
      const account = getStore().getAccount(ACCOUNT_ID)
      return { sync_window_days: account?.sync_window_days ?? 180 }
    },
  },

  settings_set: {
    label: 'Write settings',
    description: 'Update the app settings.',
    audience: ['ui'],
    inputSchema: objectSchema({ sync_window_days: { type: 'number' } }),
    async execute(ctx, input) {
      ensureAccount()
      if (typeof input.sync_window_days === 'number' && input.sync_window_days >= 1) {
        getStore().updateAccount(ACCOUNT_ID, {
          sync_window_days: Math.floor(input.sync_window_days),
        })
      }
      return { sync_window_days: getStore().getAccount(ACCOUNT_ID).sync_window_days }
    },
  },

  jobs_kick: {
    label: 'Start a job',
    description: 'Start one of the backend jobs (sync, backfill, seed_voices, flywheel).',
    audience: ['ui'],
    inputSchema: objectSchema({ job: { type: 'string', enum: JOB_IDS } }, ['job']),
    async execute(ctx, input) {
      if (!JOB_IDS.includes(input.job)) return { error: `Unknown job: ${input.job}` }
      try {
        const run = await startJob(ctx, input.job)
        return { started: true, ...(run && typeof run === 'object' ? { run } : {}) }
      } catch (err) {
        return { started: false, reason: err?.message ?? String(err) }
      }
    },
  },

  ui_propose: {
    label: 'Ask AI (studio)',
    description:
      "The studio's Ask-AI: proposes hunks with origin user_request; when the draft body is empty the intent becomes the first-draft instruction instead.",
    audience: ['ui'],
    inputSchema: objectSchema(
      {
        draft_id: { type: 'string' },
        intent: { type: 'string' },
        paragraphs: { type: 'array', items: { type: 'number' } },
      },
      ['draft_id', 'intent'],
    ),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      const drafting = draftingFor(ctx)
      if (draftBody(draft) === '') {
        return drafting.initialDraft({ draftId: draft.id, instruction: input.intent })
      }
      return drafting.propose({
        draftId: draft.id,
        intent: input.intent,
        paragraphs: input.paragraphs,
        origin: 'user_request',
      })
    },
  },

  revision_get: {
    label: 'Read revision',
    description: 'Read one full revision body for the History view.',
    audience: ['ui'],
    inputSchema: objectSchema({ revision_id: { type: 'string' } }, ['revision_id']),
    async execute(ctx, input) {
      const revision = getStore().getRevision(input.revision_id)
      if (!revision) return { error: `Unknown revision: ${input.revision_id}` }
      return { revision }
    },
  },

  draft_revert: {
    label: 'Revert draft',
    description: 'Restore an earlier revision as a new revision with source revert.',
    audience: ['ui'],
    inputSchema: objectSchema({ draft_id: { type: 'string' }, revision_id: { type: 'string' } }, [
      'draft_id',
      'revision_id',
    ]),
    async execute(ctx, input) {
      const store = getStore()
      const draft = store.getDraft(input.draft_id)
      if (!draft) return { error: `Unknown draft: ${input.draft_id}` }
      if (draft.state === 'sent' || draft.state === 'discarded') {
        return { error: `Draft is ${draft.state} and can no longer be edited.` }
      }
      const target = store.getRevision(input.revision_id)
      if (!target || target.draft_id !== draft.id) {
        return { error: `Unknown revision for this draft: ${input.revision_id}` }
      }
      const revision = store.appendRevision({
        draftId: draft.id,
        body: target.body_text,
        source: 'revert',
      })
      store.appendProvenance({
        draftId: draft.id,
        kind: 'human_edit',
        payload: { revision_id: revision.id, reverted_to: target.id, source: 'revert' },
      })
      const pass = getProposals().reanchor('draft', draft.id)
      return { revision_id: revision.id, body: target.body_text, hunk_changes: pass.hunk_changes }
    },
  },

  ui_mark: {
    label: 'Archive / read state',
    description:
      'Batch archive (INBOX) and read (UNREAD) writeback for a message or a whole thread, via Gmail modify plus local mirror update.',
    audience: ['ui'],
    inputSchema: objectSchema({
      thread_id: { type: 'string' },
      message_id: { type: 'string' },
      archive: { type: 'boolean' },
      read: { type: 'boolean' },
    }),
    async execute(ctx, input) {
      const add = []
      const remove = []
      if (input.archive === true) remove.push('INBOX')
      if (input.archive === false) add.push('INBOX')
      if (input.read === true) remove.push('UNREAD')
      if (input.read === false) add.push('UNREAD')
      if (add.length === 0 && remove.length === 0) return { error: 'Pass archive and/or read.' }
      return modifyLabelsOnTargets(ctx, input, add, remove)
    },
  },
}

// ---------------------------------------------------------------------------
// Agents — one mounted 'Mail' agent, allowlisted to exactly the named set.

const NAMED_TOOL_NAMES = [
  'mail.search',
  'mail.thread',
  'mail.message',
  'mail.labels',
  'mail.label',
  'mail.sync',
  'mail.drafts',
  'mail.draft.get',
  'mail.draft.create',
  'mail.draft.propose',
  'mail.voices',
]

export const agents = {
  mail: {
    // "Mail Agent", not "Mail" — the app's own sidebar row already carries
    // that label, and two identical labels are indistinguishable.
    name: 'Mail Agent',
    tools: NAMED_TOOL_NAMES,
    // Instructions read ONLY the precomputed kv snapshot (3 s budget) — never
    // the live SQLite mirror.
    instructions(ctx) {
      const snap = ctx.data.kv.get(SNAPSHOT_KEY)
      const mailbox = []
      if (!snap || typeof snap !== 'object') {
        mailbox.push(
          'No mailbox snapshot yet — the account is not connected or the first sync has not finished. Say so if asked about mail, and suggest opening the Mail app to connect Gmail.',
        )
      } else {
        mailbox.push(`Account: ${snap.email || 'connecting…'}`)
        mailbox.push(
          snap.backfill_state === 'done'
            ? `Mirror: ready, about ${snap.thread_count ?? 0} threads.`
            : `Mirror: initial backfill is ${snap.backfill_state ?? 'pending'} — results may be partial.`,
        )
        mailbox.push(`Last synced: ${snap.last_sync_at ?? 'never'}.`)
      }
      return [
        'You are Mail, the email agent for this workspace. You work on a local Gmail mirror.',
        '',
        '## Mailbox',
        ...mailbox,
        '',
        '## Tools',
        'Read tools (mail.search, mail.thread, mail.message, mail.labels, mail.drafts, mail.draft.get, mail.voices) never touch the network; they return mirror data with a stale flag. When results look stale, call mail.sync (it starts a background job) and tell the user freshness is on its way.',
        'mail.label changes Gmail labels (archive = remove INBOX, mark read = remove UNREAD).',
        'mail.draft.create starts a local draft — pass instruction to write the first body in the attached voice. mail.draft.propose suggests edits to an existing draft as reviewable hunks; you can never edit a non-empty draft directly.',
        '',
        '## The gate',
        'Only the human can accept hunks, approve a draft, or send. Never claim you sent or will send an email — you prepare drafts and proposals, the human reviews and sends them in the Mail app.',
      ].join('\n')
    },
  },
}
