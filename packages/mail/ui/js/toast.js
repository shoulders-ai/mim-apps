// Status-line messages (UX-SPEC §5.5): transient confirmations render in
// the status bar's message cell — no floating layer, no eye travel. Errors
// are always inline, never here. Hover/focus pauses the dismiss timer so
// Undo stays reachable.

import { state, pauseToast, resumeToast } from './state.js'
import { escapeHtml, qs } from './utils.js'

export function renderToast() {
  const cell = qs('#statusMsg')
  if (!cell) return
  const { msg, action } = state.toast
  const html = msg
    ? `<span>${escapeHtml(msg)}</span>
      ${action ? ` · <button type="button" class="btn-cell" data-action="toast-action" title="${escapeHtml(action.label)} (z)">${escapeHtml(action.label)}</button>` : ''}`
    : ''
  // Live region discipline: skip DOM writes when nothing changed.
  if (cell.dataset.rendered === html) return
  cell.dataset.rendered = html
  cell.innerHTML = html
  if (!cell.dataset.bound) {
    cell.dataset.bound = '1'
    cell.addEventListener('mouseenter', pauseToast)
    cell.addEventListener('mouseleave', resumeToast)
    cell.addEventListener('focusin', pauseToast)
    cell.addEventListener('focusout', resumeToast)
  }
}

export const toastActions = {
  'toast-action': () => {
    const fn = state.toast.action?.fn
    state.toast = { msg: '', action: null }
    if (fn) fn()
  },
}
