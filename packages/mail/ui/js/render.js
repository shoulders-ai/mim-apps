// Root dispatch (UX-SPEC §7): renders by route with a persistent studio,
// mounts banner/menus/toast, owns the ResizeObserver breakpoint, the
// action registry (clicks + shortcuts), and the Esc cascade.

import { state, setRenderFn, render, showToast, closeTopLayer, closeMenus, openMenuName } from './state.js'
import { escapeHtml, qs } from './utils.js'
import { SVG_DEFS, icon } from './icons.js'
import { initShortcuts, regionOf } from './shortcuts.js'
import { renderToast, toastActions } from './toast.js'
import * as data from './data.js'
import * as inbox from './inbox.js'
import * as thread from './thread.js'
import * as studio from './studio.js'
import * as voices from './voices.js'
import { renderOnboarding, bindOnboardingInputs, onboardingActions, focusStep } from './onboarding.js'

let lastShell = ''

// ── Root render ──

// Structure only — thread/draft/tab changes update content in place so
// j/k navigation never resets the list scroll or rebuilds the studio host.
function shellSignature() {
  return [
    state.route.view === 'thread' ? 'thread' : state.route.view,
    state.breakpoint, state.listCompact, state.conn.connected,
  ].join('|')
}

function renderMain() {
  const content = qs('#content')
  if (!content) return
  const sig = shellSignature()
  const structural = sig !== lastShell
  lastShell = sig

  if (state.route.view === 'boot') return

  if (state.route.view === 'onboarding') {
    content.innerHTML = renderOnboarding()
    bindOnboardingInputs(content)
    return
  }

  if (state.route.view === 'voices') {
    if (structural || !qs('#voicesView')) {
      studio.destroyStudio()
      content.innerHTML = voices.voicesViewHtml()
    }
    voices.updateVoices()
    return
  }

  // inbox / thread
  if (structural || !qs('#mailShell')) {
    const scroll = qs('#listPane')?.scrollTop ?? 0
    const showList = state.breakpoint === 'wide' || state.route.view === 'inbox'
    const showThread = state.route.view === 'thread'
    content.innerHTML = `<div class="mail-shell" id="mailShell">
      <div class="tabrow" id="tabRow"></div>
      <div class="panes">
        ${showList ? inbox.listPaneHtml() : ''}
        ${showThread ? thread.threadPaneHtml() : ''}
        ${!showThread && state.breakpoint === 'wide' ? '<div class="thread-pane empty-pane" id="threadPane" tabindex="-1" data-region="thread"><div class="pane-empty">Select a thread</div></div>' : ''}
      </div>
    </div>`
    inbox.observeSentinel()
    const pane = qs('#listPane')
    if (pane) pane.scrollTop = scroll
  }
  inbox.renderTabRow()
  inbox.renderList()
  if (state.route.view === 'thread') {
    thread.updateThread()
    studio.ensureStudio(qs('#studioHost'))
  }
}

function renderBanner() {
  const layer = qs('#bannerLayer')
  if (!layer) return
  if (state.banner !== 'reconnect' || state.route.view === 'onboarding') {
    layer.innerHTML = ''
    return
  }
  const rc = state.reconnect
  let action
  if (rc.waiting) {
    const left = Math.max(0, Math.ceil((rc.deadline - Date.now()) / 1000))
    action = `<span class="banner-wait"><span class="spinner" aria-hidden="true"></span>
      Waiting for Google… <span class="mono">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span></span>
      <button type="button" class="btn-quiet" data-action="reconnect-copy" title="Copy the consent URL">Copy link</button>`
  } else if (rc.connecting) {
    action = `<span class="banner-wait"><span class="spinner" aria-hidden="true"></span> Connecting…</span>`
  } else {
    action = `<button type="button" class="btn-banner" data-action="reconnect" title="Re-open Google consent">Reconnect</button>`
  }
  layer.innerHTML = `<div class="banner" role="alert">
    <span class="banner-icon">${icon('alert-triangle')}</span>
    <span class="banner-text">Gmail connection expired — your mail is paused.${rc.error ? ` ${escapeHtml(rc.error)}` : ''}</span>
    ${action}
  </div>`
}

