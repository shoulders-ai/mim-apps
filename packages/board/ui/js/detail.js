import { state, render, findIssue, showToast } from './state.js'
import { STATUS_LABELS, PRIORITY_LABELS, LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { saveIssue, deleteIssue, ensureBody } from './data.js'
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

function autoGrow(el) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

export function openDetail(id) {
  flushDetailSave()
  state.detailIssueId = id
  state.page = 'detail'
  state.settingsOpen = false
  state.fieldMenu = null
  render()

  const issue = findIssue(id)
  if (!issue) return
  const loadVersion = detailEditVersion
  ensureBody(issue).then(() => {
    if (state.detailIssueId !== id) return
    if (detailEditVersion !== loadVersion) return
    const bodyEl = qs('#detailBody')
    if (bodyEl) {
      bodyEl.value = issue.body || ''
      autoGrow(bodyEl)
    }
  })
}

export function closeDetail() {
  flushDetailSave()
  state.detailIssueId = null
  state.page = 'project'
  render()
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
    <div class="detail-center">
    <article class="detail-main">
      <input class="detail-title" id="detailTitle" type="text" value="${escapeAttr(issue.title || '')}" placeholder="Issue title...">

      <div class="detail-section">
        <textarea class="detail-textarea auto-grow" id="detailBody" placeholder="Add a description...">${escapeHtml(issue.body || '')}</textarea>
      </div>

      <div class="detail-section">
        <div class="detail-created-line">${escapeHtml(issue.assignee || 'Created')} · ${escapeHtml(relativeTime(issue.created))}</div>
      </div>
    </article>

    <aside class="detail-sidebar">
      <div class="prop-card">
        <div class="prop-card-title">Properties</div>
        ${propRow(issue, 'status', escapeHtml(statusLabel), statusToken(issue.status))}
        ${propRow(issue, 'priority', escapeHtml(priorityLabel), `<span class="fm-priority">${priorityBars(issue.priority)}</span>`)}
        ${propRow(issue, 'assignee', escapeHtml(assigneeLabel), assigneeVisual)}
      </div>

      <div class="prop-card">
        <div class="prop-card-title">Labels</div>
        <button class="prop-row" data-action="open-field" data-field="labels" data-id="${issue.id}">
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
    </div>
  </div>`
}

export function initDetailListeners() {
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
