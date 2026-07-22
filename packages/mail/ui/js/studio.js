// Drafting studio (UX-SPEC §3.4): meta line, voice select, sticky proposal
// header, the two-layout editor with the hunk layer, Ask-AI, footer, and
// the approve → confirm card → send state machine.

import { state, render, showToast, openMenu, closeMenus } from './state.js'
import { escapeHtml, escapeAttr, qs, fmtTime } from './utils.js'
import { icon } from './icons.js'
import { mountEditor, splitParagraphs } from './editor.js'
import {
  locateHunks, firstPending, nextActive, hunkIdsInParagraph,
  applyHunkLocal, stripHtml,
} from './hunks.js'
import * as data from './data.js'

let ed = null
let rootEl = null
let builtFor = null
let vms = []
let unanchored = []
let confirmOpenedAt = 0
let confirmFocused = false
let noteTimer = null
let commentValue = ''
let sendGuardTimer = null

// ── Send-gate helpers (pure, tested in studio.confirm.test.mjs) ──

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Every address across To/Cc/Bcc, bucketed by whether it can actually
// receive mail. The confirm card, footer, and primaryAction all gate on
// this — the send gate must be beyond reproach.
export function validRecipients(draft) {
  const valid = []
  const invalid = []
  for (const field of ['to', 'cc', 'bcc']) {
    for (const addr of draft?.[field] ?? []) {
      if (EMAIL_RE.test(addr.email)) valid.push(addr)
      else invalid.push(addr)
    }
  }
  return { valid, invalid }
}

// ⌘⏎ landing inside the anti-double-fire window defers the send by the
// remaining guard time instead of dropping the press. 0 once past it.
export function sendGuardDelay(elapsedMs, guardMs = 250) {
  const remaining = guardMs - elapsedMs
  return remaining > 0 ? remaining : 0
}

// ── Open paths ──

export async function openCompose() {
  await data.flushEdits() // don't drop a pending edit from an open studio
  const r = await data.createDraft({})
  if (!r.ok) {
    showToast(`Couldn’t create a draft — ${r.error}`)
    return
  }
  state.route = { view: 'thread', threadId: null, draftId: r.value.draft.id }
  resetStudioState()
  state.studio.open = true
  state.studio.draft = r.value.draft
  state.studio.body = r.value.body
  state.studio.baseRevisionId = r.value.draft.currentRevisionId
  state.studio.metaExpanded = true
  render()
  // Focus lands in the To chip input (§5.2).
  requestAnimationFrame(() => qs('#metaTo')?.focus())
}

export async function openReply() {
  const existing = state.thread.drafts[0]
  if (existing) {
    await openDraft(existing.id)
    return
  }
  const msgs = state.thread.messages
  const last = msgs[msgs.length - 1]
  if (!last) return
  const r = await data.createDraft({ reply_to_message_id: last.id, thread_id: state.route.threadId })
  if (!r.ok) {
    showToast(`Couldn’t create a draft — ${r.error}`)
    return
  }
  resetStudioState()
  state.studio.open = true
  state.studio.draft = r.value.draft
  state.studio.body = r.value.body
  state.studio.baseRevisionId = r.value.draft.currentRevisionId
  state.route.draftId = r.value.draft.id
  state.thread.drafts = [r.value.draft, ...state.thread.drafts]
  render()
  requestAnimationFrame(() => ed?.focusEnd())
}

export async function openDraft(draftId, { focusStudio = true } = {}) {
  await data.flushEdits()
  resetStudioState()
  state.studio.open = true
  state.route.view = 'thread'
  state.route.draftId = draftId
  const r = await data.loadDraft(draftId)
  if (!r.ok) {
    state.studio.open = false
    showToast(`Couldn’t open the draft — ${r.error}`)
    render()
    return
  }
  if (!state.route.threadId && state.studio.draft?.threadId) {
    state.route.threadId = state.studio.draft.threadId
    data.loadThread(state.route.threadId).then(render)
  }
  if (!state.studio.draft?.to?.length && !state.studio.draft?.threadId) state.studio.metaExpanded = true
  render()
  if (!focusStudio) return
  requestAnimationFrame(() => {
    // Pending proposal → review is the task: focus the first strip (§5.2).
    if (liveVms().length > 0) ed?.focusStrip()
    else ed?.focusEnd()
  })
}

function resetStudioState() {
  const s = state.studio
  s.open = false
  s.draft = null
  s.body = ''
  s.baseRevisionId = null
  s.dirty = false
  s.metaExpanded = false
  s.revisions = []
  s.proposal = null
  s.activeHunkId = null
  s.demoted = new Set()
  s.stale = []
  s.askAi = { text: '', scope: null, pending: false }
  s.confirm = null
  s.includeQuote = true
  s.commentFor = null
  s.revisingFor = null
  s.note = ''
  s.proposeError = ''
  s.opError = ''
  s.generating = false
  s.history = { selectedId: null, body: null, loading: false }
  s.discardArmed = false
  commentValue = ''
  confirmFocused = false
  lastConfirmKey = ''
  if (sendGuardTimer) {
    clearTimeout(sendGuardTimer)
    sendGuardTimer = null
  }
}

export function closeStudio() {
  resetStudioState()
  state.route.draftId = null
  destroyStudio()
}

export function destroyStudio() {
  if (ed) ed.destroy()
  ed = null
  if (rootEl) rootEl.remove()
  rootEl = null
  builtFor = null
}

// ── Mount / update ──

export function ensureStudio(host) {
  if (!state.studio.open || !state.studio.draft || !host) {
    destroyStudio()
    return
  }
  if (!rootEl || builtFor !== state.studio.draft.id) {
    destroyStudio()
    build()
  }
  if (rootEl.parentElement !== host) host.appendChild(rootEl)
  update()
}

