// Inbox surface (UX-SPEC §3.2): header, tab row, sync cell, list rows,
// paging sentinel, and the settings popover (§3.6).

import { state, render, showToast, openMenu, closeMenus } from './state.js'
import { escapeHtml, escapeAttr, qs, fmtTime, fmtCount, relTime, debounce } from './utils.js'
import { icon } from './icons.js'
import * as data from './data.js'

const TABS = [
  { id: 'inbox', label: 'Inbox', key: '1' },
  { id: 'all', label: 'All', key: '2' },
  { id: 'sent', label: 'Sent', key: '3' },
  { id: 'drafts', label: 'Drafts', key: '4' },
]

// ── Command bar (36px — app label, tabs, search, actions) ──

export function renderCommandBar() {
  const bar = qs('#cmdBar')
  if (!bar) return
  const connected = state.conn.connected && state.route.view !== 'onboarding'
  if (!connected) {
    bar.innerHTML = `<span class="cmd-app">Mail</span>`
    return
  }
  const compact = state.compact
  const searchFocused = document.activeElement?.id === 'searchInput'
  const searchVal = qs('#searchInput')?.value ?? state.inbox.query
  const voicesDot = state.conn.seedState === 'ready' || state.voices.hasPending
  const inMail = state.route.view !== 'voices'
  const tabs = TABS.map(t => `
    <button type="button" class="tab${inMail && state.inbox.tab === t.id ? ' active' : ''}"
      data-action="switch-tab" data-tab="${t.id}" title="${t.label} (${t.key})">${t.label}</button>`).join('')
  const focusedTab = bar.contains(document.activeElement)
    ? document.activeElement.dataset.tab || document.activeElement.dataset.action
    : null
  bar.innerHTML = `
    <span class="cmd-app">Mail</span>
    ${tabs}
    <span class="cmd-sep" aria-hidden="true"></span>
    <button type="button" class="tab${state.route.view === 'voices' ? ' active' : ''}" data-action="open-voices"
      title="Voices &amp; Learning">Voices${voicesDot ? '<span class="pill-dot" aria-hidden="true"></span>' : ''}</button>
    <div class="cmd-right">
      <div class="search-box${compact ? ' compact' : ''}" id="searchBox">
        ${icon('search')}
        <input id="searchInput" class="search-input" type="text" data-region="input"
          placeholder="Search mail" title="Search mail (/)" value="${escapeAttr(searchVal)}"
          aria-label="Search mail">
      </div>
      <button type="button" class="icon-btn" id="btnCompose" data-action="compose" title="Compose (c)">${icon('compose')}</button>
      <button type="button" class="icon-btn${state.refreshing ? ' spinning' : ''}" id="btnRefresh"
        data-action="refresh" title="Refresh">${icon('refresh')}</button>
      <button type="button" class="icon-btn${state.menus.settings ? ' menu-open' : ''}" id="btnSettings" data-action="open-settings"
        title="Settings" aria-haspopup="true">${icon('gear')}</button>
    </div>`
  const input = qs('#searchInput')
  input.addEventListener('input', onSearchInput)
  input.addEventListener('focus', () => qs('#searchBox')?.classList.add('expanded'))
  input.addEventListener('blur', () => qs('#searchBox')?.classList.remove('expanded'))
  if (searchFocused) {
    input.focus()
    const end = input.value.length
    try { input.setSelectionRange(end, end) } catch {}
  }
  if (focusedTab) {
    (qs(`#cmdBar [data-tab="${CSS.escape(focusedTab)}"]`)
      || qs(`#cmdBar [data-action="${CSS.escape(focusedTab)}"]`))?.focus()
  }
}

const searchDebounced = debounce(async () => {
  await data.loadInbox({ reset: true })
  renderList()
  renderSyncCell()
}, 200)

function onSearchInput(e) {
  state.inbox.query = e.target.value
  searchDebounced()
}

// ── Sync cell (status bar left slot; a transient message takes priority) ──