// ── Menus ──

function menuHtml() {
  const name = openMenuName()
  if (!name) return ''
  switch (name) {
    case 'settings': return inbox.settingsMenuHtml()
    case 'voicePicker': return studio.voicePickerMenuHtml()
    case 'dismissAll': return studio.dismissAllMenuHtml()
    case 'overflow': return studio.overflowMenuHtml()
    case 'history': return studio.historyMenuHtml()
    case 'threadMore': return thread.threadMoreMenuHtml()
    case 'voiceMore': return voices.voiceMoreMenuHtml()
    default: return ''
  }
}

let menuWasOpen = null

function renderMenus() {
  const layer = qs('#menuLayer')
  if (!layer) return
  const name = openMenuName()
  const html = menuHtml()
  const hadFocus = layer.contains(document.activeElement)
  layer.innerHTML = html
  if (!html) {
    menuWasOpen = null
    return
  }
  const menu = layer.firstElementChild
  const a = state.menuAnchor || { x: 100, y: 100 }
  menu.style.position = 'fixed'
  menu.style.zIndex = '95'
  // Measure, then clamp into the viewport.
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  let x = a.align === 'right' ? a.x - w : a.x
  let y = a.up ? a.y - h : a.y
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8))
  y = Math.max(8, Math.min(y, window.innerHeight - h - 8))
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  menu.addEventListener('keydown', menuKeydown)
  if (menuWasOpen !== name) {
    menuWasOpen = name
    menu.querySelector('.menu-item')?.focus()
  } else if (hadFocus) {
    // A re-render replaced the open menu — keep focus inside it.
    (menu.querySelector('.menu-item.selected') || menu.querySelector('.menu-item'))?.focus()
  }
}

function menuKeydown(e) {
  const menu = e.currentTarget
  const items = Array.from(menu.querySelectorAll('.menu-item'))
  if (!items.length) return
  const i = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault()
    items[(i + 1 + items.length) % items.length].focus()
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault()
    items[(i - 1 + items.length) % items.length].focus()
  }
}

// ── Full render ──

function renderAll() {
  inbox.renderHeader()
  renderBanner()
  renderMain()
  renderMenus()
  renderToast()
}

// ── Actions registry ──

// Strip buttons live in both the studio and the voices editor — route by
// the active surface, with the strip's own hunk id winning over state.
function routeHunk(method, el) {
  const inVoices = state.route.view === 'voices'
  const surface = inVoices ? voices : studio
  const id = el?.closest?.('.strip')?.dataset.hunk
    || (inVoices ? state.voices.activeHunkId : state.studio.activeHunkId)
  if (id) surface[method](id)
}

const actions = {
  ...toastActions,
  ...onboardingActions,
  ...inbox.inboxActions,
  ...thread.threadActions,
  ...studio.studioActions,
  ...voices.voicesActions,
  'hunk-accept': (el) => { routeHunk('acceptHunk', el) },
  'hunk-reject': (el) => { routeHunk('rejectHunk', el) },
  'hunk-comment-open': (el) => { routeHunk('openComment', el) },
  'hunk-comment-submit': () => { hunkSurface().submitComment() },
  'hunk-reject-note': () => { hunkSurface().rejectWithNote() },
  'thread-reply': () => { studio.openReply() },
  'thread-archive': () => {
    if (state.route.threadId) state.inbox.selectedId = state.route.threadId
    inbox.archiveSelected(true)
  },
  'compose': () => { studio.openCompose() },
  'reconnect': async () => {
    const rc = state.reconnect
    rc.error = ''
    rc.connecting = true
    render()
    const r = await data.connectStart()
    if (!r.ok) {
      rc.connecting = false
      rc.error = r.error
      render()
      return
    }
    rc.connecting = false
    rc.waiting = true
    rc.consentUrl = r.value.consentUrl
    rc.deadline = Date.now() + 120000
    window.open(rc.consentUrl, '_blank')
    render()
    const timer = setInterval(async () => {
      if (!state.reconnect.waiting) { clearInterval(timer); return }
      renderBanner()
      await data.refreshConn()
      if (state.conn.tokenOk) {
        clearInterval(timer)
        state.reconnect = { connecting: false, waiting: false, consentUrl: '', deadline: 0, error: '' }
        await data.refetchActive()
        render()
      } else if (Date.now() > state.reconnect.deadline) {
        clearInterval(timer)
        state.reconnect.waiting = false
        state.reconnect.error = 'Timed out — try again.'
        render()
      }
    }, 2500)
  },
  'reconnect-copy': async () => {
    try {
      await navigator.clipboard.writeText(state.reconnect.consentUrl)
      showToast('Link copied')
    } catch {}
  },
}

