// The store (UX-SPEC §7.1), render registry, layer cascade, and toast.
// This module is pure state — no DOM access — so it stays node-testable.

let _render = () => {}

export const state = {
  tools: {},              // export key -> publicName (§7.2); empty until boot
  breakpoint: 'wide',     // 'wide' | 'narrow'  (ResizeObserver)
  compact: false,         // app root < 560px (command bar collapses labels)
  route: { view: 'boot', threadId: null, draftId: null },
                          // view: 'boot'|'onboarding'|'inbox'|'thread'|'voices'
  conn: {
    connected: false, email: '', tokenOk: true,
    backfill: { state: 'pending', done: 0, total: 0 },
    lastSyncAt: null, syncError: '', seedState: 'none',
  },
  inbox: {
    tab: 'inbox', query: '', threads: [], offset: 0,
    exhausted: false, loading: false, loaded: false, selectedId: null,
    error: '',
  },
  thread: { thread: null, messages: [], drafts: [], expanded: new Set(), unquoted: new Set(), error: '' },
  studio: {
    open: false, draft: null, body: '', baseRevisionId: null,
    dirty: false, metaExpanded: false, revisions: [],
    proposal: null,       // { id, origin, intent, dropped, hunks: [...] }
    activeHunkId: null, demoted: new Set(), stale: [],
    askAi: { text: '', scope: null, pending: false },
    confirm: null,        // null | 'card' | 'sending' | { error }
    includeQuote: true,
    commentFor: null,     // hunkId with an open comment box
    revisingFor: null,    // hunkId whose strip shows "Revising…"
    note: '',             // quiet inline note above footer ("approval reset")
    proposeError: '',     // inline strip-shaped propose failure
    opError: '',          // inline error line for failed local ops
    generating: false,    // ai_initial skeleton shimmer
    history: { selectedId: null, body: null, loading: false },
  },
  voices: {
    list: [], activeId: null, proposal: null, metrics: null,
    lessons: [], seedBanner: false, seedBannerDismissed: false,
    hasPending: false, distilling: false, error: '',
    body: '', activeHunkId: null, demoted: new Set(), stale: [],
    commentFor: null, revisingFor: null, loaded: false, renaming: false,
  },
  onboarding: {
    step: 1, json: '', validation: null, connecting: false,
    waiting: false, consentUrl: '', deadline: 0, error: '', copied: false,
  },
  settings: { syncWindowDays: null, confirmDisconnect: false, syncOpen: false, seeding: false },
  banner: null,           // null | 'reconnect'
  reconnect: { connecting: false, waiting: false, consentUrl: '', deadline: 0, error: '' },
  refreshing: false,      // manual ⟳ in flight
  toast: { msg: '', action: null },
  menus: {
    settings: false, voicePicker: false, dismissAll: false,
    overflow: false, history: false, threadMore: false, voiceMore: false,
    help: false,
  },
  menuAnchor: null,       // { x, y, invokerId } for the open menu
}

export function setRenderFn(fn) {
  _render = fn
}

export function render() {
  _render()
}

let toastTimer = null

function clearToast() {
  toastTimer = null
  state.toast = { msg: '', action: null }
  render()
}

// Status-line messages (§5.5): 2.5s plain, 8s when carrying an action so
// there is time to reach Undo; hover/focus pauses the timer.
export function showToast(msg, action = null) {
  if (toastTimer) clearTimeout(toastTimer)
  state.toast = { msg, action }
  render()
  toastTimer = setTimeout(clearToast, action ? 8000 : 2500)
}

export function pauseToast() {
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
}

export function resumeToast() {
  if (!state.toast.msg || toastTimer) return
  toastTimer = setTimeout(clearToast, 3000)
}

export function openMenuName() {
  for (const name of Object.keys(state.menus)) {
    if (state.menus[name]) return name
  }
  return null
}

export function openMenu(name, anchor = null) {
  for (const k of Object.keys(state.menus)) state.menus[k] = false
  state.menus[name] = true
  state.menuAnchor = anchor
  render()
}

export function closeMenus() {
  let had = false
  for (const k of Object.keys(state.menus)) {
    if (state.menus[k]) had = true
    state.menus[k] = false
  }
  state.menuAnchor = null
  return had
}

// Esc cascade (§5.1): menu → comment box → confirm card → …
// State-only layers are handled here; DOM layers (strip focus, search,
// NARROW thread) are handled by the caller when this returns null.
// Returns a token describing what closed so the caller can route focus
// per the §5.2 ledger.
export function closeTopLayer() {
  const menu = openMenuName()
  if (menu) {
    const invokerId = state.menuAnchor?.invokerId || null
    state.menus[menu] = false
    state.menuAnchor = null
    return { kind: 'menu', name: menu, invokerId }
  }
  if (state.studio.commentFor) {
    const hunkId = state.studio.commentFor
    state.studio.commentFor = null
    return { kind: 'comment', hunkId }
  }
  if (state.voices.commentFor) {
    const hunkId = state.voices.commentFor
    state.voices.commentFor = null
    return { kind: 'comment', hunkId, voice: true }
  }
  if (state.studio.confirm === 'sending') {
    return { kind: 'locked' }
  }
  if (state.studio.confirm) {
    state.studio.confirm = null
    return { kind: 'confirm' }
  }
  return null
}
