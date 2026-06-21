const ns = 'http://www.w3.org/2000/svg'

export function icon(name, size = 14) {
  return `<svg class="icon" width="${size}" height="${size}"><use href="#i-${name}"></use></svg>`
}

export function statusToken(status) {
  switch (status) {
    case 'done':
      return '<span class="status-token status-done"></span>'
    case 'review':
      return '<span class="status-token status-review"></span>'
    case 'in-progress':
      return '<span class="status-token status-progress"></span>'
    case 'plan':
      return '<span class="status-token status-plan"></span>'
    default:
      return '<span class="status-token status-backlog"></span>'
  }
}

export function priorityBars(priority) {
  const levels = { urgent: 4, high: 3, normal: 2, low: 1 }
  const lit = levels[priority] || 2
  const bars = [4, 7, 10, 13].map((h, i) =>
    `<i style="height:${h}px;${i < lit ? 'opacity:.9' : ''}"></i>`
  ).join('')
  return `<span class="priority-bars">${bars}</span>`
}

export const SVG_DEFS = `
<svg class="svg-defs" aria-hidden="true">
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m16.5 16.5 4 4"></path></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path></symbol>
  <symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"></path></symbol>
  <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 6h6M14 6h6M4 12h12M20 12h0M4 18h4M12 18h8"></path><circle cx="12" cy="6" r="2"></circle><circle cx="18" cy="12" r="2"></circle><circle cx="10" cy="18" r="2"></circle></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"></path></symbol>
  <symbol id="i-board" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6"></rect><rect x="14" y="4" width="6" height="6"></rect><rect x="4" y="14" width="6" height="6"></rect><rect x="14" y="14" width="6" height="6"></rect></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"></path></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></symbol>
  <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"></rect><path d="M8 3v4M16 3v4M4 10h16"></path></symbol>
  <symbol id="i-tag" viewBox="0 0 24 24"><path d="M20 12v7a2 2 0 0 1-2 2H6l-4-4V5a2 2 0 0 1 2-2h7"></path><path d="M14 3h7v7"></path></symbol>
  <symbol id="i-user" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></symbol>
  <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"></path></symbol>
  <symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"></path></symbol>
  <symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"></path></symbol>
  <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></symbol>
  <symbol id="i-dots" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"></circle></symbol>
  <symbol id="i-eye-off" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"></path></symbol>
</svg>`
