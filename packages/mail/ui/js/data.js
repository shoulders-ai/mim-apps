// Data layer: tool discovery, call(), every backend call + shape
// normalization (the ONE file where CONTRACTS §3 payload shapes are
// touched), heartbeat timers (§5.7), and navigation/loaders.
//
// The SDK import is dynamic so this module stays importable under node
// (tests import view modules that import this file).

import { state, render, showToast } from './state.js'
import { debounce } from './utils.js'
import { normHunkChanges } from './hunks.js'

let _runtime = null
async function rt() {
  if (!_runtime) {
    const path = '/sdk/mim.js'
    const mod = await import(/* @vite-ignore */ path)
    _runtime = mod.runtime
  }
  return _runtime
}

// ── Tool discovery (CONTRACTS §3.2 — never hardcode the pkg_ hash) ──

const NAMED_KEYS = {
  'mail.search': 'search',
  'mail.thread': 'thread',
  'mail.message': 'message',
  'mail.labels': 'labels',
  'mail.label': 'label',
  'mail.sync': 'sync',
  'mail.drafts': 'drafts',
  'mail.draft.get': 'draft_get',
  'mail.draft.create': 'draft_create',
  'mail.draft.propose': 'draft_propose',
  'mail.voices': 'voices_list',
}

export async function discoverTools() {
  const runtime = await rt()
  const res = await runtime.call('package.capabilities.list', {})
  const entries = res?.tools || res?.capabilities || (Array.isArray(res) ? res : [])
  const map = {}
  for (const t of entries) {
    if (!t) continue
    const pid = t.packageId ?? t.package_id ?? t.package ?? t.pkg ?? null
    const name = t.publicName ?? t.public_name ?? t.name ?? null
    if (typeof name !== 'string') continue
    const isMail = pid === 'mail'
      || (pid == null && (name.startsWith('mail.') || /^pkg_[A-Za-z0-9]+__/.test(name)))
    if (!isMail) continue
    let key = t.exportKey ?? t.export_key ?? t.key ?? t.id ?? null
    if (!key || key === name) {
      if (NAMED_KEYS[name]) key = NAMED_KEYS[name]
      else {
        const m = /__([A-Za-z0-9_]+)$/.exec(name)
        if (m) key = m[1]
      }
    }
    if (key) map[key] = name
  }
  state.tools = map
}

