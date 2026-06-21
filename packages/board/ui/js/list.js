import { state } from './state.js'
import { LIST_GROUP_ORDER, STATUS_LABELS, PRIORITY_WEIGHT, LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { fieldControl } from './fields.js'
import { formatShortDate, isOverdue, userInitial } from './utils.js'

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
    case 'project':
      result.sort((a, b) => (a.project || '').localeCompare(b.project || ''))
      break
    case 'alpha':
      result.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      break
  }
  return result
}

function labelPillCompact(label) {
  const color = LABEL_COLOR_VALUES[label.color] || LABEL_COLOR_VALUES.gray
  return `<span class="label-pill compact"><span class="label-dot" style="background:${color}"></span>${label.name}</span>`
}

function listRow(issue) {
  const labelsHTML = (issue.labels || []).slice(0, 2).map(labelPillCompact).join('')
  const dueHTML = issue.dueDate
    ? `<span class="date-chip-inline${isOverdue(issue.dueDate) ? ' overdue' : ''}">${icon('calendar', 11)} ${formatShortDate(issue.dueDate)}</span>`
    : ''
  const assigneeHTML = issue.assignee
    ? `<span class="avatar-sm">${userInitial(issue.assignee)}</span>`
    : '<span></span>'

  return `<div class="list-row" data-action="open-detail" data-id="${issue.id}">
    <span class="list-priority">${fieldControl(issue, 'priority', priorityBars(issue.priority), '')}</span>
    <span class="list-id">${issue.id.replace('issue-', '').slice(-8)}</span>
    <span class="list-status">${fieldControl(issue, 'status', statusToken(issue.status), '')}</span>
    <span class="list-title">${issue.title || '(untitled)'}</span>
    <span class="list-props">${labelsHTML}${dueHTML}</span>
    <span class="list-assignee">${assigneeHTML}</span>
    <span class="list-date">${formatShortDate(issue.created)}</span>
  </div>`
}

function statusGroupHTML(status) {
  const entries = applyFilters(state.issues.filter(i => i.status === status))
  if (entries.length === 0 && state.searchQuery) return ''

  return `<div class="list-group">
    <div class="list-group-head ${status}">
      ${statusToken(status)}
      <span>${STATUS_LABELS[status]}</span>
      <span class="list-group-count">${entries.length}</span>
      <button class="col-add-btn" data-action="new-issue" data-status="${status}">+</button>
    </div>
    ${entries.map(listRow).join('')}
  </div>`
}

function projectGroupHTML(project) {
  const label = project || 'No project'
  const entries = applyFilters(state.issues.filter(i => (i.project || '') === project))
  if (entries.length === 0 && state.searchQuery) return ''

  return `<div class="list-group">
    <div class="list-group-head">
      ${icon('folder', 12)}
      <span>${label}</span>
      <span class="list-group-count">${entries.length}</span>
      <button class="col-add-btn" data-action="new-issue" data-project="${project}">+</button>
    </div>
    ${entries.map(listRow).join('')}
  </div>`
}

function getProjectGroups() {
  const projects = new Set()
  for (const issue of state.issues) projects.add(issue.project || '')
  return [...projects].sort((a, b) => {
    if (!a) return 1
    if (!b) return -1
    return a.localeCompare(b)
  })
}

export function renderList() {
  if (state.groupBy === 'project') {
    const groups = getProjectGroups()
    return `<div class="list-view">${groups.map(projectGroupHTML).join('')}</div>`
  }
  return `<div class="list-view">${LIST_GROUP_ORDER.map(statusGroupHTML).join('')}</div>`
}
