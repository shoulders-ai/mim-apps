import { state, render, findIssue, showToast } from './state.js'
import { STATUSES, STATUS_LABELS, PRIORITY_WEIGHT } from './constants.js'
import { LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { fieldControl } from './fields.js'
import { saveIssue, ensureBody } from './data.js'
import { formatShortDate, isOverdue, userInitial, qs } from './utils.js'

function applyFilters(issues) {
  const q = state.searchQuery.toLowerCase()
  let result = issues
    .filter(i => {
      if (!q) return true
      return (i.title || '').toLowerCase().includes(q) || (i.body || '').toLowerCase().includes(q)
    })
    .filter(i => {
      if (state.priorityFilter === 'all') return true
      return i.priority === state.priorityFilter
    })
    .filter(i => {
      if (!state.projectFilter) return true
      return (i.project || '') === state.projectFilter
    })
  return applySorting(result)
}

function applySorting(result) {
  switch (state.sortMode) {
    case 'priority':
      result.sort((a, b) => (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0))
      break
    case 'date-desc':
      result.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))
      break
    case 'date-asc':
      result.sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0))
      break
    case 'alpha':
      result.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      break
    case 'project':
      result.sort((a, b) => (a.project || '').localeCompare(b.project || ''))
      break
  }
  return result
}

function labelPill(label, issueId) {
  const color = LABEL_COLOR_VALUES[label.color] || LABEL_COLOR_VALUES.gray
  if (issueId) {
    return `<button class="label-pill field-ctrl" data-action="open-field" data-field="labels" data-id="${issueId}"><span class="label-dot" style="background:${color}"></span>${label.name}</button>`
  }
  return `<span class="label-pill"><span class="label-dot" style="background:${color}"></span>${label.name}</span>`
}

function dateChip(issue) {
  if (!issue.dueDate) return ''
  const overdue = isOverdue(issue.dueDate)
  const cls = overdue ? 'date-chip overdue' : 'date-chip'
  return `<button class="${cls} field-ctrl" data-action="open-field" data-field="dueDate" data-id="${issue.id}">${icon('calendar', 11)}<span>${formatShortDate(issue.dueDate)}</span></button>`
}

function issueCard(issue) {
  const isDone = issue.status === 'done'
  const isDragging = state.dragId === issue.id
  let cls = 'card'
  if (isDone) cls += ' card-done'
  if (isDragging) cls += ' dragging'

  const assigneeHTML = state.displayProps.has('assignee') && issue.assignee
    ? fieldControl(issue, 'assignee', `<span class="avatar-sm">${userInitial(issue.assignee)}</span>`, 'card-assignee')
    : ''

  const metaParts = []
  if (state.displayProps.has('priority')) {
    metaParts.push(fieldControl(issue, 'priority', priorityBars(issue.priority), 'card-priority'))
  }
  if (state.displayProps.has('labels') && issue.labels?.length) {
    metaParts.push(issue.labels.slice(0, 2).map(l => labelPill(l, issue.id)).join(''))
  }
  if (state.displayProps.has('dueDate')) {
    metaParts.push(dateChip(issue))
  }
  if (state.displayProps.has('project') && issue.project) {
    metaParts.push(`<span class="card-project">${icon('folder', 10)} ${issue.project}</span>`)
  }

  const createdHTML = state.displayProps.has('created')
    ? `<div class="card-created">Created ${formatShortDate(issue.created)}</div>`
    : ''

  return `<article class="${cls}" draggable="true" data-action="open-detail" data-id="${issue.id}">
    ${assigneeHTML}
    <div class="card-title-row">
      ${fieldControl(issue, 'status', statusToken(issue.status), 'card-status')}
      <span class="card-title">${issue.title || '(untitled)'}</span>
    </div>
    <div class="card-meta">${metaParts.join('')}</div>
    ${createdHTML}
  </article>`
}

