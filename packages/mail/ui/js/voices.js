// Voices & Learning (UX-SPEC §3.5): voice chips + the standard editor/hunk
// modules against voice docs, plus the learning side panel.

import { state, render, showToast, openMenu, closeMenus } from './state.js'
import { escapeHtml, escapeAttr, qs, relTime, fmtCount } from './utils.js'
import { icon } from './icons.js'
import { mountEditor, splitParagraphs } from './editor.js'
import { locateHunks, firstPending, nextActive, hunkIdsInParagraph, applyHunkLocal, stripHtml } from './hunks.js'
import * as data from './data.js'

let ed = null
let builtFor = null
let vms = []
let unanchored = []
let commentValue = ''
let distillPoll = null

export function hasPendingHunks() {
  return state.route.view === 'voices' && vms.filter(v => !state.voices.demoted.has(v.id)).length > 0
}

export function voicesViewHtml() {
  return `<div class="vc" id="voicesView">
    <div class="vc-bar" id="vcBar"></div>
    <div id="vcSeedBanner"></div>
    <div class="vc-grid" id="vcGrid">
      <div class="vc-doc">
        <div class="st-head" id="vxHead" hidden></div>
        <div class="vc-doc-title" id="vxTitle"></div>
        <div class="vc-ed" id="vxEditorHost"></div>
        <div class="st-stale" id="vxStale" hidden></div>
        <div class="st-properr" id="vxErr" hidden></div>
      </div>
      <aside class="vc-panel" id="vcPanel" aria-label="Learning"></aside>
    </div>
    <div class="vc-empty" id="vcEmpty" hidden></div>
    <!-- The studio is never attached while Voices is — the id is unique in the DOM. -->
    <span id="edTabHint" class="vh">While suggestions are pending, Tab moves between proposed changes; Esc leaves the editor.</span>
  </div>`
}

function activeVoice() {
  return state.voices.list.find(v => v.id === state.voices.activeId) || null
}

export function updateVoices() {
  const bar = qs('#vcBar')
  if (!bar) return
  const vs = state.voices
  const voice = activeVoice()

  bar.innerHTML = `
    <button type="button" class="hd-back" data-action="voices-back" title="Back to inbox">${icon('arrow-left')}<span>Inbox</span></button>
    <span class="vc-title">Voices &amp; Learning</span>
    <div class="vc-chips" role="tablist" aria-label="Voices">
      ${vs.list.map(v => `<button type="button" role="tab" aria-selected="${v.id === vs.activeId}"
        class="tab${v.id === vs.activeId ? ' active' : ''}" data-action="pick-voice-tab" data-id="${escapeAttr(v.id)}"
        title="${escapeAttr(v.description || v.name)}">${escapeHtml(v.name)}${v.proposal ? '<span class="pill-dot" aria-hidden="true"></span>' : ''}</button>`).join('')}
    </div>
    <span class="vc-spacer"></span>
    ${voice ? `<button type="button" class="icon-btn" id="btnVoiceMore" data-action="open-voice-more" title="Voice options" aria-haspopup="menu">${icon('dots')}</button>` : ''}
    <button type="button" class="btn-quiet" data-action="distill" title="Distill lessons from recent sends"
      ${vs.distilling ? 'disabled' : ''}>${vs.distilling ? '<span class="spinner" aria-hidden="true"></span> Distilling…' : 'Distill lessons'}</button>`

  const seedEl = qs('#vcSeedBanner')
  if (seedEl) {
    const fresh = state.conn.seedState === 'ready' && !vs.seedBannerDismissed && vs.list.length > 0
    seedEl.innerHTML = fresh
      ? `<div class="seed-banner">
          <span class="strip-star" aria-hidden="true">✦</span>
          <span>Here’s my first read of how you write — correct me.</span>
          <button type="button" class="btn-quiet" data-action="seed-looks-right" title="Dismiss">Looks right</button>
        </div>`
      : ''
  }

  const grid = qs('#vcGrid')
  const empty = qs('#vcEmpty')
  if (!vs.loaded) {
    if (grid) grid.hidden = true
    if (empty) {
      empty.hidden = false
      empty.innerHTML = '<div class="skel-line"></div><div class="skel-line short"></div>'
    }
    return
  }
  if (!vs.list.length) {
    if (grid) grid.hidden = true
    if (empty) {
      empty.hidden = false
      const seeding = state.conn.seedState === 'running' || state.conn.backfill.state === 'running'
      empty.innerHTML = seeding
        ? `<div class="vc-preseed">Your voices are being read from your sent mail…</div>`
        : `<div class="vc-preseed">No voices yet.</div>
           <button type="button" class="btn-primary" data-action="seed-voices" title="Read voices from your sent mail">Seed voices</button>
           ${vs.error ? `<div class="vc-err">${escapeHtml(vs.error)} <button type="button" class="btn-quiet" data-action="seed-voices">Retry</button></div>` : ''}`
    }
    destroyEditor()
    return
  }
  if (grid) grid.hidden = false
  if (empty) empty.hidden = true

  updateTitle()
  ensureEditor()
  updateHead()
  syncEditor()
  updateStale()
  updateErr()
  updatePanel()
}