function build() {
  builtFor = state.studio.draft.id
  rootEl = document.createElement('section')
  rootEl.className = 'studio'
  rootEl.id = 'studio'
  rootEl.tabIndex = -1
  rootEl.setAttribute('aria-label', 'Draft')
  rootEl.innerHTML = `
    <div id="stMeta"></div>
    <div class="st-head" id="stHead" hidden></div>
    <div class="st-generating" id="stGenerating" hidden>
      <div class="skel-line"></div><div class="skel-line"></div><div class="skel-line short"></div>
    </div>
    <div class="st-ed" id="stEditorHost"></div>
    <div class="st-stale" id="stStale" hidden></div>
    <div class="st-properr" id="stPropErr" hidden></div>
    <div class="st-operr" id="stOpErr" hidden></div>
    <div class="st-note" id="stNote" hidden></div>
    <div id="stConfirm"></div>
    <div class="st-footer" id="stFooter"></div>
    <span id="edTabHint" class="vh">While suggestions are pending, Tab moves between proposed changes; Esc leaves the editor.</span>`
  ed = mountEditor(rootEl.querySelector('#stEditorHost'), {
    onInput: onEditorInput,
    onDemote: onEditorDemote,
    onHunkClick: (id) => activateHunk(id),
    onScope: (n) => setScope(n),
    onBlur: () => data.flushEdits(),
  })
}

function liveVms() {
  return vms.filter(v => !state.studio.demoted.has(v.id))
}

export function hasPendingHunks() {
  return state.studio.open && liveVms().length > 0
}

function relocate() {
  const s = state.studio
  const pending = s.proposal ? s.proposal.hunks.filter(h => h.status === 'pending') : []
  const located = locateHunks(s.body, pending)
  vms = located.vms
  unanchored = located.unanchored
  const live = liveVms()
  if (live.length === 0) s.activeHunkId = null
  else if (!live.find(v => v.id === s.activeHunkId)) s.activeHunkId = firstPending(vms, s.demoted)
}

function stripCtxFor(vm) {
  const s = state.studio
  const idx = vms.findIndex(v => v.id === vm.id)
  const paras = splitParagraphs(s.body)
  return {
    index: idx + 1,
    total: vms.length,
    paraText: paras[vm.paraIndex]?.text ?? '',
    commentOpen: s.commentFor === vm.id,
    commentValue,
    revising: s.revisingFor === vm.id,
  }
}

function syncEditor(focus) {
  if (!ed) return
  relocate()
  ed.setContent({
    body: state.studio.body,
    vms,
    activeId: state.studio.activeHunkId,
    demoted: state.studio.demoted,
    stripHtml: (vm) => stripHtml(vm, stripCtxFor(vm)),
    focus,
  })
  bindCommentInput()
}

function bindCommentInput() {
  const input = rootEl?.querySelector('#hunkCommentInput')
  if (!input || input.dataset.bound) return
  input.dataset.bound = '1'
  input.addEventListener('input', () => { commentValue = input.value })
  input.focus()
}

export function update() {
  if (!rootEl) return
  relocate()
  updateMeta()
  updateHead()
  syncEditor()
  updateGenerating()
  updateStale()
  updateErrors()
  updateNote()
  updateConfirm()
  updateFooter()
}

// ── Meta line (§3.4.3) ──

function chipHtml(field, addr, idx) {
  const invalid = !EMAIL_RE.test(addr.email)
  return `<button type="button" class="chip${invalid ? ' invalid' : ''}" data-action="chip-edit"
    data-field="${field}" data-idx="${idx}" title="Edit ${escapeAttr(addr.email || addr.name)}">
    ${escapeHtml(data.addrFull(addr))}<span class="chip-x" aria-hidden="true">×</span></button>`
}

function updateMeta(force = false) {
  const el = qs('#stMeta', rootEl)
  const s = state.studio
  const d = s.draft
  if (!el || !d) return
  // Never re-render under the user's caret — background refreshes wait.
  // Deliberate edits (chip commits) force through and re-focus themselves.
  if (!force && el.contains(document.activeElement)) return
  const voice = state.voices.list.find(v => v.id === d.voiceId)
  const voiceBtn = `<button type="button" class="voice-btn" id="btnVoice" data-action="open-voice-picker"
    title="Writing voice" aria-haspopup="listbox">Voice ${escapeHtml(voice ? voice.name : '—')} ${icon('chevron-down', 12)}</button>`

  if (!s.metaExpanded) {
    const to = d.to.map(data.addrDisplay).join(', ') || 'Add recipients'
    const cc = d.cc.length ? ` · Cc ${d.cc.map(data.addrDisplay).join(', ')}` : ''
    el.innerHTML = `<div class="st-meta">
      <button type="button" class="st-meta-line" data-action="meta-expand" title="Edit recipients and subject">
        To ${escapeHtml(to)}${escapeHtml(cc)}${d.subject ? ` — ${escapeHtml(d.subject)}` : ''}</button>
      ${voiceBtn}</div>`
    return
  }
  const row = (field, label, list, inputId) => `
    <div class="meta-row">
      <span class="meta-label">${label}</span>
      <div class="chips" data-field="${field}">
        ${list.map((a, i) => chipHtml(field, a, i)).join('')}
        <input type="text" class="chip-input" id="${inputId}" data-field="${field}" data-region="input"
          aria-label="${label} recipients" placeholder="${field === 'to' ? 'name@example.com' : ''}">
      </div>
    </div>`
  el.innerHTML = `<div class="st-meta expanded">
    <div class="st-meta-fields">
      <div class="meta-row">
        <span class="meta-label">From</span>
        <span class="meta-from">${escapeHtml(state.conn.email || '—')}</span>
      </div>
      ${row('to', 'To', d.to, 'metaTo')}
      ${row('cc', 'Cc', d.cc, 'metaCc')}
      ${row('bcc', 'Bcc', d.bcc, 'metaBcc')}
      <div class="meta-row">
        <span class="meta-label">Subject</span>
        <input type="text" class="meta-subject" id="metaSubject" data-region="input" aria-label="Subject"
          value="${escapeAttr(d.subject)}">
      </div>
    </div>
    <div class="st-meta-side">
      ${voiceBtn}
      <button type="button" class="icon-btn" data-action="meta-collapse" title="Done editing recipients">${icon('check')}</button>
    </div>
  </div>`
  bindMetaInputs()
}

