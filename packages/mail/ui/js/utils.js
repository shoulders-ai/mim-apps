// Small shared helpers. No DOM access at import time; qs/qsa are only
// called from browser code paths.

export function qs(sel, root = document) {
  return root.querySelector(sel)
}

export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel))
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const escapeAttr = escapeHtml

// Debounce with flush/cancel — draft_edit needs "debounced 800ms + flush on
// blur and before any tool call that reads the body".
export function debounce(fn, ms) {
  let timer = null
  let args = null
  const wrapped = (...a) => {
    args = a
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const use = args
      args = null
      fn(...(use || []))
    }, ms)
  }
  wrapped.flush = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    const use = args
    args = null
    fn(...(use || []))
  }
  wrapped.cancel = () => {
    clearTimeout(timer)
    timer = null
    args = null
  }
  wrapped.pending = () => timer !== null
  return wrapped
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// List-row time: `14:32` today, `3 Jul` this year, `Jul 24` older (§3.2).
export function fmtTime(ms, now = Date.now()) {
  const t = Number(ms)
  if (!t || Number.isNaN(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.getFullYear() === n.getFullYear()) {
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`
  }
  return `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
}

// Expanded-message header time: `today 14:32` / `3 Jul 14:32` / `Jul 24`.
export function fmtLongTime(ms, now = Date.now()) {
  const t = Number(ms)
  if (!t || Number.isNaN(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `today ${hm}`
  }
  if (d.getFullYear() === n.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`
  return `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
}

// 1240 -> "1,240"
export function fmtCount(n) {
  const v = Math.round(Number(n) || 0)
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (v < 0 ? '-' : '') + digits
}

// "12s ago" / "2m ago" / "3h ago" / "2d ago"
export function relTime(ms, now = Date.now()) {
  const t = typeof ms === 'string' ? new Date(ms).getTime() : Number(ms)
  if (!t || Number.isNaN(t)) return ''
  const diff = Math.max(0, now - t)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

export function el(tag, cls, attrs) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}
