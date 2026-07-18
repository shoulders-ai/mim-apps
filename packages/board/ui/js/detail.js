import { state, render, findIssue, showToast } from './state.js'
import { STATUS_LABELS, PRIORITY_LABELS, LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { saveIssue, deleteIssue, ensureBody } from './data.js'
import { renderMarkdown } from './md.js'
import { escapeAttr, escapeHtml, formatDate, relativeTime, userInitial, qs } from './utils.js'

let saveTimer = null
let detailEditVersion = 0

function scheduleDetailSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDetailSave, 600)
}

export function syncDetailDraftFromDom() {
  if (state.page !== 'detail') return
  const issue = findIssue(state.detailIssueId)
  if (!issue) return
  const titleEl = qs('#detailTitle')
  const bodyEl = qs('#detailBody')
  if (titleEl) issue.title = titleEl.value.trim() || issue.title
  if (bodyEl && (typeof issue.body === 'string' || bodyEl.value !== '') && issue.body !== bodyEl.value) {
    issue.body = bodyEl.value
    detailEditVersion += 1
  }
}

export function flushDetailSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const issue = findIssue(state.detailIssueId)
  if (!issue) return
  syncDetailDraftFromDom()
  saveIssue(issue)
}

export function autoGrow(el) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

export function openDetail(id) {
  flushDetailSave()
  state.detailIssueId = id
  state.page = 'detail'
  state.detailBodyEditing = false
  state.settingsOpen = false
  state.fieldMenu = null
  render()

  const issue = findIssue(id)
  if (!issue) return
  const loadVersion = detailEditVersion
  ensureBody(issue).then(() => {
    if (state.detailIssueId !== id) return
    if (detailEditVersion !== loadVersion) return
    if (state.detailBodyEditing) {
      const bodyEl = qs('#detailBody')
      if (bodyEl) {
        bodyEl.value = issue.body || ''
        autoGrow(bodyEl)
      }
      return
    }
    render()
  })
}

export function closeDetail() {
  flushDetailSave()
  state.detailIssueId = null
  state.page = 'project'
  state.detailBodyEditing = false
  render()
}

export function startBodyEdit() {
  const issue = findIssue(state.detailIssueId)
  if (!issue || typeof issue.body !== 'string') return
  // A click that ends a text selection in the preview is not an edit intent.
  if (typeof window !== 'undefined' && window.getSelection?.()?.toString()) return
  state.detailBodyEditing = true
  render()
  const bodyEl = qs('#detailBody')
  if (bodyEl) {
    autoGrow(bodyEl)
    bodyEl.focus()
    bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length)
  }
}

export function stopBodyEdit() {
  if (!state.detailBodyEditing) return
  state.detailBodyEditing = false
  flushDetailSave()
  // Defer the re-render: on blur-by-click it would replace the DOM before
  // the click event lands, detaching whatever the user clicked on.
  setTimeout(render, 0)
}

function propRow(issue, field, label, visual) {
  return `<button class="prop-row" data-action="open-field" data-field="${field}" data-id="${escapeAttr(issue.id)}">
    ${visual}
    <span>${label}</span>
  </button>`
}

function formatReminder(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const now = new Date()
  if (d <= now) return 'Overdue'
  const diffH = Math.round((d - now) / 3600000)
  if (diffH < 1) return 'In < 1 hour'
  if (diffH < 24) return `In ${diffH}h`
  const diffD = Math.round(diffH / 24)
  return `In ${diffD}d`
}

function renderDescription(issue) {
  if (state.detailBodyEditing) {
    return `<textarea class="detail-textarea auto-grow" id="detailBody" placeholder="Add a description...">${escapeHtml(issue.body || '')}</textarea>`
  }
  // Body not fetched yet: show an inert box instead of a misleading
  // "Add a description" placeholder that could clobber real content.
  if (typeof issue.body !== 'string') {
    return '<div class="detail-md detail-md-empty"></div>'
  }
  if (!issue.body.trim()) {
    return '<div class="detail-md detail-md-empty" data-action="edit-body">Add a description...</div>'
  }
  return `<div class="detail-md" data-action="edit-body">${renderMarkdown(issue.body)}</div>`
}