function bindMetaInputs() {
  for (const field of ['to', 'cc', 'bcc']) {
    const input = rootEl.querySelector(`.chip-input[data-field="${field}"]`)
    if (!input) continue
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        commitChipInput(field, input)
      } else if (e.key === 'Backspace' && input.value === '') {
        const list = state.studio.draft[field]
        if (list.length) {
          const last = list.pop()
          updateMeta(true)
          const again = rootEl.querySelector(`.chip-input[data-field="${field}"]`)
          if (again) { again.value = data.addrFull(last); again.focus() }
          commitMeta()
        }
      }
    })
    input.addEventListener('blur', () => commitChipInput(field, input, { quiet: true }))
  }
  const subject = rootEl.querySelector('#metaSubject')
  if (subject) {
    subject.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); subject.blur() }
    })
    subject.addEventListener('blur', () => {
      const s = state.studio
      if (subject.value !== s.draft.subject) {
        s.draft.subject = subject.value
        commitMeta({ subject: subject.value })
        updateMeta()
      }
    })
  }
}

function commitChipInput(field, input, { quiet = false } = {}) {
  const raw = input.value.trim().replace(/,$/, '')
  if (!raw) return
  const parts = raw.split(/[,;]/).map(x => x.trim()).filter(Boolean)
  const parsed = data.parseAddressList(parts)
  state.studio.draft[field].push(...parsed)
  input.value = ''
  commitMeta()
  updateMeta(true)
  if (!quiet) rootEl.querySelector(`.chip-input[data-field="${field}"]`)?.focus()
}

function commitMeta(extra = null) {
  const d = state.studio.draft
  const patch = extra || {
    to: d.to.map(data.addrFull),
    cc: d.cc.map(data.addrFull),
    bcc: d.bcc.map(data.addrFull),
  }
  data.updateDraftMeta(d.id, patch).then(r => {
    if (!r.ok) {
      state.studio.opError = `Couldn’t save recipients — ${r.error}`
      updateErrors()
    }
  })
  if (state.studio.draft.state === 'approved') approvalReset()
}

// ── Sticky proposal header (§3.4.2) ──

function originLabel(p) {
  if (!p) return ''
  if (p.origin === 'chat_agent') {
    const intent = p.intent.length > 40 ? `${p.intent.slice(0, 40)}…` : p.intent
    return `from chat: “${intent}”`
  }
  if (p.origin === 'flywheel') return 'from learning'
  return 'from you'
}

function updateHead() {
  const el = qs('#stHead', rootEl)
  if (!el) return
  const s = state.studio
  const live = liveVms()
  if (!s.proposal || live.length === 0) {
    el.hidden = true
    return
  }
  el.hidden = false
  const dropped = s.proposal.dropped > 0
    ? `<span class="st-dropped" title="The draft changed since the AI read it; these suggestions were dropped rather than guessed.">${s.proposal.dropped} couldn’t be placed safely</span>`
    : ''
  el.innerHTML = `
    <span class="micro">${live.length} PROPOSED CHANGE${live.length === 1 ? '' : 'S'}</span>
    <span class="st-origin">${escapeHtml(originLabel(s.proposal))}</span>
    ${dropped}
    <span class="st-head-actions">
      <button type="button" class="btn-acceptall" data-action="accept-all" title="Accept all (⇧A from a change)">Accept all</button>
      <button type="button" class="btn-quiet" id="btnDismissAll" data-action="open-dismiss-all"
        title="Dismiss the proposed changes" aria-haspopup="menu">Dismiss all ${icon('chevron-down', 12)}</button>
    </span>`
}

export function dismissAllMenuHtml() {
  return `<div class="menu" role="menu" aria-label="Dismiss all" data-menu="dismissAll">
    <button type="button" class="menu-item" role="menuitem" data-action="dismiss-plain"
      title="Dismiss these suggestions">
      <span class="menu-2line"><span>Dismiss</span>
      <span class="menu-sub">The AI may suggest again</span></span></button>
    <button type="button" class="menu-item" role="menuitem" data-action="dismiss-takeover"
      title="Stops AI suggestions on this draft">Dismiss and stop suggesting on this draft</button>
  </div>`
}

// ── Stale line ──

function staleIds() {
  const ids = new Set(state.studio.stale.map(x => x.id))
  for (const id of unanchored) ids.add(id)
  return [...ids]
}

function updateStale() {
  const el = qs('#stStale', rootEl)
  if (!el) return
  const ids = staleIds()
  if (!ids.length) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.innerHTML = `${ids.length} proposal${ids.length === 1 ? ' no longer applies' : 's no longer apply'} —
    <button type="button" class="btn-quiet" data-action="stale-dismiss" title="Clear them">Dismiss</button> ·
    <button type="button" class="btn-quiet" data-action="stale-repropose" title="Ask the AI to try again on the current draft">Re-propose</button>`
}

// ── Inline errors / note / generating ──

function updateErrors() {
  const prop = qs('#stPropErr', rootEl)
  const op = qs('#stOpErr', rootEl)
  if (prop) {
    prop.hidden = !state.studio.proposeError
    prop.innerHTML = state.studio.proposeError
      ? `<div class="properr-card">${escapeHtml(state.studio.proposeError)}
          <button type="button" class="btn-quiet" data-action="propose-retry" title="Try again">Try again</button></div>`
      : ''
  }
  if (op) {
    op.hidden = !state.studio.opError
    op.innerHTML = state.studio.opError
      ? `${escapeHtml(state.studio.opError)}
         <button type="button" class="btn-quiet" data-action="op-dismiss" title="Dismiss">Dismiss</button>`
      : ''
  }
}

function updateNote() {
  const el = qs('#stNote', rootEl)
  if (!el) return
  el.hidden = !state.studio.note
  el.textContent = state.studio.note
}

function setNote(msg) {
  state.studio.note = msg
  updateNote()
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    state.studio.note = ''
    updateNote()
  }, 4000)
}

function updateGenerating() {
  const el = qs('#stGenerating', rootEl)
  const host = qs('#stEditorHost', rootEl)
  if (!el) return
  el.hidden = !state.studio.generating
  if (host) host.style.display = state.studio.generating ? 'none' : ''
}

// ── Footer (§3.4.3) ──

