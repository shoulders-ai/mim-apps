// Thread view (UX-SPEC §3.3): message column with collapse/expand,
// quoted-trail folding, the draft chip, and the studio dock host.

import { state, render, openMenu, closeMenus } from './state.js'
import { escapeHtml, escapeAttr, qs, fmtTime, fmtLongTime, cleanBodyText, cleanSnippet } from './utils.js'
import { icon } from './icons.js'
import * as data from './data.js'

// Display-side body cleanup (utils.cleanBodyText re-exported under the
// view's name so tests pin the reading-pane contract here).
export const cleanBody = cleanBodyText

// Escape + linkify in one pass: tokenize the RAW text so URLs are matched
// before escaping, then escape each side. Anchors are the app's only
// pointer-cursor elements (§7.1); newsletters are unreadable without them.
export function linkify(text) {
  const raw = String(text ?? '')
  const re = /https?:\/\/[^\s<>"')\]]+/g
  let html = ''
  let last = 0
  let m
  while ((m = re.exec(raw))) {
    let url = m[0]
    const trail = /[.,;:!?]+$/.exec(url)
    if (trail) url = url.slice(0, url.length - trail[0].length)
    html += escapeHtml(raw.slice(last, m.index))
    html += `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
    last = m.index + url.length
  }
  html += escapeHtml(raw.slice(last))
  return html
}

// Fold a trailing quote block ("On … wrote:" + "> " lines) behind a toggle.
export function foldQuoted(text) {
  const body = String(text ?? '')
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!(/^On .{0,140} wrote:\s*$/.test(l) || /^>/.test(l))) continue
    const rest = lines.slice(i).filter(x => x.trim() !== '')
    if (rest.length === 0) continue
    const quoteish = rest.filter(x => /^>/.test(x) || /^On .{0,140} wrote:\s*$/.test(x))
    if (quoteish.length / rest.length >= 0.6 && i > 0) {
      return {
        main: lines.slice(0, i).join('\n').replace(/\n+$/, ''),
        quoted: lines.slice(i).join('\n'),
      }
    }
  }
  return { main: body, quoted: '' }
}

export function threadPaneHtml() {
  // tabindex lives on the SCROLL CONTAINER, not the pane — focusing the pane
  // left arrow/PageDown/Space dead because the child owns the overflow.
  return `<div class="thread-pane" id="threadPane">
    <div class="th-head" id="threadHead"></div>
    <div class="th-scroll" id="threadScroll" tabindex="-1" data-region="thread">
      <div class="th-col">
        <div id="threadMessages"></div>
        <div id="draftChip"></div>
        <div id="studioHost"></div>
      </div>
    </div>
  </div>`
}

function recipientsLabel(msg) {
  const own = (state.conn.email || '').toLowerCase()
  const names = [...msg.to, ...msg.cc].map(a =>
    a.email && a.email.toLowerCase() === own ? 'you' : data.addrDisplay(a),
  ).filter(Boolean)
  if (!names.length) return ''
  return `to ${names.join(', ')}`
}

function messageHtml(msg) {
  const expanded = state.thread.expanded.has(msg.id)
  const sender = msg.isFromMe ? 'You' : (msg.fromName || msg.fromEmail || '—')
  if (!expanded) {
    return `<button type="button" class="msg-row" data-action="toggle-msg" data-id="${escapeAttr(msg.id)}"
      title="Expand message">
      <span class="msg-caret" aria-hidden="true">${icon('chevron-right', 12)}</span>
      <span class="msg-sender">${escapeHtml(sender)}</span>
      <span class="msg-snip">${escapeHtml(cleanSnippet(msg.snippet))}</span>
      <span class="msg-date">${escapeHtml(fmtTime(msg.date))}</span>
    </button>`
  }
  const { main, quoted } = foldQuoted(cleanBody(msg.body))
  const showQuoted = state.thread.unquoted.has(msg.id)
  const addr = msg.isFromMe ? (state.conn.email || '') : (msg.fromEmail || '')
  const showAddr = addr && addr.toLowerCase() !== sender.toLowerCase()
  const recipients = recipientsLabel(msg)
  const quotedLines = quoted ? quoted.split('\n').filter(l => l.trim() !== '').length : 0
  return `<div class="msg-open">
    <button type="button" class="msg-openhead" data-action="toggle-msg" data-id="${escapeAttr(msg.id)}"
      title="Collapse message">
      <span class="msg-caret" aria-hidden="true">${icon('chevron-down', 12)}</span>
      <span class="msg-head-main">
        <span class="msg-head-l1">
          <span class="msg-sender">${escapeHtml(sender)}</span>
          ${showAddr ? `<span class="msg-addr">${escapeHtml(addr)}</span>` : ''}
        </span>
        ${recipients && recipients !== 'to you' ? `<span class="msg-head-l2">${escapeHtml(recipients)}</span>` : ''}
      </span>
      <span class="msg-date">${escapeHtml(fmtLongTime(msg.date))}</span>
    </button>
    <div class="msg-body">${linkify(main)}</div>
    ${quoted ? (showQuoted
      ? `<button type="button" class="quote-toggle" data-action="toggle-quote" data-id="${escapeAttr(msg.id)}" title="Hide quoted trail">× hide quoted</button>
         <div class="msg-body msg-quoted">${linkify(quoted)}</div>`
      : `<button type="button" class="quote-toggle" data-action="toggle-quote" data-id="${escapeAttr(msg.id)}" title="Show quoted trail">› quoted (${quotedLines} line${quotedLines === 1 ? '' : 's'})</button>`) : ''}
  </div>`
}

export function updateThread() {
  const head = qs('#threadHead')
  const msgs = qs('#threadMessages')
  const chip = qs('#draftChip')
  if (!head || !msgs) return
  const t = state.thread.thread
  const narrow = state.breakpoint === 'narrow'
  const freshCompose = !state.route.threadId

  head.innerHTML = `
    ${narrow || freshCompose ? `<button type="button" class="hd-back" data-action="back-to-list" title="Back to inbox (u)">
      ${icon('arrow-left')}<span>Inbox</span></button>` : ''}
    <span class="th-subject">${escapeHtml(freshCompose ? 'New message' : (t?.subject || '(no subject)'))}</span>
    ${freshCompose ? '' : `<span class="th-actions">
      <button type="button" class="icon-btn" data-action="thread-reply" title="Reply (r)">${icon('reply')}</button>
      <button type="button" class="icon-btn" data-action="thread-archive" title="Archive (e)">${icon('archive')}</button>
      <button type="button" class="icon-btn" id="btnThreadMore" data-action="thread-more" title="More" aria-haspopup="true">${icon('dots')}</button>
    </span>`}`

  if (freshCompose) {
    msgs.innerHTML = ''
    if (chip) chip.innerHTML = ''
    return
  }
  if (state.thread.error) {
    msgs.innerHTML = `<div class="th-error">Couldn’t load this thread ·
      <button type="button" class="btn-quiet" data-action="thread-retry" title="Try again">Retry</button></div>`
    return
  }
  if (!state.thread.messages.length) {
    msgs.innerHTML = '<div class="skel-line"></div><div class="skel-line"></div><div class="skel-line short"></div>'
    return
  }
  // Background refreshes must not steal focus off a message row (§5.2).
  const focusedMsg = msgs.contains(document.activeElement)
    ? document.activeElement.closest('[data-id]')?.dataset.id
    : null
  msgs.innerHTML = state.thread.messages.map(messageHtml).join('')
  if (focusedMsg) msgs.querySelector(`[data-id="${CSS.escape(focusedMsg)}"]`)?.focus()

  if (chip) {
    const draft = state.thread.drafts[0]
    chip.innerHTML = draft && !state.studio.open
      ? `<button type="button" class="draft-chip" data-action="continue-draft" data-id="${escapeAttr(draft.id)}"
          title="Open the draft (r)">Draft in progress — continue (r)</button>`
      : ''
  }
}

export function threadMoreMenuHtml() {
  const t = state.thread.thread
  const gmailUrl = t?.gmailId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(t.gmailId)}` : ''
  return `<div class="menu" role="menu" aria-label="Thread actions" data-menu="threadMore">
    <button type="button" class="menu-item" role="menuitem" data-action="mark-unread" title="Mark this thread unread">Mark unread</button>
    ${gmailUrl ? `<a class="menu-item" role="menuitem" href="${escapeAttr(gmailUrl)}" target="_blank" rel="noreferrer"
      data-action="menu-close" title="Open this thread in Gmail">Open in Gmail ↗</a>` : ''}
  </div>`
}

export function moveThread(dir) {
  const rows = state.inbox.threads.filter(r => r.kind !== 'draft')
  if (!rows.length) return
  const i = rows.findIndex(r => r.id === state.inbox.selectedId)
  const next = rows[Math.max(0, Math.min(rows.length - 1, i === -1 ? 0 : i + dir))]
  if (!next || next.id === state.route.threadId) return
  state.inbox.selectedId = next.id
  data.openThread(next.id)
}

export const threadActions = {
  'toggle-msg': (el) => {
    const id = el.dataset.id
    if (state.thread.expanded.has(id)) state.thread.expanded.delete(id)
    else state.thread.expanded.add(id)
    updateThread()
  },
  'toggle-quote': (el) => {
    const id = el.dataset.id
    if (state.thread.unquoted.has(id)) state.thread.unquoted.delete(id)
    else state.thread.unquoted.add(id)
    updateThread()
  },
  'back-to-list': () => {
    data.backToList()
    requestAnimationFrame(() => {
      const sel = state.inbox.selectedId
      if (sel) qs(`#listRows [data-id="${CSS.escape(String(sel))}"]`)?.focus()
    })
  },
  'thread-retry': () => {
    if (state.route.threadId) data.loadThread(state.route.threadId).then(render)
  },
  'thread-more': (el) => {
    if (state.menus.threadMore) {
      closeMenus()
      render()
      return
    }
    const rect = el.getBoundingClientRect()
    openMenu('threadMore', { x: rect.right, y: rect.bottom + 4, invokerId: 'btnThreadMore', align: 'right' })
  },
  'mark-unread': async () => {
    closeMenus()
    const id = state.route.threadId
    if (!id) return
    const row = state.inbox.threads.find(r => r.id === id)
    if (row) row.unread = true
    render()
    await data.markUnread(id)
  },
  'menu-close': () => {
    closeMenus()
    render()
  },
}
