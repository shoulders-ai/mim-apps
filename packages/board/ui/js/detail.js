import { state, render, findIssue, showToast } from './state.js'
import { STATUS_LABELS, PRIORITY_LABELS, LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { saveIssue, deleteIssue, ensureBody } from './data.js'
import { formatDate, relativeTime, userInitial, qs } from './utils.js'

let saveTimer = null

function scheduleDetailSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDetailSave, 600)
}

function flushDetailSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const issue = findIssue(state.detailIssueId)
  if (!issue) return
  const titleEl = qs('#detailTitle')
  const bodyEl = qs('#detailBody')
  if (titleEl) issue.title = titleEl.value.trim() || issue.title
  if (bodyEl) issue.body = bodyEl.value
  saveIssue(issue)
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
  ensureBody(issue).then(() => {
    if (state.detailIssueId !== id) return
    const bodyEl = qs('#detailBody')
    if (bodyEl) bodyEl.value = issue.body || ''
  })
}

export function closeDetail() {
  flushDetailSave()
  state.detailIssueId = null
  state.page = 'project'
  render()
}

function propRow(issue, field, label, visual) {
  return `<button class="prop-row" data-action="open-field" data-field="${field}" data-id="${issue.id}">
    ${visual}
    <span>${label}</span>
  </button>`
}

export function renderDetail() {
  const issue = findIssue(state.detailIssueId)
  if (!issue) return '<div class="detail-empty">Issue not found</div>'

  const statusLabel = STATUS_LABELS[issue.status] || issue.status
  const priorityLabel = PRIORITY_LABELS[issue.priority] || issue.priority
  const assigneeVisual = issue.assignee
    ? `<span class="avatar-sm">${userInitial(issue.assignee)}</span>`
    : '<span class="avatar-sm avatar-empty">–</span>'
  const assigneeLabel = issue.assignee || 'Unassigned'

  const labelsHTML = (issue.labels || []).map(l => {
    const color = LABEL_COLOR_VALUES[l.color] || LABEL_COLOR_VALUES.gray
    return `<span class="label-pill"><span class="label-dot" style="background:${color}"></span>${l.name}</span>`
  }).join('')

  const dueDateHTML = issue.dueDate
    ? `<span>${formatDate(issue.dueDate)}</span>`
    : '<span class="prop-muted">No due date</span>'

  const projectLabel = issue.project || 'No project'

  return `<div class="detail-layout">
    <div class="detail-center">
    <article class="detail-main">
      <input class="detail-title" id="detailTitle" type="text" value="${(issue.title || '').replace(/"/g, '&quot;')}" placeholder="Issue title...">

      <div class="detail-section">
        <div class="detail-label">Description</div>
        <textarea class="detail-textarea" id="detailBody" placeholder="Add a description...">${issue.body || ''}</textarea>
      </div>

      <div class="detail-section">
        <div class="detail-created-line">${issue.assignee || 'Created'} · ${relativeTime(issue.created)}</div>
      </div>
    </article>

    <aside class="detail-sidebar">
      <div class="prop-card">
        <div class="prop-card-title">Properties</div>
        ${propRow(issue, 'status', statusLabel, statusToken(issue.status))}
        ${propRow(issue, 'priority', priorityLabel, `<span class="fm-priority">${priorityBars(issue.priority)}</span>`)}
        ${propRow(issue, 'assignee', assigneeLabel, assigneeVisual)}
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
        ${propRow(issue, 'project', projectLabel, icon('folder', 14))}
      </div>

      <div class="prop-card">
        <div class="prop-card-title">Due date</div>
        ${propRow(issue, 'dueDate', dueDateHTML, icon('calendar', 14))}
      </div>

      <div class="prop-card">
        <div class="detail-meta">
          <span>ID: ${issue.id}</span>
          <span>Created ${formatDate(issue.created)}</span>
          ${issue.updated ? `<span>Updated ${formatDate(issue.updated)}</span>` : ''}
        </div>
        <button class="detail-delete" data-action="delete-issue" data-id="${issue.id}">
          ${icon('trash', 13)} Delete issue
        </button>
      </div>
    </aside>
    </div>
  </div>`
}

export function initDetailListeners() {
  document.addEventListener('input', (e) => {
    if (e.target.id === 'detailTitle' || e.target.id === 'detailBody') {
      scheduleDetailSave()
    }
  })
}

export async function handleDeleteIssue(id) {
  flushDetailSave()
  state.detailIssueId = null
  state.page = 'project'
  await deleteIssue(id)
  showToast('Issue deleted')
  render()
}