function updateFooter() {
  const el = qs('#stFooter', rootEl)
  if (!el) return
  const s = state.studio
  if (s.confirm) {
    el.hidden = true
    return
  }
  el.hidden = false
  const askFocused = document.activeElement?.id === 'askAiInput'
  const focusedId = !askFocused && el.contains(document.activeElement) ? document.activeElement.id : null
  // While the user is typing the DOM wins; otherwise state is the truth
  // (a successful propose clears it).
  const askVal = askFocused ? (qs('#askAiInput', rootEl)?.value ?? s.askAi.text) : s.askAi.text
  const empty = s.body.trim() === ''
  const placeholder = empty ? '✦ Tell the AI what this email should say…' : '✦ Ask AI to change something…'
  const primaryLabel = s.draft.state === 'approved' ? 'Send…' : s.draft.state === 'send_failed' ? 'Send…' : 'Approve'
  // Hard send gate: no valid To address → nothing to approve or send.
  const hasValidTo = (s.draft.to ?? []).some(a => EMAIL_RE.test(a.email))
  el.innerHTML = `
    <div class="askai${s.askAi.pending ? ' pending' : ''}">
      ${s.askAi.scope ? `<button type="button" class="scope-chip" data-action="clear-scope" title="Remove paragraph scope">¶${s.askAi.scope} ×</button>` : ''}
      <input type="text" id="askAiInput" data-region="input" placeholder="${escapeAttr(placeholder)}"
        aria-label="Ask AI" value="${escapeAttr(askVal)}" ${s.askAi.pending ? 'disabled' : ''}>
      ${s.askAi.pending ? '<span class="askai-progress"><span class="spinner" aria-hidden="true"></span>Proposing…</span>' : ''}
    </div>
    <button type="button" class="icon-btn" id="btnOverflow" data-action="open-overflow" title="More" aria-haspopup="menu">${icon('dots')}</button>
    <button type="button" class="btn-primary" id="stPrimary" data-action="primary" ${hasValidTo ? '' : 'disabled'}
      title="${hasValidTo ? (primaryLabel === 'Approve' ? 'Approve (⌘⏎)' : 'Send (⌘⏎)') : 'Add a valid To recipient first'}">${primaryLabel} ⌘⏎</button>`
  const input = qs('#askAiInput', rootEl)
  if (input) {
    input.addEventListener('input', () => { s.askAi.text = input.value })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitAsk()
      }
    })
    if (askFocused && !s.askAi.pending) {
      input.focus()
      const end = input.value.length
      try { input.setSelectionRange(end, end) } catch {}
    }
  }
  if (focusedId) qs(`#${focusedId}`, rootEl)?.focus()
}

export function overflowMenuHtml() {
  return `<div class="menu" role="menu" aria-label="Draft actions" data-menu="overflow">
    <button type="button" class="menu-item" role="menuitem" data-action="open-history"
      title="Draft revisions">History…</button>
    <div class="menu-sep"></div>
    <button type="button" class="menu-item danger" role="menuitem" data-action="discard-draft"
      title="Discard this draft">${state.studio.discardArmed ? 'Discard — sure?' : 'Discard draft'}</button>
  </div>`
}

// ── History (§3.4.3) ──

export function historyMenuHtml() {
  const s = state.studio
  const label = { human_edit: 'you', ai_initial: 'AI draft', proposal_accept: 'accepted change', revert: 'restore' }
  const rows = [...s.revisions].sort((a, b) => b.seq - a.seq).map(r => {
    const t = r.createdAt ? fmtTime(new Date(r.createdAt).getTime()) : ''
    return `<button type="button" class="menu-item${s.history.selectedId === r.id ? ' selected' : ''}"
      role="menuitem" data-action="history-select" data-id="${escapeAttr(r.id)}"
      title="Preview this version">#${r.seq} · ${escapeHtml(label[r.source] || r.source)} · <span class="mono">${escapeHtml(t)}</span></button>`
  }).join('')
  let preview = '<div class="hist-hint">Select a version to preview it.</div>'
  if (s.history.loading) preview = '<div class="hist-hint"><span class="spinner"></span> Loading…</div>'
  else if (s.history.selectedId && s.history.body != null) {
    preview = `<div class="hist-body">${escapeHtml(s.history.body)}</div>
      <button type="button" class="btn-primary hist-restore" data-action="history-restore"
        title="Restore this version">Restore this version</button>`
  }
  return `<div class="menu hist-panel" role="dialog" aria-label="Draft history" data-menu="history">
    <div class="hist-list">${rows || '<div class="hist-hint">No revisions yet.</div>'}</div>
    <div class="hist-preview">${preview}</div>
  </div>`
}

// ── Confirm card (§3.4.4) ──

let lastConfirmKey = ''