function updateTitle() {
  const el = qs('#vxTitle')
  const vs = state.voices
  const voice = activeVoice()
  if (!el || !voice) return
  if (vs.renaming) {
    el.innerHTML = `<input type="text" id="voiceRename" data-region="input" value="${escapeAttr(voice.name)}"
      aria-label="Voice name">`
    const input = qs('#voiceRename')
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const name = input.value.trim()
        vs.renaming = false
        if (name && name !== voice.name) {
          voice.name = name
          await data.updateVoiceMeta(voice.id, { name })
        }
        render()
      } else if (e.key === 'Escape') {
        vs.renaming = false
        render()
      }
    })
    input.addEventListener('blur', () => {
      if (vs.renaming) { vs.renaming = false; render() }
    })
    input.focus()
    input.select()
  } else {
    el.innerHTML = `<span class="vc-name">${escapeHtml(voice.name)}</span>
      ${voice.description ? `<span class="vc-desc">${escapeHtml(voice.description)}</span>` : ''}`
  }
}

// ── Editor ──

function destroyEditor() {
  if (ed) ed.destroy()
  ed = null
  builtFor = null
}

function ensureEditor() {
  const host = qs('#vxEditorHost')
  if (!host) return
  if (ed && builtFor === state.voices.activeId && host.contains(ed.root)) return
  destroyEditor()
  builtFor = state.voices.activeId
  ed = mountEditor(host, {
    onInput: (body) => {
      const vs = state.voices
      vs.body = body
      vs.seedBannerDismissed = true
      data.voiceEditDebounced()
      updateHead()
    },
    onDemote: (blockIdx, hitIds) => {
      const vs = state.voices
      const ids = (hitIds || hunkIdsInParagraph(vms, blockIdx)).filter(id => !vs.demoted.has(id))
      if (!ids.length) return
      for (const id of ids) vs.demoted.add(id)
      if (vs.activeHunkId && vs.demoted.has(vs.activeHunkId)) vs.activeHunkId = null
      ed.applyDemotion(new Set(vs.demoted))
      updateHead()
    },
    onHunkClick: (id) => activateHunk(id),
    onScope: () => {}, // no Ask-AI scope on voice docs
    onBlur: () => data.flushVoiceEdits(),
  })
}

function relocate() {
  const vs = state.voices
  const pending = vs.proposal ? vs.proposal.hunks.filter(h => h.status === 'pending') : []
  const located = locateHunks(vs.body, pending)
  vms = located.vms
  unanchored = located.unanchored
  const live = vms.filter(v => !vs.demoted.has(v.id))
  if (live.length === 0) vs.activeHunkId = null
  else if (!live.find(v => v.id === vs.activeHunkId)) vs.activeHunkId = firstPending(vms, vs.demoted)
}

