// Pure hunk view-model (UX-SPEC §7): document-order location, active-hunk
// cycling, demotion helpers, stale collapse, word-level diff, and strip
// rendering (string in, string out — node-testable).

import { escapeHtml, escapeAttr } from './utils.js'
import { splitParagraphs } from './editor.js'

export function nfc(s) {
  return String(s ?? '').normalize('NFC')
}

export function indexOfAll(hay, needle) {
  const out = []
  if (!needle) return out
  let at = hay.indexOf(needle)
  while (at !== -1) {
    out.push(at)
    at = hay.indexOf(needle, at + 1)
  }
  return out
}

// Locate pending hunks in the current body by unique exact match (the
// backend re-anchor pass guarantees uniqueness for pending hunks; anything
// that fails here is treated as unanchored and shown in the stale line).
// Returns { vms, unanchored } — vms sorted in document order.
export function locateHunks(body, hunks) {
  const text = nfc(body)
  const paras = splitParagraphs(text)
  const vms = []
  const unanchored = []
  for (const h of hunks || []) {
    if (h.status && h.status !== 'pending') continue
    const orig = nfc(h.original_text)
    const found = indexOfAll(text, orig)
    if (!orig || found.length !== 1) {
      unanchored.push(h.id)
      continue
    }
    const start = found[0]
    const end = start + orig.length
    let paraIndex = paras.findIndex(p => start >= p.start && end <= p.end)
    if (paraIndex === -1) paraIndex = paras.findIndex(p => start >= p.start && start <= p.end)
    vms.push({
      id: h.id,
      start,
      end,
      paraIndex,
      kind: nfc(h.proposed_text) === '' ? 'rem' : 'add',
      note: h.note || '',
      original_text: orig,
      proposed_text: nfc(h.proposed_text ?? ''),
    })
  }
  vms.sort((a, b) => a.start - b.start)
  return { vms, unanchored }
}

export function firstPending(vms, demoted = new Set()) {
  const v = vms.find(x => !demoted.has(x.id))
  return v ? v.id : null
}

// Document-order cycling with wrap (§3.4.2). Demoted hunks drop out of the
// cycle — they are being typed over.
export function nextActive(vms, activeId, dir = 1, demoted = new Set()) {
  const live = vms.filter(v => !demoted.has(v.id))
  if (live.length === 0) return null
  const i = live.findIndex(v => v.id === activeId)
  if (i === -1) return dir > 0 ? live[0].id : live[live.length - 1].id
  return live[(i + dir + live.length) % live.length].id
}

export function hunkIdsInParagraph(vms, paraIndex) {
  return vms.filter(v => v.paraIndex === paraIndex).map(v => v.id)
}

// Normalize a draft_edit/hunk_accept `hunk_changes` payload into
// { stale: [ids], pending: [ids] }. Accepts either an array of
// { id|hunk_id, status } rows or an object with id-list fields.
export function normHunkChanges(value) {
  const out = { stale: [], pending: [] }
  if (!value) return out
  if (Array.isArray(value)) {
    for (const row of value) {
      const id = row?.id ?? row?.hunk_id
      if (!id) continue
      if (row.status === 'stale' || row.status === 'dropped') out.stale.push(id)
      else if (row.status === 'pending') out.pending.push(id)
    }
    return out
  }
  if (Array.isArray(value.stale)) out.stale = value.stale.map(x => x?.id ?? x).filter(Boolean)
  if (Array.isArray(value.stale_ids)) out.stale = value.stale_ids.filter(Boolean)
  if (Array.isArray(value.pending)) out.pending = value.pending.map(x => x?.id ?? x).filter(Boolean)
  if (Array.isArray(value.pending_ids)) out.pending = value.pending_ids.filter(Boolean)
  return out
}

// Word-level diff for the strip preview: LCS over whitespace-preserving
// tokens; returns segments of `b` as [{ text, changed }].
export function diffWords(a, b) {
  const ta = tokens(a)
  const tb = tokens(b)
  if (tb.length === 0) return []
  if (ta.length === 0) return [{ text: tb.join(''), changed: true }]
  if (ta.length * tb.length > 250000) return [{ text: tb.join(''), changed: true }]

  const n = ta.length
  const m = tb.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const changed = new Array(m).fill(true)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      changed[j] = false
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  const segs = []
  for (let k = 0; k < m; k++) {
    // Whitespace tokens inherit their neighbours' state so marks do not
    // fragment on every space.
    const isWs = /^\s+$/.test(tb[k])
    const flag = isWs
      ? (changed[k - 1] ?? false) && (changed[k + 1] ?? false)
      : changed[k]
    const last = segs[segs.length - 1]
    if (last && last.changed === flag) last.text += tb[k]
    else segs.push({ text: tb[k], changed: flag })
  }
  return segs
}