function updateConfirm() {
  const el = qs('#stConfirm', rootEl)
  if (!el) return
  const s = state.studio
  // Recipients are part of the key: if they change under an open card the
  // gate re-renders rather than showing (and sending to) a stale list.
  const recipKey = s.draft
    ? ['to', 'cc', 'bcc'].map(f => (s.draft[f] ?? []).map(a => a.email).join(',')).join(';')
    : ''
  const key = !s.confirm ? '' : typeof s.confirm === 'object' ? `error:${s.confirm.error}` : `${s.confirm}|${recipKey}`
  if (key === lastConfirmKey && el.firstElementChild) return // no focus churn on background renders
  lastConfirmKey = key
  if (!s.confirm) {
    el.innerHTML = ''
    confirmFocused = false
    updateFooter()
    return
  }
  if (typeof s.confirm === 'object' && s.confirm.error) {
    el.innerHTML = `<div class="send-error" role="alertdialog" aria-modal="true" aria-label="Send failed" id="confirmCard">
      <div class="send-error-msg">${escapeHtml(s.confirm.error)}</div>
      <div class="confirm-actions">
        <button type="button" class="btn-quiet" data-action="send-back" title="Back to the draft">Back to draft</button>
        <button type="button" class="btn-primary" id="btnSendRetry" data-action="send-retry" title="Try sending again">Retry</button>
      </div>
    </div>`
    updateFooter()
    qs('#confirmCard', rootEl)?.addEventListener('keydown', trapConfirmTab)
    qs('#btnSendRetry', rootEl)?.focus() // §5.2: send fails → focus Retry
    return
  }
  const d = s.draft
  const sending = s.confirm === 'sending'
  const voice = state.voices.list.find(v => v.id === d.voiceId)
  const line = (label, value) => value
    ? `<div class="confirm-row"><span class="confirm-label">${label}</span><span class="confirm-val">${escapeHtml(value)}</span></div>`
    : ''
  const lineHtml = (label, html) => html
    ? `<div class="confirm-row"><span class="confirm-label">${label}</span><span class="confirm-val">${html}</span></div>`
    : ''
  // Invalid addresses get the same tint-rem treatment as invalid chips.
  const recipsHtml = (list) => list.map(a => {
    const full = escapeHtml(data.addrFull(a))
    return EMAIL_RE.test(a.email) ? full
      : `<span class="confirm-invalid-addr">${full}</span>`
  }).join(', ')
  const { invalid } = validRecipients(d)
  const blocked = invalid.length > 0
  const invalidLine = blocked
    ? `<div class="confirm-invalid">Fix invalid recipients before sending: ${escapeHtml(invalid.map(a => a.email || a.name).join(', '))}</div>`
    : ''
  el.innerHTML = `<div class="confirm-card" role="alertdialog" aria-modal="true" aria-label="Send this email?" id="confirmCard">
    <div class="confirm-title">Send this email?</div>
    ${line('From', state.conn.email)}
    ${lineHtml('To', recipsHtml(d.to) || '—')}
    ${lineHtml('Cc', recipsHtml(d.cc))}
    ${lineHtml('Bcc', recipsHtml(d.bcc))}
    ${line('Subject', d.subject || '(no subject)')}
    ${line('Voice', voice ? voice.name : '')}
    ${invalidLine}
    ${d.threadId ? `<label class="confirm-quote">
      <input type="checkbox" id="quoteToggle" ${s.includeQuote ? 'checked' : ''} ${sending ? 'disabled' : ''}>
      Include quoted thread below your reply</label>` : ''}
    <div class="confirm-actions">
      <button type="button" class="btn-quiet" data-action="confirm-cancel" title="Back to the draft (Esc)" ${sending ? 'disabled' : ''}>Cancel</button>
      <button type="button" class="btn-primary" id="btnConfirmSend" data-action="confirm-send"
        title="${blocked ? 'Fix invalid recipients first' : 'Send (⌘⏎)'}" ${sending || blocked ? 'disabled' : ''}>
        ${sending ? '<span class="spinner" aria-hidden="true"></span> Sending…' : 'Send ⌘⏎'}</button>
    </div>
  </div>`
  updateFooter()
  const quote = qs('#quoteToggle', rootEl)
  if (quote) quote.addEventListener('change', () => {
    s.includeQuote = quote.checked
    // What was approved must be exactly what sends: flipping the quote
    // changes the outgoing message, so approval resets and the card
    // closes — re-approve from the footer to reopen it.
    if (s.draft.state === 'approved') approvalReset()
  })
  const card = qs('#confirmCard', rootEl)
  if (card) {
    card.addEventListener('keydown', trapConfirmTab)
    if (!confirmFocused && !sending) {
      confirmFocused = true
      if (blocked) card.querySelector('[data-action="confirm-cancel"]')?.focus()
      else qs('#btnConfirmSend', rootEl)?.focus()
    }
  }
}

function trapConfirmTab(e) {
  if (e.key !== 'Tab') return
  const card = qs('#confirmCard', rootEl)
  if (!card) return
  const focusables = Array.from(card.querySelectorAll('button:not([disabled]), input:not([disabled])'))
  if (!focusables.length) return
  const i = focusables.indexOf(document.activeElement)
  e.preventDefault()
  const next = focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]
  next.focus()
}

// ── Editor handlers ──

function onEditorInput(body) {
  const s = state.studio
  s.body = body
  if (s.draft.state === 'approved' || s.draft.state === 'send_failed') approvalReset()
  data.queueDraftEdit()
  updateHead()
  if (s.body.trim() !== '' || s.askAi.text) updateFooterPlaceholder()
}

function updateFooterPlaceholder() {
  const input = qs('#askAiInput', rootEl)
  if (!input) return
  const empty = state.studio.body.trim() === ''
  input.placeholder = empty ? '✦ Tell the AI what this email should say…' : '✦ Ask AI to change something…'
}

function onEditorDemote(blockIdx, ids) {
  const s = state.studio
  const fresh = (ids || hunkIdsInParagraph(vms, blockIdx)).filter(id => !s.demoted.has(id))
  if (!fresh.length) return
  for (const id of fresh) s.demoted.add(id)
  if (s.activeHunkId && s.demoted.has(s.activeHunkId)) s.activeHunkId = null
  ed.applyDemotion(new Set(s.demoted))
  updateHead()
}

function approvalReset() {
  const s = state.studio
  s.draft.state = 'composing'
  s.confirm = null
  updateConfirm()
  setNote('Draft changed — approval reset')
  updateFooter()
}

// ── Hunk operations ──

export function activateHunk(id, { focus = true } = {}) {
  const s = state.studio
  if (s.demoted.has(id)) s.demoted.delete(id)
  s.activeHunkId = id
  syncEditor(focus ? { strip: true } : undefined)
  updateHead()
}

export function cycleHunk(dir) {
  const s = state.studio
  const next = nextActive(vms, s.activeHunkId, dir, s.demoted)
  if (next) activateHunk(next)
}

function resolveLocally(id, status) {
  const s = state.studio
  const h = s.proposal?.hunks.find(x => x.id === id)
  if (h) h.status = status
  s.demoted.delete(id)
}

function focusAfterResolve(vm) {
  const s = state.studio
  relocate()
  const live = liveVms()
  if (live.length > 0) {
    const next = live.find(v => v.start >= vm.start) || live[0]
    s.activeHunkId = next.id
    syncEditor({ strip: true })
  } else {
    s.activeHunkId = null
    const offset = Math.min(vm.start + (vm.kind === 'add' ? vm.proposed_text.length : 0), s.body.length)
    syncEditor({ offset })
  }
  updateHead()
  updateStale()
}