// Every result is normalized to { ok, value, error } (§7.2).
export async function call(key, input = {}) {
  const name = state.tools[key]
  if (!name) return { ok: false, error: `Tool unavailable: ${key}` }
  try {
    const runtime = await rt()
    const value = await runtime.call('package.tools.execute', { name, input })
    if (value && typeof value === 'object' && typeof value.error === 'string' && value.error) {
      return { ok: false, error: value.error, value }
    }
    return { ok: true, value }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export async function setSecret(name, secret) {
  const runtime = await rt()
  return runtime.secrets.set(name, secret)
}

// ── Normalizers ──

export function parseAddressList(v) {
  let list = v
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { list = list ? [list] : [] }
  }
  if (!Array.isArray(list)) list = list ? [list] : []
  return list.map(item => {
    if (item && typeof item === 'object') {
      return { name: item.name || '', email: item.email || item.address || '' }
    }
    const s = String(item ?? '').trim()
    const m = /^(.*?)\s*<([^>]+)>$/.exec(s)
    if (m) return { name: m[1].replace(/^"|"$/g, ''), email: m[2] }
    return { name: '', email: s }
  }).filter(a => a.email || a.name)
}

export function addrDisplay(a) {
  return a.name || a.email
}

export function addrFull(a) {
  return a.name ? `${a.name} <${a.email}>` : a.email
}

function normThreadRow(raw) {
  const from = raw.from && typeof raw.from === 'object' ? raw.from : null
  return {
    id: raw.id,
    gmailId: raw.gmail_id ?? raw.gmailId ?? '',
    subject: raw.subject ?? '',
    snippet: raw.snippet ?? '',
    fromName: raw.from_name ?? from?.name ?? (typeof raw.from === 'string' ? raw.from : '') ?? '',
    fromEmail: raw.from_email ?? from?.email ?? '',
    to: parseAddressList(raw.to_json ?? raw.to ?? []),
    lastMessageAt: Number(raw.last_message_at ?? raw.date ?? 0) || 0,
    messageCount: Number(raw.message_count ?? 1) || 1,
    unread: !!(raw.is_unread ?? raw.unread),
    hasAttachments: !!(raw.has_attachments ?? raw.hasAttachments),
    kind: 'thread',
  }
}

function normDraftRow(raw) {
  return {
    id: raw.id,
    draftId: raw.id,
    threadId: raw.thread_id ?? null,
    to: parseAddressList(raw.to_json ?? raw.to ?? []),
    subject: raw.subject ?? '',
    snippet: raw.snippet ?? String(raw.body ?? '').split('\n')[0] ?? '',
    state: raw.state ?? 'composing',
    updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : Number(raw.updatedAt) || 0,
    kind: 'draft',
  }
}

function normMessage(raw) {
  return {
    id: raw.id,
    gmailId: raw.gmail_id ?? '',
    threadId: raw.thread_id ?? null,
    fromName: raw.from_name ?? '',
    fromEmail: raw.from_email ?? '',
    to: parseAddressList(raw.to_json ?? raw.to ?? []),
    cc: parseAddressList(raw.cc_json ?? raw.cc ?? []),
    subject: raw.subject ?? '',
    snippet: raw.snippet ?? '',
    body: raw.body_text ?? raw.body ?? '',
    date: Number(raw.internal_date ?? raw.date ?? 0) || 0,
    unread: !!raw.is_unread,
    isFromMe: !!raw.is_from_me,
    hasAttachments: !!raw.has_attachments,
  }
}

function normDraft(raw) {
  if (!raw) return null
  return {
    id: raw.id,
    threadId: raw.thread_id ?? null,
    replyToMessageId: raw.reply_to_message_id ?? null,
    to: parseAddressList(raw.to_json ?? raw.to ?? []),
    cc: parseAddressList(raw.cc_json ?? raw.cc ?? []),
    bcc: parseAddressList(raw.bcc_json ?? raw.bcc ?? []),
    subject: raw.subject ?? '',
    voiceId: raw.voice_id ?? null,
    state: raw.state ?? 'composing',
    currentRevisionId: raw.current_revision_id ?? null,
    lastSendError: raw.last_send_error ?? '',
  }
}

function normProposal(raw) {
  if (!raw) return null
  return {
    id: raw.id ?? raw.proposal_id,
    origin: raw.origin ?? 'user_request',
    intent: raw.intent_text ?? raw.intent ?? '',
    dropped: Number(raw.dropped ?? raw.dropped_count ?? 0) || 0,
    hunks: (raw.hunks || []).map(h => ({
      id: h.id,
      original_text: h.original_text ?? '',
      proposed_text: h.proposed_text ?? '',
      note: h.note ?? '',
      status: h.status ?? 'pending',
    })),
  }
}

function normRevision(raw) {
  return {
    id: raw.id,
    seq: Number(raw.seq ?? 0) || 0,
    source: raw.source ?? '',
    createdAt: raw.created_at ?? '',
  }
}

// ── Connection ──

let lastTokenOk = true

export async function refreshConn() {
  const r = await call('connect_status')
  if (!r.ok) {
    state.conn.syncError = state.conn.connected ? r.error : ''
    return r
  }
  const v = r.value || {}
  state.conn.connected = !!v.connected
  state.conn.email = v.email || ''
  state.conn.tokenOk = v.token_ok !== false
  state.conn.backfill = {
    state: v.backfill_state || 'pending',
    done: Number(v.backfill_done ?? 0) || 0,
    total: Number(v.backfill_total ?? 0) || 0,
  }
  state.conn.lastSyncAt = v.last_sync_at ?? null
  state.conn.seedState = v.seed_state || 'none'

  const reconnect = state.conn.connected && !state.conn.tokenOk
  if (reconnect && state.banner !== 'reconnect') {
    state.banner = 'reconnect'
    announce('Gmail connection expired — your mail is paused.', true)
  } else if (!reconnect && state.banner === 'reconnect') {
    state.banner = null
    state.reconnect = { connecting: false, waiting: false, consentUrl: '', deadline: 0, error: '' }
  }
  lastTokenOk = state.conn.tokenOk
  ensureFastPoll()
  return r
}

// ── Inbox ──

export async function loadInbox({ reset = false, refresh = false } = {}) {
  const inbox = state.inbox
  if (reset) {
    inbox.threads = []
    inbox.offset = 0
    inbox.exhausted = false
    inbox.loaded = false
  }
  const limit = refresh ? Math.max(50, inbox.threads.length) : 50
  const offset = refresh ? 0 : inbox.offset
  inbox.loading = true
  const r = await call('ui_inbox', {
    tab: inbox.tab,
    query: inbox.query || undefined,
    limit,
    offset,
  })
  inbox.loading = false
  if (!r.ok) {
    inbox.error = r.error
    inbox.loaded = true
    return r
  }
  inbox.error = ''
  const v = r.value || {}
  const rawRows = v.threads || v.rows || v.drafts || v.items || []
  const rows = inbox.tab === 'drafts' ? rawRows.map(normDraftRow) : rawRows.map(normThreadRow)
  if (refresh || offset === 0) inbox.threads = rows
  else inbox.threads = inbox.threads.concat(rows)
  if (!refresh) {
    inbox.offset = offset + rows.length
    if (rows.length < limit) inbox.exhausted = true
  }
  inbox.loaded = true
  if (!inbox.selectedId && rows.length) inbox.selectedId = rows[0].id
  return r
}

export async function loadMore() {
  if (state.inbox.exhausted || state.inbox.loading) return
  await loadInbox()
  render()
}

// ── Thread ──

export async function loadThread(threadId, { keepExpanded = false } = {}) {
  const r = await call('ui_thread', { thread_id: threadId })
  if (!r.ok) {
    state.thread.error = r.error
    return r
  }
  const v = r.value || {}
  state.thread.error = ''
  state.thread.thread = v.thread ? normThreadRow(v.thread) : state.thread.thread
  state.thread.messages = (v.messages || []).map(normMessage)
  state.thread.drafts = (v.drafts || [])
    .map(normDraft)
    .filter(d => d && d.state !== 'discarded' && d.state !== 'sent')
  if (!keepExpanded || state.thread.expanded.size === 0) {
    const last = state.thread.messages[state.thread.messages.length - 1]
    state.thread.expanded = new Set(last ? [last.id] : [])
    state.thread.unquoted = new Set()
  }
  return r
}

// ── Navigation ──

function markThreadRead(threadId) {
  markRead(threadId)
}

export async function openThread(threadId, { markRead = true } = {}) {
  // A studio open on another thread must not follow the navigation.
  if (state.studio.open && state.studio.draft && state.studio.draft.threadId !== threadId) {
    await flushEdits()
    state.studio.open = false
    state.studio.draft = null
  }
  state.route = { view: 'thread', threadId, draftId: null }
  state.inbox.selectedId = threadId
  const row = state.inbox.threads.find(t => t.id === threadId)
  if (row && row.unread && markRead) {
    row.unread = false
    markThreadRead(threadId) // optimistic, fire & reconcile silently
  }
  state.thread = { thread: row || null, messages: [], drafts: [], expanded: new Set(), unquoted: new Set(), error: '' }
  render()
  const scroll = typeof document !== 'undefined' ? document.getElementById('threadScroll') : null
  if (scroll) scroll.scrollTop = 0
  await loadThread(threadId)
  render()
}

export function backToList() {
  state.route = { view: 'inbox', threadId: null, draftId: null }
  render()
}

export function openVoices() {
  state.route = { view: 'voices', threadId: null, draftId: null }
  render()
  loadVoices().then(render)
}

export function openInbox() {
  state.route = { view: 'inbox', threadId: null, draftId: null }
  render()
}

// ── Drafts / studio ──

export async function loadDraft(draftId) {
  const r = await call('ui_draft', { draft_id: draftId })
  if (!r.ok) return r
  const v = r.value || {}
  const s = state.studio
  s.draft = normDraft(v.draft)
  s.body = String(v.body ?? '')
  s.baseRevisionId = s.draft?.currentRevisionId ?? v.revision_id ?? null
  s.proposal = normProposal(v.pending_proposal)
  s.revisions = (v.revisions || v.revision_list || []).map(normRevision)
  s.dirty = false
  s.demoted = new Set()
  s.stale = []
  return r
}

export async function createDraft(fields = {}) {
  const r = await call('draft_create', fields)
  if (!r.ok) return r
  const v = r.value || {}
  return { ok: true, value: { draft: normDraft(v.draft), body: String(v.body ?? '') } }
}

// Debounced human-edit ledger write (§3.4.1): 800ms + flush on blur and
// before any body-reading tool call.
let editInFlight = null

async function sendDraftEdit() {
  const s = state.studio
  if (!s.draft) return
  const payload = {
    draft_id: s.draft.id,
    body: s.body,
    base_revision_id: s.baseRevisionId,
  }
  s.dirty = false
  editInFlight = (async () => {
    const r = await call('draft_edit', payload)
    if (!r.ok) {
      s.opError = r.error
      render()
      return
    }
    const v = r.value || {}
    if (v.conflict) {
      await loadDraft(s.draft.id)
      showToast('Draft changed elsewhere — reloaded')
      render()
      return
    }
    if (v.revision_id) s.baseRevisionId = v.revision_id
    applyHunkChanges(v.hunk_changes)
    render()
  })()
  await editInFlight
}

export const draftEditDebounced = debounce(() => { sendDraftEdit() }, 800)

export function queueDraftEdit() {
  state.studio.dirty = true
  draftEditDebounced()
}

export async function flushEdits() {
  if (draftEditDebounced.pending()) draftEditDebounced.flush()
  if (editInFlight) {
    try { await editInFlight } catch {}
  }
}

export function applyHunkChanges(changes) {
  const s = state.studio
  if (!s.proposal) return
  const { stale, pending } = normHunkChanges(changes)
  for (const h of s.proposal.hunks) {
    if (stale.includes(h.id)) {
      h.status = 'stale'
      if (!s.stale.find(x => x.id === h.id)) s.stale.push({ id: h.id })
      s.demoted.delete(h.id)
      if (s.activeHunkId === h.id) s.activeHunkId = null
    } else if (pending.includes(h.id)) {
      s.demoted.delete(h.id) // still valid — re-tint
    }
  }
}

export async function acceptHunk(hunkId) {
  const r = await call('hunk_accept', { hunk_id: hunkId })
  if (!r.ok) return r
  const v = r.value || {}
  return { ok: true, value: { revisionId: v.revision_id ?? null, body: v.body != null ? String(v.body) : null, hunkChanges: v.hunk_changes } }
}

export async function rejectHunk(hunkId, comment) {
  return call('hunk_reject', comment ? { hunk_id: hunkId, comment } : { hunk_id: hunkId })
}

export async function commentHunk(hunkId, comment) {
  const r = await call('hunk_comment', { hunk_id: hunkId, comment })
  if (!r.ok) return r
  return { ok: true, value: normProposeResult(r.value) }
}

export async function dismissProposal(proposalId, takeover = false) {
  return call('proposal_dismiss', takeover ? { proposal_id: proposalId, takeover: true } : { proposal_id: proposalId })
}

function normProposeResult(v) {
  const value = v || {}
  if (Array.isArray(value.hunks) && value.hunks.length > 0) {
    return {
      kind: 'proposal',
      proposal: normProposal({
        id: value.proposal_id ?? value.id,
        origin: value.origin ?? 'user_request',
        intent_text: value.intent_text ?? value.intent ?? '',
        dropped: value.dropped ?? 0,
        hunks: value.hunks,
      }),
    }
  }
  if (value.body != null || value.draft) {
    return { kind: 'body', body: String(value.body ?? ''), draft: normDraft(value.draft) }
  }
  return { kind: 'empty', dropped: Number(value.dropped ?? 0) || 0, proposalId: value.proposal_id ?? null }
}

export async function proposeIntent(draftId, intent, paragraphs = null) {
  const input = { draft_id: draftId, intent }
  if (paragraphs && paragraphs.length) input.paragraphs = paragraphs
  // ui_propose carries origin 'user_request' (supervisor ruling); fall back
  // to the named propose tool if a stale backend predates it.
  const key = state.tools.ui_propose ? 'ui_propose' : 'draft_propose'
  const r = await call(key, input)
  if (!r.ok) return r
  return { ok: true, value: normProposeResult(r.value) }
}

export async function approveDraft(draftId, revisionId) {
  return call('draft_approve', { draft_id: draftId, revision_id: revisionId })
}

export async function sendDraft(draftId, includeQuote) {
  const r = await call('draft_send', { draft_id: draftId, include_quote: includeQuote })
  if (!r.ok) refreshConn().then(render) // token may have died mid-send (§5.6)
  return r
}

export async function discardDraft(draftId) {
  return call('draft_discard', { draft_id: draftId })
}

export async function updateDraftMeta(draftId, patch) {
  return call('draft_update_meta', { draft_id: draftId, ...patch })
}

export async function getRevision(revisionId) {
  const r = await call('revision_get', { revision_id: revisionId })
  if (!r.ok) return r
  const v = r.value || {}
  return { ok: true, value: { body: String(v.body_text ?? v.body ?? '') } }
}

export async function revertDraft(draftId, revisionId) {
  return call('draft_revert', { draft_id: draftId, revision_id: revisionId })
}

// ── Archive / read state (ui_mark; `label` is the pre-ruling fallback) ──

function mark(threadId, input, labelFallback) {
  if (state.tools.ui_mark) return call('ui_mark', { thread_id: threadId, ...input })
  return call('label', { thread_id: threadId, ...labelFallback })
}

export async function archiveThread(threadId) {
  return mark(threadId, { archive: true }, { remove: ['INBOX'] })
}

export async function unarchiveThread(threadId) {
  return mark(threadId, { archive: false }, { add: ['INBOX'] })
}

export async function markRead(threadId) {
  return mark(threadId, { read: true }, { remove: ['UNREAD'] })
}

export async function markUnread(threadId) {
  return mark(threadId, { read: false }, { add: ['UNREAD'] })
}

// ── Voices ──

export async function loadVoices() {
  const r = await call('ui_voices')
  if (!r.ok) {
    state.voices.error = r.error
    state.voices.loaded = true
    return r
  }
  const v = r.value || {}
  state.voices.error = ''
  const proposals = (v.proposals || v.pending_proposals || []).map(normProposal)
  const voices = (v.voices || []).map(raw => ({
    id: raw.id,
    name: raw.name ?? '',
    description: raw.description ?? '',
    bodyMd: String(raw.body_md ?? raw.bodyMd ?? ''),
    archived: !!raw.archived,
    proposal: null,
  }))
  for (const p of proposals) {
    const raw = (v.proposals || v.pending_proposals || []).find(x => (x.id ?? x.proposal_id) === p.id)
    const targetId = raw?.target_id ?? raw?.voice_id ?? null
    const voice = voices.find(x => x.id === targetId)
    if (voice) voice.proposal = p
  }
  // Proposals may also arrive inline on the voice rows.
  for (const raw of v.voices || []) {
    if (raw.pending_proposal) {
      const voice = voices.find(x => x.id === raw.id)
      if (voice) voice.proposal = normProposal(raw.pending_proposal)
    }
  }
  const m = v.metrics || {}
  state.voices.list = voices.filter(x => !x.archived)
  state.voices.hasPending = voices.some(x => x.proposal)
  state.voices.metrics = {
    perVoice: (m.per_voice || []).map(row => ({
      voiceId: row.voice_id,
      scoredSends: Number(row.scored_sends ?? 0) || 0,
      survivalTrend: (row.survival_trend || []).map(pt => ({ week: pt.week, mean: Number(pt.mean ?? 0) || 0 })),
      untouchedRate: Number(row.untouched_rate ?? 0) || 0,
    })),
    funnel: {
      drafts: Number(m.funnel?.drafts ?? 0) || 0,
      sent: Number(m.funnel?.sent ?? 0) || 0,
      untouched: Number(m.funnel?.sent_untouched ?? m.funnel?.untouched ?? 0) || 0,
    },
  }
  state.voices.lessons = (m.lessons || v.lessons || []).map(l => {
    if (typeof l === 'string') return { comment: l, at: null }
    return { comment: l.comment ?? l.text ?? '', at: l.created_at ?? l.at ?? null }
  }).filter(l => l.comment)
  if (!state.voices.activeId && state.voices.list.length) state.voices.activeId = state.voices.list[0].id
  const active = state.voices.list.find(x => x.id === state.voices.activeId)
  if (active) {
    state.voices.body = active.bodyMd
    state.voices.proposal = active.proposal
  }
  state.voices.loaded = true
  return r
}

let voiceUpdateInFlight = null

async function sendVoiceUpdate() {
  const vs = state.voices
  const voice = vs.list.find(x => x.id === vs.activeId)
  if (!voice) return
  voiceUpdateInFlight = (async () => {
    const r = await call('voice_update', { voice_id: voice.id, body_md: vs.body })
    if (!r.ok) {
      vs.error = r.error
      render()
    } else {
      voice.bodyMd = vs.body
    }
  })()
  await voiceUpdateInFlight
}

export const voiceEditDebounced = debounce(() => { sendVoiceUpdate() }, 800)

export async function flushVoiceEdits() {
  if (voiceEditDebounced.pending()) voiceEditDebounced.flush()
  if (voiceUpdateInFlight) {
    try { await voiceUpdateInFlight } catch {}
  }
}

export async function updateVoiceMeta(voiceId, patch) {
  return call('voice_update', { voice_id: voiceId, ...patch })
}

// ── Settings / jobs / connect ──

export async function getSettings() {
  const r = await call('settings_get')
  if (r.ok) {
    state.settings.syncWindowDays = Number(r.value?.sync_window_days ?? r.value?.syncWindowDays ?? 0) || null
  }
  return r
}

export async function setSyncWindow(days) {
  return call('settings_set', { sync_window_days: days })
}

export async function kickJob(job) {
  const r = await call('jobs_kick', { job })
  if (!r.ok) refreshConn().then(render)
  return r
}

export async function connectStart() {
  const r = await call('connect_start')
  if (!r.ok) return r
  return { ok: true, value: { consentUrl: r.value?.consent_url ?? r.value?.consentUrl ?? '' } }
}

export async function disconnect() {
  return call('connect_disconnect')
}

// ── aria-live ──

export function announce(msg, assertive = false) {
  if (typeof document === 'undefined') return
  const el = document.getElementById(assertive ? 'liveAssertive' : 'livePolite')
  if (!el) return
  el.textContent = ''
  requestAnimationFrame(() => { el.textContent = msg })
}

// ── Heartbeat (§5.7) ──

let mainTimer = null
let fastTimer = null
let refetchTimer = null
let announcedBackfillDone = false

export function startHeartbeat() {
  stopHeartbeat()
  mainTimer = setInterval(() => { cycle() }, 75000)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onWindowFocus)
  ensureFastPoll()
}