function tokens(s) {
  return String(s ?? '').split(/(\s+)/).filter(t => t !== '')
}

// Optimistic local accept, mirroring backend semantics (CONTRACTS §4.4):
// replace the unique match; when proposed_text === '' collapse a 3+ newline
// seam to exactly two. Returns null when the hunk cannot be located.
export function applyHunkLocal(body, hunk) {
  const text = nfc(body)
  const orig = nfc(hunk.original_text)
  const found = indexOfAll(text, orig)
  if (found.length !== 1) return null
  const start = found[0]
  let before = text.slice(0, start)
  let after = text.slice(start + orig.length)
  const proposed = nfc(hunk.proposed_text ?? '')
  if (proposed === '') {
    const nb = /\n*$/.exec(before)[0].length
    const na = /^\n*/.exec(after)[0].length
    if (nb + na >= 3) {
      before = before.slice(0, before.length - nb)
      after = after.slice(na)
      return `${before}\n\n${after}`
    }
  }
  return before + proposed + after
}

// 'sentence' | 'paragraph' for the deletion strip's line 1.
export function classifyRemoval(vm, paraText) {
  return nfc(vm.original_text).trim() === nfc(paraText).trim() ? 'paragraph' : 'sentence'
}

// ── Strip rendering (pure string) ────────────────────────────────────────
//
// ctx: { index, total, paraText, commentOpen, commentValue, revising }

export function stripHtml(vm, ctx = {}) {
  const index = ctx.index ?? 1
  const total = ctx.total ?? 1
  const noteText = vm.kind === 'rem'
    ? `Remove this ${classifyRemoval(vm, ctx.paraText ?? '')}${vm.note ? ` — ${vm.note}` : ''}`
    : (vm.note || 'Suggested change')
  const label = `Proposed change ${index} of ${total}: ${noteText}`

  if (ctx.revising) {
    return `<div class="strip ${vm.kind} revising" tabindex="0" role="group" data-hunk="${escapeAttr(vm.id)}" data-region="strip" id="strip-${escapeAttr(vm.id)}" aria-label="${escapeAttr(label)}">
      <div class="strip-note"><span class="strip-star" aria-hidden="true">✦</span> <span class="strip-shimmer">Revising…</span></div>
    </div>`
  }

  let bodyHtml = ''
  if (vm.kind === 'add') {
    const segs = diffWords(vm.original_text, vm.proposed_text)
    const inner = segs
      .map(s => s.changed ? `<mark class="word">${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))
      .join('')
    bodyHtml = `<div class="strip-body">${inner}</div>`
  }

  const commentHtml = ctx.commentOpen
    ? `<div class="strip-comment">
        <input id="hunkCommentInput" data-region="comment" type="text"
          placeholder="What's wrong with this change?" value="${escapeAttr(ctx.commentValue ?? '')}"
          aria-label="Comment on this change">
        <button type="button" class="btn-quiet" data-action="hunk-comment-submit" title="Ask to revise (Enter)">Ask to revise</button>
        <button type="button" class="btn-quiet" data-action="hunk-reject-note" title="Reject and record the note">Reject with note</button>
      </div>`
    : ''

  return `<div class="strip ${vm.kind}" tabindex="0" role="group" data-hunk="${escapeAttr(vm.id)}" data-region="strip"
      id="strip-${escapeAttr(vm.id)}" aria-label="${escapeAttr(label)}">
    <div class="strip-note"><span class="strip-star" aria-hidden="true">✦</span> ${escapeHtml(noteText)}</div>
    ${bodyHtml}
    ${commentHtml}
    <div class="strip-foot">
      <span class="strip-count">${index} / ${total}</span>
      <span class="strip-actions">
        <button type="button" class="btn-quiet" data-action="hunk-accept" title="Accept (⏎)">Accept ⏎</button>
        <button type="button" class="btn-quiet" data-action="hunk-reject" title="Reject (⌫)">Reject ⌫</button>
        <button type="button" class="btn-quiet" data-action="hunk-comment-open" title="Comment (C)">Comment C</button>
      </span>
    </div>
  </div>`
}