export async function acceptHunk(id) {
  const s = state.studio
  const vm = vms.find(v => v.id === id)
  if (!vm) return
  await data.flushEdits()
  const snapshot = { body: s.body, hunks: s.proposal.hunks.map(h => ({ ...h })), active: s.activeHunkId }
  const local = applyHunkLocal(s.body, vm)
  resolveLocally(id, 'accepted')
  if (local != null) s.body = local
  focusAfterResolve(vm)
  const r = await data.acceptHunk(id)
  if (!r.ok) {
    s.body = snapshot.body
    s.proposal.hunks = snapshot.hunks
    s.activeHunkId = snapshot.active
    s.opError = `Couldn’t apply the change — ${r.error}`
    syncEditor()
    updateHead()
    updateErrors()
    return
  }
  if (r.value.body != null) s.body = r.value.body
  if (r.value.revisionId) s.baseRevisionId = r.value.revisionId
  data.applyHunkChanges(r.value.hunkChanges)
  syncEditor()
  updateHead()
  updateStale()
}

export async function rejectHunk(id, comment = '') {
  const s = state.studio
  const vm = vms.find(v => v.id === id)
  if (!vm) return
  await data.flushEdits()
  resolveLocally(id, 'rejected')
  s.commentFor = null
  focusAfterResolve(vm)
  const r = await data.rejectHunk(id, comment || undefined)
  if (!r.ok) {
    resolveLocally(id, 'pending')
    s.opError = `Couldn’t reject — ${r.error}`
    syncEditor()
    updateErrors()
  }
}

export async function acceptAll() {
  const s = state.studio
  await data.flushEdits()
  const order = liveVms()
  if (!order.length) return
  let last = order[order.length - 1]
  // Optimistic: apply everything locally in document order.
  for (const vm of order) {
    const next = applyHunkLocal(s.body, vm)
    if (next != null) s.body = next
    resolveLocally(vm.id, 'accepted')
  }
  s.activeHunkId = null
  syncEditor({ offset: Math.min(last.start + last.proposed_text.length, s.body.length) })
  updateHead()
  let failed = null
  for (const vm of order) {
    const r = await data.acceptHunk(vm.id)
    if (!r.ok) { failed = r.error; break }
    if (r.value.body != null) s.body = r.value.body
    if (r.value.revisionId) s.baseRevisionId = r.value.revisionId
    data.applyHunkChanges(r.value.hunkChanges)
  }
  if (failed) {
    await data.loadDraft(s.draft.id)
    s.opError = `Couldn’t accept everything — ${failed}`
    updateErrors()
  }
  syncEditor()
  updateHead()
  updateStale()
}

export function openComment(id) {
  const s = state.studio
  commentValue = ''
  s.commentFor = id
  ed.refreshStrip()
  bindCommentInput()
}

export function closeComment({ backToStrip = true } = {}) {
  state.studio.commentFor = null
  ed.refreshStrip()
  if (backToStrip) ed.focusStrip()
}

export async function submitComment() {
  const s = state.studio
  const id = s.commentFor
  const comment = commentValue.trim()
  if (!id || !comment) return
  await data.flushEdits()
  s.commentFor = null
  s.revisingFor = id
  ed.refreshStrip()
  const r = await data.commentHunk(id, comment)
  s.revisingFor = null
  if (!r.ok) {
    s.proposeError = `The AI couldn’t produce a valid change here — ${r.error}`
    ed.refreshStrip()
    updateErrors()
    return
  }
  if (r.value.kind === 'proposal') {
    s.proposal = r.value.proposal
    s.demoted = new Set()
    s.stale = []
    s.activeHunkId = null
    relocate()
    s.activeHunkId = firstPending(vms, s.demoted)
    syncEditor({ strip: true })
    updateHead()
  } else {
    // Invalidated result supersedes nothing — the parent hunk stays live.
    s.proposeError = 'The AI couldn’t produce a valid change here'
    ed.refreshStrip()
    updateErrors()
  }
}

export async function rejectWithNote() {
  const s = state.studio
  const id = s.commentFor
  const comment = commentValue.trim()
  if (!id) return
  s.commentFor = null
  await rejectHunk(id, comment)
}

async function dismissAll(takeover) {
  const s = state.studio
  closeMenus()
  if (!s.proposal) return
  const caret = ed?.caretBodyOffset()
  const pid = s.proposal.id
  for (const h of s.proposal.hunks) if (h.status === 'pending') h.status = 'dismissed'
  s.proposal = null
  s.demoted = new Set()
  s.stale = []
  s.activeHunkId = null
  syncEditor(caret != null ? { offset: caret } : { end: true })
  updateHead()
  updateStale()
  render()
  await data.dismissProposal(pid, takeover)
}

// ── Stale line actions ──

async function staleDismiss() {
  const s = state.studio
  for (const id of staleIds()) {
    const h = s.proposal?.hunks.find(x => x.id === id)
    if (h && h.status === 'pending') h.status = 'stale'
  }
  s.stale = []
  relocate()
  if (s.proposal && !s.proposal.hunks.some(h => h.status === 'pending')) s.proposal = null
  syncEditor()
  updateHead()
  updateStale()
}

async function staleRepropose() {
  const s = state.studio
  const intent = s.proposal?.intent
  await staleDismiss()
  if (intent) await runPropose(intent, null)
}

// ── Ask AI ──