function stripCtxFor(vm) {
  const vs = state.voices
  const idx = vms.findIndex(v => v.id === vm.id)
  const paras = splitParagraphs(vs.body)
  return {
    index: idx + 1,
    total: vms.length,
    paraText: paras[vm.paraIndex]?.text ?? '',
    commentOpen: vs.commentFor === vm.id,
    commentValue,
    revising: vs.revisingFor === vm.id,
  }
}

function syncEditor(focus) {
  if (!ed) return
  relocate()
  ed.setContent({
    body: state.voices.body,
    vms,
    activeId: state.voices.activeHunkId,
    demoted: state.voices.demoted,
    stripHtml: (vm) => stripHtml(vm, stripCtxFor(vm)),
    focus,
  })
  bindCommentInput()
}

function bindCommentInput() {
  const input = qs('#hunkCommentInput')
  if (!input || input.dataset.bound) return
  input.dataset.bound = '1'
  input.addEventListener('input', () => { commentValue = input.value })
  input.focus()
}

function updateHead() {
  const el = qs('#vxHead')
  if (!el) return
  const vs = state.voices
  const live = vms.filter(v => !vs.demoted.has(v.id))
  if (!vs.proposal || live.length === 0) {
    el.hidden = true
    return
  }
  el.hidden = false
  const dropped = vs.proposal.dropped > 0
    ? `<span class="st-dropped" title="The doc changed since the AI read it; these suggestions were dropped rather than guessed.">${vs.proposal.dropped} couldn’t be placed safely</span>`
    : ''
  el.innerHTML = `
    <span class="micro">${live.length} PROPOSED CHANGE${live.length === 1 ? '' : 'S'}</span>
    <span class="st-origin">from learning</span>
    ${dropped}
    <span class="st-head-actions">
      <button type="button" class="btn-acceptall" data-action="vx-accept-all" title="Accept all (⇧A from a change)">Accept all</button>
      <button type="button" class="btn-quiet" data-action="vx-dismiss-all" title="Not this time">Dismiss all</button>
    </span>`
}

function updateStale() {
  const el = qs('#vxStale')
  if (!el) return
  const ids = new Set(state.voices.stale.map(x => x.id))
  for (const id of unanchored) ids.add(id)
  if (!ids.size) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.innerHTML = `${ids.size} proposal${ids.size === 1 ? ' no longer applies' : 's no longer apply'} —
    <button type="button" class="btn-quiet" data-action="vx-stale-dismiss" title="Clear them">Dismiss</button>`
}

function updateErr() {
  const el = qs('#vxErr')
  if (!el) return
  el.hidden = !state.voices.error
  el.innerHTML = state.voices.error
    ? `<div class="properr-card">${escapeHtml(state.voices.error)}
        <button type="button" class="btn-quiet" data-action="vx-err-dismiss" title="Dismiss">Dismiss</button></div>`
    : ''
}

// ── Learning panel ──

