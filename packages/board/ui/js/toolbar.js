import { state, render } from './state.js'
import { icon } from './icons.js'
import { escapeAttr, escapeHtml, qs, relativeTime } from './utils.js'

function viewToggle() {
  const board = state.view === 'board'
  return `<div class="view-toggle">
    <button class="vt-btn${board ? ' active' : ''}" data-action="set-board">${icon('board', 11)} Board</button>
    <button class="vt-btn${!board ? ' active' : ''}" data-action="set-list">${icon('list', 11)} List</button>
  </div>`
}

function groupByToggle() {
  const byProject = state.groupBy === 'project'
  return `<div class="view-toggle">
    <button class="vt-btn${!byProject ? ' active' : ''}" data-action="set-group" data-group="status">Status</button>
    <button class="vt-btn${byProject ? ' active' : ''}" data-action="set-group" data-group="project">Project</button>
  </div>`
}

function filterPills() {
  const filters = [
    { key: 'all', label: 'All' },
    { key: 'urgent', label: 'Urgent', color: 'var(--color-rem, #c0392b)' },
    { key: 'high', label: 'High', color: '#d08030' },
    { key: 'normal', label: 'Normal', color: 'var(--color-accent)' },
    { key: 'low', label: 'Low', color: 'var(--color-ink-3)' },
  ]
  return `<div class="filter-group">${filters.map(f => {
    const active = state.priorityFilter === f.key ? ' active' : ''
    const dot = f.color ? `<span class="fpill-dot" style="background:${f.color}"></span>` : ''
    return `<button class="filter-pill${active}" data-action="set-filter" data-priority="${f.key}">${dot} ${f.label}</button>`
  }).join('')}</div>`
}

function projectFilter() {
  const projects = new Set()
  for (const i of state.issues) if (i.project) projects.add(i.project)
  if (projects.size === 0) return ''
  const sorted = [...projects].sort()
  const current = state.projectFilter
  return `<select class="sort-select" data-select="project-filter">
    <option value=""${!current ? ' selected' : ''}>All projects</option>
    ${sorted.map(p => `<option value="${escapeAttr(p)}"${current === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
  </select>`
}

function sortSelect() {
  const opts = [
    { value: 'priority', label: 'Priority' },
    { value: 'date-desc', label: 'Newest' },
    { value: 'date-asc', label: 'Oldest' },
    { value: 'alpha', label: 'A–Z' },
    { value: 'project', label: 'Project' },
  ]
  return `<select class="sort-select" data-select="sort">${opts.map(o =>
    `<option value="${o.value}"${state.sortMode === o.value ? ' selected' : ''}>Sort: ${o.label}</option>`
  ).join('')}</select>`
}

function reminderBell() {
  const count = state.firedReminders.length
  const badge = count > 0 ? `<span class="bell-badge">${count}</span>` : ''
  return `<button class="tab-btn${state.reminderPanelOpen ? ' active' : ''}${count > 0 ? ' has-reminders' : ''}" data-action="toggle-reminders" title="Reminders">${icon('bell', 13)}${badge}</button>`
}

export function renderToolbar() {
  const container = qs('#toolbar')
  if (!container) return

  if (state.page === 'detail') {
    const issue = state.issues.find(i => i.id === state.detailIssueId)
    const title = issue?.title || 'Issue'
    container.innerHTML = `
      <div class="header-bar">
        <div class="header-left">
          <button class="header-back-label" data-action="go-back" title="Back to board">${icon('arrow-left', 12)} Board</button>
          <span class="header-crumb-sep">›</span>
          <span class="header-crumb-current">${escapeHtml(title)}</span>
        </div>
        <div class="header-right">
          <button class="header-btn" data-action="go-back" title="Close">${icon('close', 13)}</button>
        </div>
      </div>`
    return
  }

  const searchVal = state.searchQuery ? ` value="${escapeAttr(state.searchQuery)}"` : ''

  container.innerHTML = `
    <div class="header-bar">
      <div class="header-left">
        <span class="header-title">Board</span>
      </div>
      <div class="header-right">
        ${reminderBell()}
        <button class="header-btn" data-action="new-issue" title="New issue (C)">${icon('plus', 13)}</button>
      </div>
    </div>
    <div class="tab-bar">
      <div class="tabs-left">
        ${viewToggle()}
        <span class="tab-sep"></span>
        ${groupByToggle()}
        <span class="tab-sep"></span>
        ${filterPills()}
        <span class="tab-sep"></span>
        ${projectFilter()}
        ${sortSelect()}
      </div>
      <div class="tabs-right">
        <div class="search-box">
          ${icon('search', 11)}
          <input class="search-input" id="searchInput" type="search" placeholder="Search..."${searchVal} autocorrect="off" autocapitalize="off">
        </div>
        <button class="tab-btn${state.settingsOpen ? ' active' : ''}" data-action="toggle-settings" title="Display settings">${icon('sliders', 13)}</button>
      </div>
    </div>`
}

export function renderReminderPanel() {
  const container = qs('#reminderLayer')
  if (!container) return
  if (!state.reminderPanelOpen || state.firedReminders.length === 0) {
    container.innerHTML = ''
    return
  }

  const items = state.firedReminders.map(r => {
    return `<div class="reminder-item">
      <div class="reminder-title" data-action="open-detail" data-id="${escapeAttr(r.id)}">${escapeHtml(r.title || '(untitled)')}</div>
      <div class="reminder-meta">${icon('clock', 10)} Set ${escapeHtml(relativeTime(r.remindAt))}</div>
      <div class="reminder-actions">
        <button class="reminder-btn" data-action="dismiss-reminder" data-id="${escapeAttr(r.id)}">Dismiss</button>
        <button class="reminder-btn" data-action="snooze-reminder" data-id="${escapeAttr(r.id)}" data-hours="1">+1h</button>
        <button class="reminder-btn" data-action="snooze-reminder" data-id="${escapeAttr(r.id)}" data-hours="3">+3h</button>
        <button class="reminder-btn" data-action="snooze-reminder" data-id="${escapeAttr(r.id)}" data-hours="24">+1d</button>
      </div>
    </div>`
  }).join('')

  container.innerHTML = `<div class="reminder-panel">
    <div class="reminder-panel-head">
      <span>Reminders</span>
      <button class="reminder-dismiss-all" data-action="dismiss-all-reminders">Dismiss all</button>
    </div>
    ${items}
  </div>`
}
