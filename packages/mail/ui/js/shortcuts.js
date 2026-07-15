// Scope-aware keymap (UX-SPEC §5.1) with the Board input guard.
// getScope/resolveKey are pure (node-testable); initShortcuts wires the DOM.
//
// ctx: {
//   route: 'onboarding'|'inbox'|'thread'|'voices'|'boot',
//   threadOpen: bool,          // a thread is open (route.threadId or studio)
//   wide: bool,
//   menuOpen: bool, confirmOpen: bool,
//   focusRegion: 'strip'|'editor'|'comment'|'input'|'list'|'thread'|null,
//   hasPendingHunks: bool,     // non-demoted pending hunks exist
// }

export function getScope(ctx) {
  if (ctx.menuOpen) return 'menu'
  if (ctx.confirmOpen) return 'confirm'
  if (ctx.focusRegion === 'comment') return 'comment'
  if (ctx.focusRegion === 'strip') return 'strip'
  if (ctx.focusRegion === 'editor') return 'editor'
  if (ctx.focusRegion === 'input') return 'input'
  if (ctx.route === 'onboarding' || ctx.route === 'boot') return 'onboarding'
  if (ctx.route === 'voices') return 'voices'
  if (ctx.focusRegion === 'list') return 'list'
  if (ctx.focusRegion === 'thread') return 'thread'
  return ctx.threadOpen ? 'thread' : 'list'
}

// -> action string | null. Modified combos other than ⌘⏎ never match, so
// native clipboard/undo shortcuts pass through untouched.
export function resolveKey(scope, key, mods = {}, ctx = {}) {
  if (key === 'Escape') return 'escape'

  const hasCombo = mods.meta || mods.ctrl || mods.alt
  if (hasCombo) {
    const cmdEnter = key === 'Enter' && (mods.meta || mods.ctrl) && !mods.alt
    if (cmdEnter && (scope === 'editor' || scope === 'input' || scope === 'strip')) return 'primary'
    if (cmdEnter && scope === 'confirm') return 'confirm-send'
    return null
  }

  switch (scope) {
    case 'menu':
      return null // the open menu owns its keys (arrows/Enter/trap)
    case 'confirm':
      // Plain Enter stays native: it activates the FOCUSED button (Send or
      // Cancel). Mapping it to confirm-send would fire Send from anywhere —
      // including a focused Cancel button. ⌘⏎ (handled above) is the only
      // send accelerator (§3.4.4).
      return null
    case 'comment':
      if (key === 'Enter') return 'comment-submit'
      return null
    case 'strip':
      if (key === 'Enter') return 'hunk-accept'
      if (key === 'Backspace' || key === 'Delete') return 'hunk-reject'
      if (key === 'c' || key === 'C') return 'hunk-comment'
      if (key === 'Tab') return mods.shift ? 'hunk-prev' : 'hunk-next'
      if (key === 'j') return 'hunk-next'
      if (key === 'k') return 'hunk-prev'
      if (key === 'A' && mods.shift) return 'accept-all'
      return null
    case 'editor':
      if (key === 'Tab' && ctx.hasPendingHunks) return mods.shift ? 'hunk-prev' : 'hunk-next'
      return null
    case 'input':
      return null
    default:
      break
  }

  // Non-input surfaces from here down.
  if (key === '/') return 'focus-search'

  if (scope === 'list') {
    if (key === 'j' || key === 'ArrowDown') return 'list-next'
    if (key === 'k' || key === 'ArrowUp') return 'list-prev'
    if (key === 'o' || key === 'Enter') return 'list-open'
    if (key === 'e') return 'archive'
    if (key === 'r') return 'reply'
    if (key === 'c') return 'compose'
    if (key === '1' || key === '2' || key === '3' || key === '4') return `tab-${key}`
    return null
  }

  if (scope === 'thread') {
    if (key === 'j') return 'thread-next'
    if (key === 'k') return 'thread-prev'
    if (key === 'e') return 'archive'
    if (key === 'r') return 'reply'
    if (key === 'u') return 'thread-up'
    if (key === 'Enter') return 'toggle-expand'
    // WIDE: both panes are visible; list-only conveniences stay reachable.
    if (ctx.wide) {
      if (key === 'c') return 'compose'
      if (key === '1' || key === '2' || key === '3' || key === '4') return `tab-${key}`
    }
    return null
  }

  return null
}

// DOM wiring. getCtx(event) builds the ctx above; dispatch(action, detail)
// executes it (returns false to skip preventDefault).
export function initShortcuts(getCtx, dispatch) {
  document.addEventListener('keydown', (e) => {
    const ctx = getCtx(e)
    const scope = getScope(ctx)
    const action = resolveKey(scope, e.key, {
      shift: e.shiftKey,
      meta: e.metaKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
    }, ctx)
    if (!action) return
    const handled = dispatch(action, { scope, event: e })
    if (handled !== false) e.preventDefault()
  })
}

// focusRegion for an element (data-region wins; falls back to tag checks).
export function regionOf(el) {
  if (!el || el === document.body || !el.closest) return null
  const tagged = el.closest('[data-region]')
  if (tagged) return tagged.dataset.region
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return 'input'
  return null
}