function sparklineSvg(trend) {
  if (!trend.length) return ''
  const w = 180
  const h = 36
  const n = trend.length
  const x = i => n === 1 ? w / 2 : 2 + (i / (n - 1)) * (w - 8)
  const y = v => h - 4 - Math.max(0, Math.min(1, v)) * (h - 8)
  const pts = trend.map((p, i) => `${x(i).toFixed(1)},${y(p.mean).toFixed(1)}`).join(' ')
  const last = trend[n - 1]
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="var(--color-ink-3)" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${x(n - 1).toFixed(1)}" cy="${y(last.mean).toFixed(1)}" r="1.5" fill="var(--color-accent)" stroke="none"/>
  </svg>`
}

function updatePanel() {
  const el = qs('#vcPanel')
  if (!el) return
  const vs = state.voices
  const metrics = vs.metrics || { perVoice: [], funnel: { drafts: 0, sent: 0, untouched: 0 } }
  const mine = metrics.perVoice.find(p => p.voiceId === vs.activeId)
  const scored = mine?.scoredSends ?? 0

  let survival = ''
  if (scored >= 10 && mine.survivalTrend.length) {
    const last = mine.survivalTrend[mine.survivalTrend.length - 1]
    survival = `${sparklineSvg(mine.survivalTrend)}
      <div class="panel-stat"><span class="panel-big">${Math.round(last.mean * 100)}%</span>
      <span class="panel-sub">${scored} scored sends</span></div>`
  } else {
    const dots = Array.from({ length: 10 }, (_, i) =>
      `<span class="seg-dot${i < scored ? ' filled' : ''}"></span>`).join('')
    survival = `<div class="panel-collect">collecting — ${scored} of 10</div>
      <div class="seg-row" aria-hidden="true">${dots}</div>`
  }

  const f = metrics.funnel
  const max = Math.max(1, f.drafts, f.sent, f.untouched)
  const bar = (n, cls) => `<span class="funnel-bar ${cls}" style="width:${Math.max(2, (n / max) * 100)}%"></span>`
  const funnel = `
    <div class="funnel-row"><span class="funnel-n">${fmtCount(f.drafts)}</span> drafted ${bar(f.drafts, 'rule')}</div>
    <div class="funnel-row"><span class="funnel-n">${fmtCount(f.sent)}</span> sent ${bar(f.sent, 'rule')}</div>
    <div class="funnel-row"><span class="funnel-n">${fmtCount(f.untouched)}</span> untouched ${bar(f.untouched, 'add')}</div>`

  const lessons = vs.lessons.length
    ? vs.lessons.slice(0, 6).map(l => `<div class="lesson">
        <span class="lesson-q">“${escapeHtml(l.comment)}”</span>
        ${l.at ? `<span class="lesson-t">${escapeHtml(relTime(new Date(l.at).getTime()))}</span>` : ''}
      </div>`).join('')
    : '<div class="lesson-empty">No lessons yet — reject a suggestion with a note and it lands here.</div>'

  el.innerHTML = `
    <div class="micro panel-head">First-draft survival</div>
    ${survival}
    <div class="panel-sep"></div>
    <div class="micro panel-head">Untouched funnel</div>
    ${funnel}
    <div class="panel-sep"></div>
    <div class="micro panel-head">Recent lessons</div>
    ${lessons}`
}

// ── Hunk ops (voice flavour of the studio loop) ──

export function activateHunk(id, { focus = true } = {}) {
  const vs = state.voices
  if (vs.demoted.has(id)) vs.demoted.delete(id)
  vs.activeHunkId = id
  syncEditor(focus ? { strip: true } : undefined)
  updateHead()
}

export function cycleHunk(dir) {
  const vs = state.voices
  const next = nextActive(vms, vs.activeHunkId, dir, vs.demoted)
  if (next) activateHunk(next)
}

function resolveLocally(id, status) {
  const h = state.voices.proposal?.hunks.find(x => x.id === id)
  if (h) h.status = status
  state.voices.demoted.delete(id)
}

function focusAfterResolve(vm) {
  const vs = state.voices
  relocate()
  const live = vms.filter(v => !vs.demoted.has(v.id))
  if (live.length > 0) {
    const next = live.find(v => v.start >= vm.start) || live[0]
    vs.activeHunkId = next.id
    syncEditor({ strip: true })
  } else {
    vs.activeHunkId = null
    syncEditor({ offset: Math.min(vm.start + (vm.kind === 'add' ? vm.proposed_text.length : 0), vs.body.length) })
  }
  updateHead()
  updateStale()
}

export async function acceptHunk(id) {
  const vs = state.voices
  const vm = vms.find(v => v.id === id)
  if (!vm) return
  await data.flushVoiceEdits()
  const snapshot = { body: vs.body, hunks: vs.proposal.hunks.map(h => ({ ...h })) }
  const local = applyHunkLocal(vs.body, vm)
  resolveLocally(id, 'accepted')
  if (local != null) vs.body = local
  focusAfterResolve(vm)
  const r = await data.acceptHunk(id)
  if (!r.ok) {
    vs.body = snapshot.body
    vs.proposal.hunks = snapshot.hunks
    vs.error = `Couldn’t apply the change — ${r.error}`
    syncEditor()
    updateErr()
    return
  }
  if (r.value.body != null) vs.body = r.value.body
  const voice = activeVoice()
  if (voice) voice.bodyMd = vs.body
  syncEditor()
  updateHead()
  updateStale()
}

export async function rejectHunk(id, comment = '') {
  const vs = state.voices
  const vm = vms.find(v => v.id === id)
  if (!vm) return
  resolveLocally(id, 'rejected')
  vs.commentFor = null
  focusAfterResolve(vm)
  const r = await data.rejectHunk(id, comment || undefined)
  if (!r.ok) {
    resolveLocally(id, 'pending')
    vs.error = `Couldn’t reject — ${r.error}`
    syncEditor()
    updateErr()
  }
}

export async function acceptAll() {
  const vs = state.voices
  await data.flushVoiceEdits()
  const order = vms.filter(v => !vs.demoted.has(v.id))
  if (!order.length) return
  for (const vm of order) {
    const next = applyHunkLocal(vs.body, vm)
    if (next != null) vs.body = next
    resolveLocally(vm.id, 'accepted')
  }
  vs.activeHunkId = null
  syncEditor({ end: true })
  updateHead()
  let failed = null
  for (const vm of order) {
    const r = await data.acceptHunk(vm.id)
    if (!r.ok) { failed = r.error; break }
    if (r.value.body != null) vs.body = r.value.body
  }
  if (failed) {
    vs.error = `Couldn’t accept everything — ${failed}`
    await data.loadVoices()
  }
  const voice = activeVoice()
  if (voice) voice.bodyMd = vs.body
  syncEditor()
  updateHead()
  updateStale()
  updateErr()
}

export function openComment(id) {
  commentValue = ''
  state.voices.commentFor = id
  ed.refreshStrip()
  bindCommentInput()
}

export async function submitComment() {
  const vs = state.voices
  const id = vs.commentFor
  const comment = commentValue.trim()
  if (!id || !comment) return
  vs.commentFor = null
  vs.revisingFor = id
  ed.refreshStrip()
  const r = await data.commentHunk(id, comment)
  vs.revisingFor = null
  if (r.ok && r.value.kind === 'proposal') {
    vs.proposal = r.value.proposal
    const voice = activeVoice()
    if (voice) voice.proposal = r.value.proposal
    vs.demoted = new Set()
    vs.stale = []
    vs.activeHunkId = null
    relocate()
    vs.activeHunkId = firstPending(vms, vs.demoted)
    syncEditor({ strip: true })
    updateHead()
  } else {
    vs.error = 'The AI couldn’t produce a valid change here'
    ed.refreshStrip()
    updateErr()
  }
}

export function rejectWithNote() {
  const vs = state.voices
  const id = vs.commentFor
  vs.commentFor = null
  if (id) rejectHunk(id, commentValue.trim())
}

export function exitStripToEditor() {
  const vm = vms.find(v => v.id === state.voices.activeHunkId)
  ed?.focusBodyOffset(vm ? vm.start : 0)
}

export function focusActiveStrip() {
  ed?.focusStrip()
}

// ── Distill (jobs_kick flywheel + honest completion) ──

async function distill() {
  const vs = state.voices
  if (vs.distilling) return
  vs.distilling = true
  updateVoices()
  const r = await data.kickJob('flywheel')
  if (!r.ok) {
    vs.distilling = false
    vs.error = `Distill failed — ${r.error}`
    updateVoices()
    return
  }
  // No push channel: poll for new proposals, answer the click honestly.
  const before = vs.list.filter(v => v.proposal).length
  let ticks = 0
  if (distillPoll) clearInterval(distillPoll)
  distillPoll = setInterval(async () => {
    ticks++
    await data.loadVoices()
    const after = state.voices.list.filter(v => v.proposal).length
    if (after > before || ticks >= 12) {
      clearInterval(distillPoll)
      distillPoll = null
      state.voices.distilling = false
      if (after <= before) showToast('Not enough new sends to learn from yet')
      render()
    } else {
      updateVoices()
    }
  }, 2500)
}

// ── Actions ──

function hunkIdFrom(el) {
  return el?.closest?.('.strip')?.dataset.hunk || state.voices.activeHunkId
}

export const voicesActions = {
  'voices-back': () => { data.openInbox() },
  'pick-voice-tab': async (el) => {
    const vs = state.voices
    await data.flushVoiceEdits()
    vs.activeId = el.dataset.id
    const voice = activeVoice()
    vs.body = voice?.bodyMd ?? ''
    vs.proposal = voice?.proposal ?? null
    vs.demoted = new Set()
    vs.stale = []
    vs.activeHunkId = null
    vs.commentFor = null
    render()
  },
  'seed-looks-right': () => {
    state.voices.seedBannerDismissed = true
    updateVoices()
  },
  'seed-voices': async () => {
    state.voices.error = ''
    await data.kickJob('seed_voices')
    await data.refreshConn()
    render()
  },
  'distill': () => { distill() },
  'open-voice-more': (el) => {
    if (state.menus.voiceMore) { closeMenus(); render(); return }
    const rect = el.getBoundingClientRect()
    openMenu('voiceMore', { x: rect.right, y: rect.bottom + 4, invokerId: 'btnVoiceMore', align: 'right' })
  },
  'voice-rename': () => {
    closeMenus()
    state.voices.renaming = true
    render()
  },
  'voice-archive': async () => {
    closeMenus()
    const voice = activeVoice()
    if (!voice) return
    const r = await data.updateVoiceMeta(voice.id, { archived: true })
    if (r.ok) {
      await data.loadVoices()
      state.voices.activeId = state.voices.list[0]?.id ?? null
      const next = activeVoice()
      state.voices.body = next?.bodyMd ?? ''
      state.voices.proposal = next?.proposal ?? null
    }
    render()
  },
  'vx-accept-all': () => { acceptAll() },
  'vx-dismiss-all': async () => {
    const vs = state.voices
    if (!vs.proposal) return
    const pid = vs.proposal.id
    vs.proposal = null
    const voice = activeVoice()
    if (voice) voice.proposal = null
    vs.demoted = new Set()
    vs.activeHunkId = null
    syncEditor()
    updateHead()
    render()
    await data.dismissProposal(pid, false)
  },
  'vx-stale-dismiss': () => {
    const vs = state.voices
    for (const id of [...unanchored, ...vs.stale.map(x => x.id)]) {
      const h = vs.proposal?.hunks.find(x => x.id === id)
      if (h && h.status === 'pending') h.status = 'stale'
    }
    vs.stale = []
    relocate()
    if (vs.proposal && !vs.proposal.hunks.some(h => h.status === 'pending')) vs.proposal = null
    syncEditor()
    updateHead()
    updateStale()
  },
  'vx-err-dismiss': () => { state.voices.error = ''; updateErr() },
}

export function voiceMoreMenuHtml() {
  return `<div class="menu" role="menu" aria-label="Voice options" data-menu="voiceMore">
    <button type="button" class="menu-item" role="menuitem" data-action="voice-rename" title="Rename this voice">Rename…</button>
    <button type="button" class="menu-item danger" role="menuitem" data-action="voice-archive" title="Archive this voice">Archive</button>
  </div>`
}