export function renderDetail() {
  const issue = findIssue(state.detailIssueId)
  if (!issue) return '<div class="detail-empty">Issue not found</div>'

  const statusLabel = STATUS_LABELS[issue.status] || issue.status
  const priorityLabel = PRIORITY_LABELS[issue.priority] || issue.priority
  const assigneeVisual = issue.assignee
    ? `<span class="avatar-sm">${escapeHtml(userInitial(issue.assignee))}</span>`
    : '<span class="avatar-sm avatar-empty">–</span>'
  const assigneeLabel = issue.assignee || 'Unassigned'

  const labelsHTML = (issue.labels || []).map(l => {
    const color = LABEL_COLOR_VALUES[l.color] || LABEL_COLOR_VALUES.gray
    return `<span class="label-pill"><span class="label-dot" style="background:${color}"></span>${escapeHtml(l.name)}</span>`
  }).join('')

  const dueDateHTML = issue.dueDate
    ? `<span>${escapeHtml(formatDate(issue.dueDate))}</span>`
    : '<span class="prop-muted">No due date</span>'

  const projectLabel = issue.project || 'No project'

  const reminderLabel = issue.remindAt
    ? `<span>${escapeHtml(formatReminder(issue.remindAt))}</span>`
    : '<span class="prop-muted">No reminder</span>'

  return `<div class="detail-layout">
    <div class="detail-main">
      <article class="detail-main-inner">
        <input class="detail-title" id="detailTitle" type="text" value="${escapeAttr(issue.title || '')}" placeholder="Issue title...">

        <div class="detail-section">
          ${renderDescription(issue)}
        </div>

        <div class="detail-section">
          <div class="detail-created-line">${escapeHtml(issue.assignee || 'Created')} · ${escapeHtml(relativeTime(issue.created))}</div>
        </div>
      </article>
    </div>

    <aside class="detail-sidebar">
      <div class="prop-card">
        <div class="prop-card-title">Properties</div>
        ${propRow(issue, 'status', escapeHtml(statusLabel), statusToken(issue.status))}
        ${propRow(issue, 'priority', escapeHtml(priorityLabel), `<span class="fm-priority">${priorityBars(issue.priority)}</span>`)}
        ${propRow(issue, 'assignee', escapeHtml(assigneeLabel), assigneeVisual)}
      </div>

      <div class="prop-card">
        <div class="prop-card-title">Labels</div>
        <button class="prop-row prop-row-labels" data-action="open-field" data-field="labels" data-id="${escapeAttr(issue.id)}">
          ${labelsHTML || '<span class="prop-muted">No labels</span>'}
          <span class="prop-add">+</span>
        </button>
      </div>

      <div class="prop-card">
        <div class="prop-card-title">Project</div>
        ${propRow(issue, 'project', escapeHtml(projectLabel), icon('folder', 14))}
      </div>

      <div class="prop-card">
        <div class="prop-card-title">Due date</div>
        ${propRow(issue, 'dueDate', dueDateHTML, icon('calendar', 14))}
      </div>

      <div class="prop-card">
        <div class="prop-card-title">Reminder</div>
        ${propRow(issue, 'remindAt', reminderLabel, icon('bell', 14))}
      </div>

      <div class="prop-card">
        <div class="detail-meta">
          <span>ID: ${escapeHtml(issue.id)}</span>
          <span>Created ${escapeHtml(formatDate(issue.created))}</span>
          ${issue.updated ? `<span>Updated ${escapeHtml(formatDate(issue.updated))}</span>` : ''}
        </div>
        <button class="detail-delete${state.deleteConfirmId === issue.id ? ' confirming' : ''}" data-action="delete-issue" data-id="${escapeAttr(issue.id)}">
          ${icon('trash', 13)} ${state.deleteConfirmId === issue.id ? 'Confirm delete' : 'Delete issue'}
        </button>
      </div>
    </aside>
  </div>`
}

export function initDetailListeners() {
  // blur does not bubble; capture it. Clicking away from the description
  // textarea saves and returns to the rendered markdown view.
  document.addEventListener('blur', (e) => {
    if (e.target?.id === 'detailBody') stopBodyEdit()
  }, true)

  // Registered before initShortcuts, so this wins over the global Escape
  // handler that would otherwise close the whole detail page mid-edit.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.detailBodyEditing && e.target?.id === 'detailBody') {
      e.stopImmediatePropagation()
      stopBodyEdit()
    }
  })

  document.addEventListener('input', (e) => {
    if (e.target.id === 'detailTitle') {
      const issue = findIssue(state.detailIssueId)
      if (issue) issue.title = e.target.value.trim() || issue.title
      scheduleDetailSave()
    }
    if (e.target.id === 'detailBody') {
      const issue = findIssue(state.detailIssueId)
      if (issue) {
        issue.body = e.target.value
        detailEditVersion += 1
      }
      autoGrow(e.target)
      scheduleDetailSave()
    }
  })
}

export async function handleDeleteIssue(id) {
  if (state.deleteConfirmId !== id) {
    state.deleteConfirmId = id
    render()
    return
  }
  state.deleteConfirmId = null
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  state.detailIssueId = null
  state.page = 'project'
  await deleteIssue(id)
  showToast('Issue deleted')
  render()
}
