// Toast (Board pattern + one optional action, UX-SPEC §5.5).
// Success/undo confirmations only — errors are always inline.

import { state } from './state.js'
import { escapeHtml, qs } from './utils.js'

export function renderToast() {
  const layer = qs('#toastLayer')
  if (!layer) return
  const { msg, action } = state.toast
  if (!msg) {
    layer.innerHTML = ''
    return
  }
  layer.innerHTML = `<div class="toast" role="status" aria-live="polite">
    <span>${escapeHtml(msg)}</span>
    ${action ? `<button type="button" class="toast-action" data-action="toast-action" title="${escapeHtml(action.label)}">${escapeHtml(action.label)}</button>` : ''}
  </div>`
}

export const toastActions = {
  'toast-action': () => {
    const fn = state.toast.action?.fn
    state.toast = { msg: '', action: null }
    if (fn) fn()
  },
}