export function renderSyncCell() {
  const cell = qs('#statusSync')
  const line = qs('#syncProgress')
  if (!cell) return
  if (state.toast.msg || state.banner === 'reconnect') {
    // Messages own the slot; the banner owns auth state (§5.6).
    cell.innerHTML = ''
    if (line) line.hidden = true
    return
  }
  const bf = state.conn.backfill
  if (bf.state === 'running') {
    const total = bf.total > 0 ? `~${fmtCount(bf.total)}` : '…'
    cell.innerHTML = `syncing ${fmtCount(bf.done)} / ${total}`
    if (line && bf.total > 0) {
      line.hidden = false
      line.style.width = `${Math.min(100, (bf.done / bf.total) * 100)}%`
    }
    return
  }
  if (line) line.hidden = true
  if (state.conn.syncError) {
    cell.innerHTML = `sync failed · <button type="button" class="btn-cell" data-action="retry-sync" title="Retry sync">Retry</button>`
    return
  }
  const last = state.conn.lastSyncAt ? new Date(state.conn.lastSyncAt).getTime() : 0
  if (last && Date.now() - last > 75000) {
    cell.innerHTML = `synced ${escapeHtml(relTime(last))}`
  } else {
    cell.innerHTML = '' // silence = healthy
  }
}

// ── List pane ──

export function listPaneHtml() {
  return `<div class="list-pane" id="listPane" data-region="list">
    <div id="listNote"></div>
    <div id="listRows" role="listbox" aria-label="Threads"></div>
    <div id="listSentinel" aria-hidden="true"></div>
  </div>`
}

function emptyText() {
  const { tab, query } = state.inbox
  if (query) return `No matches for “${query}”.`
  if (tab === 'inbox') return 'Inbox zero.'
  if (tab === 'sent') {
    const days = state.settings.syncWindowDays
    return days ? `No sent mail in the last ${days} days.` : 'No sent mail synced yet.'
  }
  if (tab === 'drafts') return 'No drafts.'
  return 'Nothing here yet.'
}

// One-line 28px rows (§3.2): marker · sender · subject—snippet · flags ·
// time. The subject renders at EVERY pane width — no compact variant.
function threadRowHtml(row) {
  const selected = state.inbox.selectedId === row.id
  const showTo = state.inbox.tab === 'sent'
  const fromLabel = showTo
    ? `To: ${row.to.map(data.addrDisplay).filter(Boolean).join(', ') || '—'}`
    : (row.fromName || row.fromEmail || '—')
  return `<button type="button" role="option" aria-selected="${selected}" data-action="open-row" data-id="${escapeAttr(row.id)}"
    class="trow${row.unread ? ' unread' : ''}${selected ? ' selected' : ''}"
    title="${escapeAttr(row.subject || '(no subject)')}">
    <span class="trow-marker" aria-hidden="true">${row.unread ? '<span class="unread-dot"></span>' : ''}</span>
    <span class="trow-from">${escapeHtml(fromLabel)}</span>
    <span class="trow-main">
      <span class="trow-subject">${escapeHtml(row.subject || '(no subject)')}</span><span class="trow-snip">${row.snippet ? ` — ${escapeHtml(row.snippet)}` : ''}</span>
    </span>
    <span class="trow-flags">
      ${row.messageCount > 1 ? `<span class="trow-count">⌗${row.messageCount}</span>` : ''}
      ${row.hasAttachments ? `<span class="trow-clip">${icon('paperclip', 12)}</span>` : ''}
      <span class="trow-arch" role="button" tabindex="-1" data-action="row-archive" data-id="${escapeAttr(row.id)}"
        title="Archive (e)">${icon('archive', 12)}</span>
    </span>
    <span class="trow-time">${escapeHtml(fmtTime(row.lastMessageAt))}</span>
  </button>`
}

function draftRowHtml(row) {
  const toNames = row.to.map(data.addrDisplay).filter(Boolean).join(', ') || '—'
  const chip = row.state === 'approved'
    ? '<span class="chip-state">approved</span>'
    : row.state === 'send_failed'
      ? '<span class="chip-state failed">send failed</span>'
      : ''
  return `<button type="button" role="option" aria-selected="false" data-action="open-draft-row" data-id="${escapeAttr(row.draftId)}"
    data-thread="${escapeAttr(row.threadId || '')}" class="trow"
    title="${escapeAttr(row.subject || '(no subject)')}">
    <span class="trow-marker" aria-hidden="true"></span>
    <span class="trow-from">To: ${escapeHtml(toNames)}</span>
    <span class="trow-main">
      <span class="trow-subject">${escapeHtml(row.subject || '(no subject)')}</span><span class="trow-snip">${row.snippet ? ` — ${escapeHtml(row.snippet)}` : ''}</span>
    </span>
    <span class="trow-flags">${chip}</span>
    <span class="trow-time">${escapeHtml(fmtTime(row.updatedAt))}</span>
  </button>`
}

