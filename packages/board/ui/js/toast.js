import { state } from './state.js'
import { qs } from './utils.js'

export function renderToast() {
  const container = qs('#toastLayer')
  if (!container) return
  container.innerHTML = state.toast
    ? `<div class="toast">${state.toast}</div>`
    : ''
}