function statusColumnHTML(status) {
  if (state.hiddenStatuses.has(status)) {
    const count = state.issues.filter(i => i.status === status).length
    return `<section class="column col-hidden" data-status="${status}" data-action="show-column">
      ${statusToken(status)}
      <span class="col-count">${count}</span>
      <span class="col-hidden-label">${STATUS_LABELS[status]}</span>
    </section>`
  }

  const entries = applyFilters(state.issues.filter(i => i.status === status))

  return `<section class="column" data-status="${status}" data-col-status="${status}">
    <div class="col-header">
      ${statusToken(status)}
      <span class="col-label">${STATUS_LABELS[status]}</span>
      <span class="col-count">${entries.length}</span>
      <span class="col-spacer"></span>
      <button class="col-menu-btn" data-action="col-menu" data-status="${status}" title="Hide column">${icon('dots', 11)}</button>
      <button class="col-add-btn" data-action="new-issue" data-status="${status}" title="New issue">+</button>
    </div>
    <div class="col-cards" data-drop-status="${status}">
      ${entries.length === 0
        ? '<div class="col-empty">No issues</div>'
        : entries.map(i => issueCard(i)).join('')
      }
      <button class="card-add" data-action="new-issue" data-status="${status}">+</button>
    </div>
  </section>`
}

function projectColumnHTML(project) {
  const label = project || 'No project'
  const entries = applyFilters(
    state.issues.filter(i => (i.project || '') === project)
  )

  return `<section class="column" data-project="${project}">
    <div class="col-header">
      ${icon('folder', 12)}
      <span class="col-label">${label}</span>
      <span class="col-count">${entries.length}</span>
      <span class="col-spacer"></span>
      <button class="col-add-btn" data-action="new-issue" data-project="${project}" title="New issue">+</button>
    </div>
    <div class="col-cards" data-drop-project="${project}">
      ${entries.length === 0
        ? '<div class="col-empty">No issues</div>'
        : entries.map(i => issueCard(i)).join('')
      }
      <button class="card-add" data-action="new-issue" data-project="${project}">+</button>
    </div>
  </section>`
}

function getProjectGroups() {
  const projects = new Set()
  for (const issue of state.issues) projects.add(issue.project || '')
  const sorted = [...projects].sort((a, b) => {
    if (!a) return 1
    if (!b) return -1
    return a.localeCompare(b)
  })
  return sorted
}

export function renderBoard() {
  if (state.groupBy === 'project') {
    const groups = getProjectGroups()
    return `<div class="board">${groups.map(projectColumnHTML).join('')}</div>`
  }
  return `<div class="board">${STATUSES.map(statusColumnHTML).join('')}</div>`
}

export function initBoardDrag() {
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card')
    if (!card) return
    state.dragId = card.dataset.id
    e.dataTransfer.setData('text/plain', card.dataset.id)
    e.dataTransfer.effectAllowed = 'move'
    requestAnimationFrame(() => render())
  })

  document.addEventListener('dragover', (e) => {
    const col = e.target.closest('[data-drop-status]') || e.target.closest('[data-drop-project]') || e.target.closest('.col-hidden')
    if (!col || !state.dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    col.closest('.column')?.classList.add('col-drop-active')
  })

  document.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.column')
    if (!col || col.contains(e.relatedTarget)) return
    col.classList.remove('col-drop-active')
  })

  document.addEventListener('drop', async (e) => {
    const col = e.target.closest('[data-drop-status]') || e.target.closest('[data-drop-project]') || e.target.closest('.col-hidden')
    if (!col || !state.dragId) return
    e.preventDefault()
    const issue = findIssue(state.dragId)
    state.dragId = null
    if (!issue) { render(); return }
    await ensureBody(issue)
    if (col.dataset.dropProject !== undefined) {
      issue.project = col.dataset.dropProject
    } else {
      const newStatus = col.dataset.dropStatus || col.dataset.status
      if (!newStatus) { render(); return }
      issue.status = newStatus
    }
    render()
    await saveIssue(issue)
    render()
  })

  document.addEventListener('dragend', () => {
    state.dragId = null
    document.querySelectorAll('.col-drop-active').forEach(el => el.classList.remove('col-drop-active'))
    render()
  })
}