export function renderList() {
  const rowsEl = qs('#listRows')
  const noteEl = qs('#listNote')
  if (!rowsEl) return

  if (noteEl) {
    noteEl.innerHTML = state.inbox.query && state.conn.backfill.state === 'running'
      ? `<div class="list-note">Searching ${fmtCount(state.conn.backfill.done)} synced messages so far</div>`
      : ''
  }

  const { threads, loaded, error } = state.inbox
  if (!loaded && threads.length === 0) {
    rowsEl.innerHTML = Array.from({ length: 8 }, () => '<div class="skel-row"></div>').join('')
    return
  }
  let html = ''
  if (error) {
    html += `<div class="list-error">${escapeHtml(error)}
      <button type="button" class="btn-quiet" data-action="reload-list" title="Try again">Retry</button></div>`
  }
  if (threads.length === 0) {
    if (!error) html += `<div class="list-empty">${escapeHtml(emptyText())}</div>`
  } else {
    html += threads.map(r => (r.kind === 'draft' ? draftRowHtml(r) : threadRowHtml(r))).join('')
  }
  // Background refreshes must not steal focus off a row (§5.2).
  const focusedId = rowsEl.contains(document.activeElement)
    ? document.activeElement.closest('[data-id]')?.dataset.id
    : null
  rowsEl.innerHTML = html
  if (focusedId) qs(`#listRows [data-id="${CSS.escape(focusedId)}"]`)?.focus()
}

let sentinelObserver = null

export function observeSentinel() {
  const sentinel = qs('#listSentinel')
  if (!sentinel) return
  if (sentinelObserver) sentinelObserver.disconnect()
  sentinelObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) data.loadMore()
  }, { root: qs('#listPane'), rootMargin: '200px' })
  sentinelObserver.observe(sentinel)
}

// ── Selection / keyboard ──

export function focusRow(id) {
  const el = qs(`#listRows [data-id="${CSS.escape(String(id))}"]`)
  el?.focus()
  el?.scrollIntoView({ block: 'nearest' })
}

export function moveSelection(dir) {
  const rows = state.inbox.threads
  if (!rows.length) return
  const i = rows.findIndex(r => r.id === state.inbox.selectedId)
  const next = rows[Math.max(0, Math.min(rows.length - 1, i === -1 ? 0 : i + dir))]
  if (!next || next.id === state.inbox.selectedId) return
  state.inbox.selectedId = next.id
  if (state.breakpoint === 'wide' && state.inbox.tab !== 'drafts') {
    // WIDE: selection IS the open thread (§5.1).
    data.openThread(next.id).then(() => focusRow(next.id))
  } else {
    renderList()
    focusRow(next.id)
  }
}

export function openSelected() {
  const row = state.inbox.threads.find(r => r.id === state.inbox.selectedId)
  if (!row) return
  if (row.kind === 'draft') {
    openDraftRow(row.draftId, row.threadId)
    return
  }
  if (state.breakpoint === 'wide' && state.route.view === 'thread') {
    qs('#threadScroll')?.focus()
  } else {
    data.openThread(row.id)
  }
}

export async function archiveSelected(fromThread = false) {
  const rows = state.inbox.threads
  const i = rows.findIndex(r => r.id === state.inbox.selectedId)
  if (i === -1) return
  const row = rows[i]
  if (row.kind === 'draft') return
  // Optimistic: remove from the Inbox tab (archive = remove INBOX label;
  // the thread stays under All/Sent), select next (§5.4).
  const removes = state.inbox.tab === 'inbox'
  if (removes) rows.splice(i, 1)
  const next = removes ? (rows[Math.min(i, rows.length - 1)] || null) : row
  state.inbox.selectedId = next?.id ?? null
  const wasOpen = state.route.threadId === row.id
  if (wasOpen && removes) {
    // The open thread goes away — advance, then put focus back on the row
    // so j/k triage continues (§5.2: focus never falls to <body>).
    if (next && state.breakpoint === 'wide') data.openThread(next.id).then(() => focusRow(next.id))
    else if (next && fromThread && state.breakpoint === 'narrow') {
      data.backToList()
      requestAnimationFrame(() => focusRow(next.id))
    } else if (!next) data.backToList()
  }
  render()
  if (next && !(wasOpen && removes)) focusRow(next.id)
  const r = await data.archiveThread(row.id)
  if (!r.ok) {
    // Revert + inline is the rule for errors; the archive surface is gone,
    // so the row comes back and the failure reads inline in the list.
    if (removes) rows.splice(Math.min(i, rows.length), 0, row)
    state.inbox.selectedId = row.id
    state.inbox.error = `Couldn’t archive — ${r.error}`
    render()
    return
  }
  state.inbox.error = ''
  showToast('Archived', {
    label: 'Undo',
    fn: async () => {
      const undo = await data.unarchiveThread(row.id)
      if (undo.ok) {
        await data.loadInbox({ refresh: true })
        render()
      }
    },
  })
}