export function stopHeartbeat() {
  if (mainTimer) clearInterval(mainTimer)
  if (fastTimer) clearInterval(fastTimer)
  if (refetchTimer) clearTimeout(refetchTimer)
  mainTimer = fastTimer = refetchTimer = null
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('focus', onWindowFocus)
}

function onVisibility() {
  if (!document.hidden) cycle()
}

function onWindowFocus() {
  refreshConn().then(render)
}

async function cycle() {
  if (document.hidden) return
  if (!state.conn.connected) {
    await refreshConn()
    render()
    return
  }
  // Incremental sync only makes sense once the backfill is done; while it
  // runs, the fast poll owns freshness, and a pending backfill gets kicked.
  const bf = state.conn.backfill.state
  if (bf !== 'running') {
    const kick = await call('jobs_kick', { job: bf === 'done' ? 'sync' : 'backfill' })
    if (!kick.ok && state.conn.tokenOk) state.conn.syncError = kick.error
    else if (kick.ok) state.conn.syncError = ''
  }
  await refreshConn()
  render()
  clearTimeout(refetchTimer)
  refetchTimer = setTimeout(() => { refetchActive() }, 4000)
}

export function ensureFastPoll() {
  const running = state.conn.backfill.state === 'running'
  if (running && !fastTimer) {
    announcedBackfillDone = false
    announce('Mail sync started') // state changes only — never per-count ticks
    fastTimer = setInterval(async () => {
      if (document.hidden) return
      await refreshConn()
      await refetchActive()
    }, 2500)
  } else if (!running && fastTimer) {
    clearInterval(fastTimer)
    fastTimer = null
    if (!announcedBackfillDone && state.conn.backfill.state === 'done') {
      announcedBackfillDone = true
      announce('Mail sync complete')
    }
  }
}