async function runPropose(intent, scope) {
  const s = state.studio
  // Capture before the input is disabled (disabling drops focus).
  const wasInAsk = document.activeElement?.id === 'askAiInput'
  await data.flushEdits()
  s.askAi.pending = true
  s.proposeError = ''
  updateFooter()
  updateErrors()
  const empty = s.body.trim() === ''
  if (empty) {
    s.generating = true
    updateGenerating()
  }
  const r = await data.proposeIntent(s.draft.id, intent, scope ? [scope] : null)
  s.askAi.pending = false
  s.generating = false
  updateGenerating()
  if (!r.ok) {
    s.proposeError = `The AI couldn’t produce a valid change here — ${r.error}`
    updateFooter()
    updateErrors()
    return
  }
  s.askAi = { text: '', scope: null, pending: false }
  ed.setScoped(null)
  if (r.value.kind === 'proposal') {
    s.proposal = r.value.proposal
    s.demoted = new Set()
    s.stale = []
    s.activeHunkId = null
    relocate()
    s.activeHunkId = firstPending(vms, s.demoted)
    const n = liveVms().length
    if (wasInAsk) {
      syncEditor({ strip: true }) // own ask → first strip (§5.2)
    } else {
      syncEditor() // never steal focus
      data.announce(`${n} change${n === 1 ? '' : 's'} proposed`)
    }
    updateHead()
    updateFooter()
  } else if (r.value.kind === 'body') {
    await data.loadDraft(s.draft.id)
    update()
    ed.wash()
  } else {
    s.proposeError = 'The AI couldn’t produce a valid change here'
    updateFooter()
    updateErrors()
  }
}

function submitAsk() {
  const s = state.studio
  if (s.askAi.pending) return
  let text = (qs('#askAiInput', rootEl)?.value ?? s.askAi.text).trim()
  let scope = s.askAi.scope
  const m = /^¶(\d+)\s+/.exec(text)
  if (m) {
    scope = Number(m[1])
    text = text.slice(m[0].length).trim()
  }
  if (!text) return
  s.askAi.text = text
  runPropose(text, scope)
}

function setScope(n) {
  state.studio.askAi.scope = n
  ed.setScoped(n)
  updateFooter()
  qs('#askAiInput', rootEl)?.focus()
}

// ── Approve / send ──

export async function primaryAction() {
  const s = state.studio
  if (!s.open || !s.draft || s.confirm) return
  // Belt and braces with the disabled footer button: never approve or
  // open the send card without a deliverable To address.
  if (!(s.draft.to ?? []).some(a => EMAIL_RE.test(a.email))) {
    const bad = validRecipients(s.draft).invalid.map(a => a.email || a.name).filter(Boolean).join(', ')
    s.opError = bad
      ? `Can’t send — no valid recipient in To (invalid: ${bad})`
      : 'Can’t send — no valid recipient in To'
    updateErrors()
    return
  }
  if (s.draft.state === 'approved' || s.draft.state === 'send_failed') {
    openConfirm()
    return
  }
  await data.flushEdits()
  const r = await data.approveDraft(s.draft.id, s.baseRevisionId)
  if (!r.ok) {
    await data.loadDraft(s.draft.id)
    update()
    s.opError = `Couldn’t approve — ${r.error}`
    updateErrors()
    return
  }
  s.draft.state = 'approved'
  openConfirm()
}

function openConfirm() {
  const s = state.studio
  s.confirm = 'card'
  confirmOpenedAt = performance.now()
  confirmFocused = false
  updateConfirm()
}

export async function confirmSend() {
  const s = state.studio
  if (s.confirm !== 'card') return
  // The card's Send button is disabled while any recipient is invalid;
  // this guards the ⌘⏎ path that bypasses the button.
  const { invalid } = validRecipients(s.draft)
  if (invalid.length || !(s.draft.to ?? []).some(a => EMAIL_RE.test(a.email))) return
  // Anti double-fire: a press inside the guard window is deferred by the
  // remaining time, never dropped. The sending state renders immediately;
  // it also makes re-entry a no-op (confirm !== 'card') while scheduled.
  const delay = sendGuardDelay(performance.now() - confirmOpenedAt)
  s.confirm = 'sending'
  updateConfirm()
  if (delay > 0) {
    sendGuardTimer = setTimeout(() => {
      sendGuardTimer = null
      performSend()
    }, delay)
    return
  }
  await performSend()
}

async function performSend() {
  const s = state.studio
  let r
  if (s.draft.state === 'send_failed') {
    // Failed sends drop out of `approved`; re-approve on the current
    // revision before retrying.
    const ok = await data.approveDraft(s.draft.id, s.baseRevisionId)
    r = ok.ok ? await data.sendDraft(s.draft.id, s.includeQuote) : ok
  } else {
    r = await data.sendDraft(s.draft.id, s.includeQuote)
  }
  if (!r.ok) {
    s.draft.state = 'send_failed'
    s.confirm = { error: r.error }
    updateConfirm()
    return
  }
  const name = data.addrDisplay(s.draft.to[0] || {}) || 'recipient'
  const threadId = s.draft.threadId || state.route.threadId
  closeStudio()
  showToast(`Sent to ${name}`)
  if (threadId) {
    state.route = { view: 'thread', threadId, draftId: null }
    await data.loadThread(threadId)
  } else {
    state.route = { view: 'inbox', threadId: null, draftId: null }
  }
  await data.loadInbox({ refresh: true })
  render()
  // Focus returns to the list, selection on this thread (§5.2).
  requestAnimationFrame(() => {
    const sel = state.inbox.selectedId
    if (sel) qs(`#listRows [data-id="${CSS.escape(String(sel))}"]`)?.focus()
  })
}

export function cancelConfirm() {
  const s = state.studio
  if (s.confirm === 'sending') return
  s.confirm = null
  updateConfirm()
  qs('#stPrimary', rootEl)?.focus()
}

// ── Esc helpers (§5.1) ──

export function exitStripToEditor() {
  const s = state.studio
  const vm = vms.find(v => v.id === s.activeHunkId)
  ed?.focusBodyOffset(vm ? vm.start : 0)
}

export function blurEditorToStudio() {
  rootEl?.focus()
}

export function focusActiveStrip() {
  ed?.focusStrip()
}

// ── Actions (click + keyboard, render.js dispatch) ──

function hunkIdFrom(el) {
  return el?.closest?.('.strip')?.dataset.hunk || state.studio.activeHunkId
}