// Route hunk-flavoured keyboard actions to the surface that owns the focus.
function hunkSurface() {
  return state.route.view === 'voices' ? voices : studio
}

function dispatch(action, detail = {}) {
  switch (action) {
    case 'escape':
      return handleEscape()
    case 'focus-search': {
      if (!state.conn.connected) return false
      if (state.route.view === 'voices') data.openInbox()
      requestAnimationFrame(() => qs('#searchInput')?.focus())
      return true
    }
    case 'list-next': inbox.moveSelection(1); return true
    case 'list-prev': inbox.moveSelection(-1); return true
    case 'list-open': {
      // Tab focus and j/k selection can diverge — open what the user is on.
      const focusedRow = document.activeElement?.closest?.('.trow')?.dataset.id
      if (focusedRow) state.inbox.selectedId = focusedRow
      inbox.openSelected()
      return true
    }
    case 'archive':
      if (!state.inbox.selectedId && state.route.threadId) state.inbox.selectedId = state.route.threadId
      inbox.archiveSelected(detail.scope === 'thread')
      return true
    case 'reply':
      if (state.route.view === 'thread') studio.openReply()
      else if (state.inbox.selectedId) {
        data.openThread(state.inbox.selectedId).then(() => studio.openReply())
      }
      return true
    case 'compose': studio.openCompose(); return true
    case 'tab-1': inbox.switchTab('inbox'); return true
    case 'tab-2': inbox.switchTab('all'); return true
    case 'tab-3': inbox.switchTab('sent'); return true
    case 'tab-4': inbox.switchTab('drafts'); return true
    case 'thread-next': thread.moveThread(1); return true
    case 'thread-prev': thread.moveThread(-1); return true
    case 'thread-up':
      if (state.breakpoint === 'narrow') data.backToList()
      else {
        const sel = state.inbox.selectedId
        if (sel) qs(`#listRows [data-id="${CSS.escape(String(sel))}"]`)?.focus()
        else qs('#listRows .trow')?.focus()
      }
      return true
    case 'toggle-expand': {
      const el = document.activeElement?.closest?.('[data-action="toggle-msg"]')
      if (el) { thread.threadActions['toggle-msg'](el); return true }
      return false
    }
    case 'hunk-next': hunkSurface().cycleHunk(1); return true
    case 'hunk-prev': hunkSurface().cycleHunk(-1); return true
    case 'hunk-accept': {
      const id = state.route.view === 'voices' ? state.voices.activeHunkId : state.studio.activeHunkId
      if (id) hunkSurface().acceptHunk(id)
      return true
    }
    case 'hunk-reject': {
      const id = state.route.view === 'voices' ? state.voices.activeHunkId : state.studio.activeHunkId
      if (id) hunkSurface().rejectHunk(id)
      return true
    }
    case 'hunk-comment': {
      const id = state.route.view === 'voices' ? state.voices.activeHunkId : state.studio.activeHunkId
      if (id) hunkSurface().openComment(id)
      return true
    }
    case 'accept-all': hunkSurface().acceptAll(); return true
    case 'comment-submit': hunkSurface().submitComment(); return true
    case 'primary': {
      // ⌘⏎ is the studio's primary path only — never from the search box
      // or other surfaces (§3.4.4).
      if (document.activeElement?.closest?.('#studio')) {
        studio.primaryAction()
        return true
      }
      return false
    }
    case 'confirm-send':
      // ⌘⏎ send accelerator — only while attention is in the studio; from
      // the list, search, or voices it must be inert (§3.4.4).
      if (!document.activeElement?.closest?.('#studio')) return false
      studio.confirmSend()
      return true
    default:
      return false
  }
}