export async function refetchActive() {
  if (!state.conn.connected) return
  const view = state.route.view
  if (view === 'inbox' || view === 'thread') {
    await loadInbox({ refresh: true })
    if (view === 'thread' && state.route.threadId) {
      await loadThread(state.route.threadId, { keepExpanded: true })
    }
    await refreshStudioProposal()
  } else if (view === 'voices') {
    await loadVoices()
  }
  render()
}

// A chat agent can create a proposal against the open draft at any time.
// Adopt it in the background — §5.2: header + tints appear, aria-live
// polite announces, focus is NEVER stolen. Adoption is conservative: only
// when the user has no local edit in flight, no pending proposal of their
// own, and the server body matches what they see (anything else is the
// draft_edit/conflict path's job).
export async function refreshStudioProposal() {
  const s = state.studio
  if (!s.open || !s.draft || s.dirty || s.confirm) return
  if (draftEditDebounced.pending()) return
  const r = await call('ui_draft', { draft_id: s.draft.id })
  if (!r.ok) return
  const v = r.value || {}
  s.revisions = (v.revisions || v.revision_list || []).map(normRevision)
  const server = normProposal(v.pending_proposal)
  const localId = s.proposal?.id ?? null
  if (!server || server.id === localId || localId !== null) return
  if (String(v.body ?? '') !== s.body) return
  s.proposal = server
  s.demoted = new Set()
  s.stale = []
  s.activeHunkId = null
  const n = server.hunks.filter(h => h.status === 'pending').length
  if (n > 0) announce(`${n} change${n === 1 ? '' : 's'} proposed`)
}

export async function manualRefresh() {
  if (state.refreshing) return
  state.refreshing = true
  render()
  await call('jobs_kick', { job: 'sync' })
  await refreshConn()
  await refetchActive()
  state.refreshing = false
  render()
}

export async function retrySync() {
  state.conn.syncError = ''
  render()
  const job = state.conn.backfill.state === 'done' ? 'sync' : 'backfill'
  const r = await kickJob(job)
  if (!r.ok) state.conn.syncError = r.error
  await refreshConn()
  render()
}

// ── Boot (§5.7) ──

export async function boot() {
  try {
    await discoverTools()
  } catch (err) {
    state.route.view = 'onboarding'
    state.onboarding.error = `Runtime unavailable: ${err?.message || err}`
    render()
    return
  }
  await refreshConn()
  state.route = {
    view: state.conn.connected ? 'inbox' : 'onboarding',
    threadId: null,
    draftId: null,
  }
  render()
  if (state.conn.connected) {
    getSettings()
    await loadInbox({ reset: true })
    render()
  }
  startHeartbeat()
}