// Opening a draft row needs the studio; render.js injects the opener to
// keep view modules import-free of each other.
let draftOpener = () => {}

export function setDraftOpener(fn) {
  draftOpener = fn
}

export function openDraftRow(draftId, threadId) {
  state.route = { view: 'thread', threadId: threadId || null, draftId }
  render()
  if (threadId) data.loadThread(threadId).then(render)
  draftOpener(draftId, threadId || null)
}

// ── Settings popover (§3.6) ──

export function settingsMenuHtml() {
  const s = state.settings
  const days = s.syncWindowDays
  const options = [30, 90, 180, 365]
  return `<div class="menu settings-pop" role="dialog" aria-label="Settings" data-menu="settings">
    <div class="set-row"><span class="set-email">${escapeHtml(state.conn.email || '—')}</span></div>
    <div class="set-row">
      <span class="set-label">Sync window</span>
      <button type="button" class="set-select menu-item" data-action="toggle-sync-window"
        title="How far back to mirror mail">${days ? `${days}d` : '—'} ${icon('chevron-down', 12)}</button>
    </div>
    ${s.syncOpen ? options.map(d => `
      <button type="button" class="menu-item set-opt${d === days ? ' selected' : ''}" data-action="set-sync-window"
        data-days="${d}" title="Mirror the last ${d} days">${d === days ? icon('check', 12) : '<span class="menu-pad"></span>'} ${d} days</button>`).join('') : ''}
    <button type="button" class="menu-item" data-action="reseed-voices"
      title="Re-read your sent mail into voices">${s.seeding ? '<span class="spinner"></span> Seeding…' : 'Re-seed voices'}</button>
    <div class="menu-sep"></div>
    <button type="button" class="menu-item danger" data-action="disconnect"
      title="Keeps your local mail; removes the Google connection.">
      ${s.confirmDisconnect ? 'Disconnect — sure?' : 'Disconnect'}</button>
  </div>`
}

// ── Actions ──

export const inboxActions = {
  'open-row': (el) => {
    const id = el.dataset.id
    state.inbox.selectedId = id
    data.openThread(id)
  },
  'row-archive': (el, e) => {
    // Mouse affordance for e — the span sits inside the row button, so stop
    // the row's open from firing too.
    e?.stopPropagation?.()
    state.inbox.selectedId = el.dataset.id
    archiveSelected()
  },
  'open-draft-row': (el) => {
    openDraftRow(el.dataset.id, el.dataset.thread || null)
  },
  'switch-tab': async (el) => {
    switchTab(el.dataset.tab)
  },
  'open-voices': () => {
    data.openVoices()
  },
  'refresh': () => {
    data.manualRefresh()
  },
  'retry-sync': () => {
    data.retrySync()
  },
  'reload-list': async () => {
    state.inbox.error = ''
    await data.loadInbox({ reset: true })
    render()
  },
  'compose': () => {}, // wired in render.js (needs studio)
  'open-settings': (el) => {
    if (state.menus.settings) {
      closeMenus()
      render()
      return
    }
    state.settings.confirmDisconnect = false
    state.settings.syncOpen = false
    data.getSettings().then(render)
    const rect = el.getBoundingClientRect()
    openMenu('settings', { x: rect.right, y: rect.bottom + 4, invokerId: el.id, align: 'right' })
  },
  'toggle-sync-window': () => {
    state.settings.syncOpen = !state.settings.syncOpen
    render()
  },
  'set-sync-window': async (el) => {
    const days = Number(el.dataset.days)
    state.settings.syncWindowDays = days
    state.settings.syncOpen = false
    render()
    await data.setSyncWindow(days)
  },
  'reseed-voices': async () => {
    state.settings.seeding = true
    render()
    await data.kickJob('seed_voices')
    state.settings.seeding = false
    closeMenus()
    render()
  },
  'disconnect': async () => {
    if (!state.settings.confirmDisconnect) {
      state.settings.confirmDisconnect = true
      render()
      return
    }
    closeMenus()
    await data.disconnect()
    await data.refreshConn()
    state.route = { view: 'onboarding', threadId: null, draftId: null }
    state.onboarding.step = 5
    render()
  },
}

export async function switchTab(tab) {
  if (state.inbox.tab === tab) return
  state.inbox.tab = tab
  state.inbox.selectedId = null
  state.route = { view: 'inbox', threadId: null, draftId: null }
  render()
  await data.loadInbox({ reset: true })
  render()
}