// ── Esc cascade (§5.1) ──

function handleEscape() {
  const token = closeTopLayer()
  if (token) {
    if (token.kind === 'locked') return true
    render()
    if (token.kind === 'menu' && token.invokerId) {
      qs(`#${token.invokerId}`)?.focus()
    } else if (token.kind === 'comment') {
      (token.voice ? voices : studio).focusActiveStrip()
    } else if (token.kind === 'confirm') {
      qs('#stPrimary')?.focus()
    }
    return true
  }
  const ae = document.activeElement
  const region = regionOf(ae)
  if (region === 'strip') {
    hunkSurface().exitStripToEditor()
    return true
  }
  if (region === 'editor') {
    if (state.route.view === 'voices') ae.blur()
    else studio.blurEditorToStudio()
    return true
  }
  if (ae?.id === 'searchInput') {
    if (ae.value) {
      ae.value = ''
      state.inbox.query = ''
      data.loadInbox({ reset: true }).then(() => {
        inbox.renderList()
        inbox.renderSyncCell()
      })
    }
    ae.blur()
    return true
  }
  if (region === 'input') {
    ae.blur()
    return true
  }
  if (state.inbox.query) {
    state.inbox.query = ''
    const input = qs('#searchInput')
    if (input) input.value = ''
    data.loadInbox({ reset: true }).then(render)
    return true
  }
  if (state.breakpoint === 'narrow' && state.route.view === 'thread') {
    data.backToList()
    return true
  }
  return false
}

// ── Shortcuts context ──

function getCtx() {
  const ae = document.activeElement
  return {
    route: state.route.view,
    threadOpen: state.route.view === 'thread',
    wide: state.breakpoint === 'wide',
    menuOpen: !!openMenuName(),
    confirmOpen: !!state.studio.confirm,
    focusRegion: regionOf(ae),
    hasPendingHunks: state.route.view === 'voices' ? voices.hasPendingHunks() : studio.hasPendingHunks(),
  }
}

// ── Click delegation ──

function handleClick(e) {
  const target = e.target.closest('[data-action]')
  if (!target) {
    // Outside click closes menus (focus back to invoker is menu-only UX;
    // pointer users are already elsewhere).
    const name = openMenuName()
    if (name && !e.target.closest('.menu')) {
      closeMenus()
      render()
    }
    if (state.settings.confirmDisconnect && !e.target.closest('[data-action="disconnect"]')) {
      state.settings.confirmDisconnect = false
    }
    return
  }
  const action = target.dataset.action
  const fn = actions[action]
  if (fn) {
    fn(target, e)
    return
  }
  dispatch(action, { event: e })
}

// ── Breakpoint (§2: ResizeObserver on the app root, not media queries) ──

function initBreakpoint() {
  const app = qs('#app')
  if (!app) return
  const apply = (w) => {
    const bp = w >= 880 ? 'wide' : 'narrow'
    const compact = w < 560
    const listCompact = bp === 'narrow' && w < 400
    if (bp !== state.breakpoint || compact !== state.compact || listCompact !== state.listCompact) {
      state.breakpoint = bp
      state.compact = compact
      state.listCompact = listCompact
      document.body.classList.toggle('narrow', bp === 'narrow')
      document.body.classList.toggle('compact', compact)
      render()
    }
  }
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) apply(entry.contentRect.width)
  })
  ro.observe(app)
  apply(app.clientWidth)
}

// ── Init ──

export function init() {
  document.body.insertAdjacentHTML('afterbegin', SVG_DEFS)
  setRenderFn(renderAll)
  document.addEventListener('click', handleClick)
  initShortcuts(getCtx, dispatch)
  initBreakpoint()
  inbox.setDraftOpener((draftId) => { studio.openDraft(draftId) })
  data.boot().then(() => {
    // App boot, connected → focus the thread list (§5.2).
    if (state.route.view === 'inbox') {
      requestAnimationFrame(() => qs('#listRows .trow')?.focus())
    } else if (state.route.view === 'onboarding') {
      focusStep()
    }
  })
}