export const studioActions = {
  'meta-expand': () => { state.studio.metaExpanded = true; updateMeta(true); qs('#metaTo', rootEl)?.focus() },
  'meta-collapse': () => { state.studio.metaExpanded = false; updateMeta(true); qs('.st-meta-line', rootEl)?.focus() },
  'chip-edit': (el) => {
    const field = el.dataset.field
    const idx = Number(el.dataset.idx)
    const list = state.studio.draft[field]
    const [addr] = list.splice(idx, 1)
    commitMeta()
    updateMeta(true)
    const input = rootEl.querySelector(`.chip-input[data-field="${field}"]`)
    if (input && addr) {
      input.value = data.addrFull(addr)
      input.focus()
    }
  },
  'open-voice-picker': (el) => {
    if (state.menus.voicePicker) { closeMenus(); render(); return }
    if (!state.voices.loaded) data.loadVoices().then(render)
    const rect = el.getBoundingClientRect()
    openMenu('voicePicker', { x: rect.right, y: rect.bottom + 4, invokerId: 'btnVoice', align: 'right' })
  },
  'pick-voice': async (el) => {
    const voiceId = el.dataset.id
    closeMenus()
    state.studio.draft.voiceId = voiceId
    render()
    await data.updateDraftMeta(state.studio.draft.id, { voice_id: voiceId })
  },
  'accept-all': () => { acceptAll() },
  'open-dismiss-all': (el) => {
    if (state.menus.dismissAll) { closeMenus(); render(); return }
    const rect = el.getBoundingClientRect()
    openMenu('dismissAll', { x: rect.right, y: rect.bottom + 4, invokerId: 'btnDismissAll', align: 'right' })
  },
  'dismiss-plain': () => { dismissAll(false) },
  'dismiss-takeover': () => { dismissAll(true) },
  'hunk-accept': (el) => { const id = hunkIdFrom(el); if (id) acceptHunk(id) },
  'hunk-reject': (el) => { const id = hunkIdFrom(el); if (id) rejectHunk(id) },
  'hunk-comment-open': (el) => { const id = hunkIdFrom(el); if (id) openComment(id) },
  'hunk-comment': (el) => { const id = hunkIdFrom(el); if (id) openComment(id) },
  'hunk-comment-submit': () => { submitComment() },
  'hunk-reject-note': () => { rejectWithNote() },
  'stale-dismiss': () => { staleDismiss() },
  'stale-repropose': () => { staleRepropose() },
  'propose-retry': () => {
    state.studio.proposeError = ''
    updateErrors()
    if (state.studio.askAi.text) runPropose(state.studio.askAi.text, state.studio.askAi.scope)
    else if (state.studio.proposal?.intent) runPropose(state.studio.proposal.intent, null)
  },
  'op-dismiss': () => { state.studio.opError = ''; updateErrors() },
  'clear-scope': () => {
    state.studio.askAi.scope = null
    ed?.setScoped(null)
    updateFooter()
    qs('#askAiInput', rootEl)?.focus()
  },
  'open-overflow': (el) => {
    if (state.menus.overflow) { closeMenus(); render(); return }
    const rect = el.getBoundingClientRect()
    openMenu('overflow', { x: rect.right, y: rect.top - 4, invokerId: 'btnOverflow', align: 'right', up: true })
  },
  'open-history': (el) => {
    state.studio.history = { selectedId: null, body: null, loading: false }
    const rect = qs('#stFooter', rootEl)?.getBoundingClientRect()
    openMenu('history', { x: rect?.right ?? 200, y: (rect?.top ?? 200) - 8, invokerId: 'btnOverflow', align: 'right', up: true })
  },
  'history-select': async (el) => {
    const s = state.studio
    s.history.selectedId = el.dataset.id
    s.history.loading = true
    s.history.body = null
    render()
    const r = await data.getRevision(el.dataset.id)
    s.history.loading = false
    s.history.body = r.ok ? r.value.body : `Couldn’t load this version — ${r.error}`
    render()
  },
  'history-restore': async () => {
    const s = state.studio
    const rid = s.history.selectedId
    if (!rid) return
    closeMenus()
    const r = await data.revertDraft(s.draft.id, rid)
    if (!r.ok) {
      s.opError = `Couldn’t restore — ${r.error}`
      updateErrors()
      render()
      return
    }
    await data.loadDraft(s.draft.id)
    update()
    render()
  },
  'discard-draft': async () => {
    const s = state.studio
    // Two-step, mirroring the settings Disconnect pattern: first click
    // arms ("Discard — sure?"), the second click discards. Any other
    // studio action disarms (see the wrapper below studioActions).
    if (!s.discardArmed) {
      s.discardArmed = true
      render()
      return
    }
    s.discardArmed = false
    closeMenus()
    const draftId = s.draft.id
    const threadId = state.route.threadId
    closeStudio()
    render()
    const r = await data.discardDraft(draftId)
    if (r.ok) showToast('Draft discarded')
    if (threadId) data.loadThread(threadId).then(render)
    else data.backToList()
  },
  'continue-draft': (el) => { openDraft(el.dataset.id) },
  'primary': () => { primaryAction() },
  'confirm-send': () => { confirmSend() },
  'confirm-cancel': () => { cancelConfirm() },
  'send-retry': () => {
    state.studio.confirm = 'card'
    confirmOpenedAt = 0 // deliberate retry click — no key guard needed
    updateConfirm()
    confirmSend()
  },
  'send-back': () => {
    state.studio.confirm = null
    updateConfirm()
    qs('#stPrimary', rootEl)?.focus()
  },
}

// Clicking anywhere else resets the armed discard: every studio action
// except the discard confirm itself disarms before running.
for (const [name, fn] of Object.entries(studioActions)) {
  if (name === 'discard-draft') continue
  studioActions[name] = (el) => {
    state.studio.discardArmed = false
    return fn(el)
  }
}

export function voicePickerMenuHtml() {
  const active = state.studio.draft?.voiceId
  const rows = state.voices.list.map(v => `
    <button type="button" class="menu-item${v.id === active ? ' selected' : ''}" role="option"
      data-action="pick-voice" data-id="${escapeAttr(v.id)}" title="${escapeAttr(v.description || v.name)}">
      <span class="menu-2line"><span>${escapeHtml(v.name)}</span>
      ${v.description ? `<span class="menu-sub">${escapeHtml(v.description)}</span>` : ''}</span></button>`).join('')
  return `<div class="menu" role="listbox" aria-label="Voice" data-menu="voicePicker">
    ${rows || '<div class="menu-empty">No voices yet — seed them in Voices &amp; Learning.</div>'}
  </div>`
}
