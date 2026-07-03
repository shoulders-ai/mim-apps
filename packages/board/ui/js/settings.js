import { state, render } from './state.js'
import { STATUSES, STATUS_LABELS } from './constants.js'
import { statusToken } from './icons.js'
import { saveColumnConfig } from './data.js'
import { qs } from './utils.js'

const DISPLAY_PROPS = [
  { key: 'priority', label: 'Priority' },
  { key: 'labels', label: 'Labels' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'project', label: 'Project' },
  { key: 'created', label: 'Created' },
]

function propChips() {
  return DISPLAY_PROPS.map(p => {
    const active = state.displayProps.has(p.key)
    return `<button class="prop-chip${active ? ' active' : ''}" data-action="toggle-prop" data-prop="${p.key}">${p.label}</button>`
  }).join('')
}

function columnChips() {
  return STATUSES.map(s => {
    const active = state.enabledColumns.has(s)
    return `<button class="prop-chip${active ? ' active' : ''}" data-action="toggle-column" data-col="${s}">${statusToken(s)} ${STATUS_LABELS[s]}</button>`
  }).join('')
}

export function renderSettings() {
  const container = qs('#settingsLayer')
  if (!container) return
  if (!state.settingsOpen || state.page !== 'project') {
    container.innerHTML = ''
    return
  }

  container.innerHTML = `<div class="settings-popover">
    <div class="settings-subhead">Columns</div>
    <div class="chip-list">${columnChips()}</div>
    <div class="settings-sep"></div>
    <div class="settings-subhead">Display properties</div>
    <div class="chip-list">${propChips()}</div>
  </div>`
}

export function handleToggleProp(key) {
  if (state.displayProps.has(key)) {
    state.displayProps.delete(key)
  } else {
    state.displayProps.add(key)
  }
  render()
}

export function handleToggleColumn(col) {
  if (state.enabledColumns.has(col)) {
    if (state.enabledColumns.size <= 2) return
    state.enabledColumns.delete(col)
  } else {
    state.enabledColumns.add(col)
  }
  saveColumnConfig()
  render()
}
