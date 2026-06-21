import { state, render, findIssue, showToast } from './state.js'
import { STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS, LABEL_COLORS, LABEL_COLOR_VALUES } from './constants.js'
import { ensureBody } from './data.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { saveIssue } from './data.js'
import { qs } from './utils.js'

export function openFieldMenu(trigger, field, issueId, isNew = false) {
  const rect = trigger.getBoundingClientRect()
  const main = qs('#app') || document.body
  const mainRect = main.getBoundingClientRect()
  const width = 220
  const x = Math.max(8, Math.min(rect.left - mainRect.left, mainRect.width - width - 8))
  const y = Math.max(8, Math.min(rect.bottom - mainRect.top + 4, mainRect.height - 300))
  state.fieldMenu = { field, issueId, isNew, x, y }
  render()
}

function currentValue(field, issueId, isNew) {
  if (isNew) {
    const n = state.newIssue
    switch (field) {
      case 'status': return n.status
      case 'priority': return n.priority
      case 'assignee': return n.assignee
      case 'project': return n.project
      case 'labels': return n.labels
      default: return ''
    }
  }
  const issue = findIssue(issueId)
  if (!issue) return ''
  switch (field) {
    case 'status': return issue.status
    case 'priority': return issue.priority
    case 'assignee': return issue.assignee
    case 'project': return issue.project
    case 'labels': return issue.labels
    case 'dueDate': return issue.dueDate
    default: return ''
  }
}

function menuItem(field, value, label, visual, selected, issueId, isNew) {
  const cls = selected ? 'fm-item selected' : 'fm-item'
  return `<button class="${cls}" data-action="select-field" data-field="${field}" data-value="${value}" data-id="${issueId || ''}" data-new="${isNew ? '1' : '0'}">
    ${visual || ''}
    <span class="fm-item-label">${label}</span>
    ${selected ? '<span class="fm-check">✓</span>' : ''}
  </button>`
}

function statusMenuItems(current, issueId, isNew) {
  return STATUSES.map(s =>
    menuItem('status', s, STATUS_LABELS[s], statusToken(s), s === current, issueId, isNew)
  ).join('')
}

function priorityMenuItems(current, issueId, isNew) {
  return PRIORITIES.map(p =>
    menuItem('priority', p, PRIORITY_LABELS[p], `<span class="fm-priority">${priorityBars(p)}</span>`, p === current, issueId, isNew)
  ).join('')
}

function assigneeMenuItems(current, issueId, isNew) {
  const items = []
  if (state.userName) {
    items.push(menuItem('assignee', state.userName, state.userName,
      `<span class="avatar-sm">${state.userName.charAt(0).toUpperCase()}</span>`,
      current === state.userName, issueId, isNew))
  }
  items.push(menuItem('assignee', '', 'Unassigned',
    '<span class="avatar-sm avatar-empty">–</span>',
    !current, issueId, isNew))
  return items.join('')
}

function projectMenuItems(current, issueId, isNew) {
  const known = new Set(state.issues.map(i => i.project).filter(Boolean))
  const items = []
  items.push(`<input class="fm-input" id="fmProjectInput" type="text" placeholder="Type to add project..." autocomplete="off" data-field="project" data-id="${issueId || ''}" data-new="${isNew ? '1' : '0'}">`)
  items.push(menuItem('project', '', 'No project',
    '<span class="fm-icon-muted">–</span>', !current, issueId, isNew))
  for (const p of [...known].sort()) {
    items.push(menuItem('project', p, p,
      icon('folder', 12), p === current, issueId, isNew))
  }
  return items.join('')
}

function labelMenuItems(currentLabels, issueId, isNew) {
  const current = Array.isArray(currentLabels) ? currentLabels : []
  const currentNames = new Set(current.map(l => l.name))
  const known = new Map()
  for (const issue of state.issues) {
    for (const l of (issue.labels || [])) {
      if (!known.has(l.name)) known.set(l.name, l.color || 'gray')
    }
  }
  const items = []
  items.push(`<input class="fm-input" id="fmLabelInput" type="text" placeholder="Type to add label..." autocomplete="off" data-field="labels" data-id="${issueId || ''}" data-new="${isNew ? '1' : '0'}">`)
  items.push(menuItem('labels', '', 'No labels',
    '<span class="fm-icon-muted">–</span>', current.length === 0, issueId, isNew))
  for (const [name, color] of [...known].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dot = `<span class="label-dot" style="background:${LABEL_COLOR_VALUES[color] || LABEL_COLOR_VALUES.gray}"></span>`
    items.push(menuItem('labels', name, name, dot, currentNames.has(name), issueId, isNew))
    if (currentNames.has(name)) {
      const swatches = LABEL_COLORS.map(c => {
        const active = c === color ? ' active' : ''
        return `<button class="fm-color-dot${active}" data-action="set-label-color" data-label="${name}" data-color="${c}" data-id="${issueId || ''}" data-new="${isNew ? '1' : '0'}"><span style="background:${LABEL_COLOR_VALUES[c]}"></span></button>`
      }).join('')
      items.push(`<div class="fm-colors">${swatches}</div>`)
    }
  }
  return items.join('')
}

function dueDateMenuItems(current, issueId, isNew) {
  const items = []
  items.push(menuItem('dueDate', '', 'No due date',
    '<span class="fm-icon-muted">–</span>', !current, issueId, isNew))
  const today = new Date()
  const offsets = [
    { label: 'Today', days: 0 },
    { label: 'Tomorrow', days: 1 },
    { label: 'In 3 days', days: 3 },
    { label: 'In 1 week', days: 7 },
    { label: 'In 2 weeks', days: 14 },
    { label: 'In 1 month', days: 30 },
  ]
  for (const { label, days } of offsets) {
    const d = new Date(today)
    d.setDate(d.getDate() + days)
    const val = d.toISOString().slice(0, 10)
    items.push(menuItem('dueDate', val, label, icon('calendar', 12), val === current, issueId, isNew))
  }
  items.push('<div class="fm-sep"></div>')
  items.push(`<input class="fm-date-input" id="fmDateInput" type="date" data-id="${issueId || ''}" data-new="${isNew ? '1' : '0'}"${current ? ` value="${current}"` : ''}>`)
  return items.join('')
}

export function renderFieldMenu() {
  const container = qs('#fieldMenuLayer')
  if (!container) return
  if (!state.fieldMenu) { container.innerHTML = ''; return }

  const { field, issueId, isNew, x, y } = state.fieldMenu
  const cv = currentValue(field, issueId, isNew)

  let title = 'Set property'
  let rows = ''
  switch (field) {
    case 'status': title = 'Status'; rows = statusMenuItems(cv, issueId, isNew); break
    case 'priority': title = 'Priority'; rows = priorityMenuItems(cv, issueId, isNew); break
    case 'assignee': title = 'Assignee'; rows = assigneeMenuItems(cv, issueId, isNew); break
    case 'project': title = 'Project'; rows = projectMenuItems(cv, issueId, isNew); break
    case 'labels': title = 'Labels'; rows = labelMenuItems(cv, issueId, isNew); break
    case 'dueDate': title = 'Due date'; rows = dueDateMenuItems(cv, issueId, isNew); break
  }

  container.innerHTML = `<div class="field-menu" style="left:${x}px;top:${y}px;">
    <div class="fm-title">${title}</div>
    ${rows}
  </div>`
}

export function handleFieldSelect(target) {
  const { field, value, id, new: isNew } = target.dataset
  if (isNew === '1') {
    if (field === 'status') state.newIssue.status = value
    if (field === 'priority') state.newIssue.priority = value
    if (field === 'assignee') state.newIssue.assignee = value
    if (field === 'project') state.newIssue.project = value
    if (field === 'labels') {
      if (!value) {
        state.newIssue.labels = []
      } else {
        const existing = state.newIssue.labels || []
        const hasIt = existing.some(l => l.name === value)
        if (hasIt) {
          state.newIssue.labels = existing.filter(l => l.name !== value)
        } else {
          const known = new Map()
          for (const issue of state.issues) {
            for (const l of (issue.labels || [])) known.set(l.name, l.color)
          }
          state.newIssue.labels = [...existing, { name: value, color: known.get(value) || 'gray' }]
        }
      }
    }
  } else {
    const issue = findIssue(id)
    if (!issue) return
    if (field === 'status') issue.status = value
    if (field === 'priority') issue.priority = value
    if (field === 'assignee') issue.assignee = value
    if (field === 'project') issue.project = value
    if (field === 'dueDate') issue.dueDate = value
    if (field === 'labels') {
      if (!value) {
        issue.labels = []
        issue.tags = []
      } else {
        const hasIt = (issue.labels || []).some(l => l.name === value)
        if (hasIt) {
          issue.labels = issue.labels.filter(l => l.name !== value)
        } else {
          const known = new Map()
          for (const other of state.issues) {
            for (const l of (other.labels || [])) known.set(l.name, l.color)
          }
          issue.labels = [...(issue.labels || []), { name: value, color: known.get(value) || 'gray' }]
        }
        issue.tags = issue.labels.map(l => l.name)
      }
    }
    saveIssue(issue)
  }
  if (field !== 'labels') state.fieldMenu = null
  render()
}

function handleTextInput(input, field, issueId, isNew) {
  const value = input.value.trim()
  if (!value) return

  if (field === 'project') {
    if (isNew === '1') {
      state.newIssue.project = value
    } else {
      const issue = findIssue(issueId)
      if (issue) { issue.project = value; saveIssue(issue) }
    }
    state.fieldMenu = null
    render()
  }

  if (field === 'labels') {
    const labelName = value.toLowerCase().replace(/[^a-z0-9-_ ]/g, '').trim()
    if (!labelName) return
    if (isNew === '1') {
      const existing = state.newIssue.labels || []
      if (!existing.some(l => l.name === labelName)) {
        state.newIssue.labels = [...existing, { name: labelName, color: 'gray' }]
      }
    } else {
      const issue = findIssue(issueId)
      if (issue) {
        if (!(issue.labels || []).some(l => l.name === labelName)) {
          issue.labels = [...(issue.labels || []), { name: labelName, color: 'gray' }]
          issue.tags = issue.labels.map(l => l.name)
          saveIssue(issue)
        }
      }
    }
    input.value = ''
    render()
  }
}

function handleDateInput(input, issueId, isNew) {
  const value = input.value
  if (isNew === '1') {
    state.newIssue.dueDate = value
  } else {
    const issue = findIssue(issueId)
    if (issue) { issue.dueDate = value; saveIssue(issue) }
  }
  state.fieldMenu = null
  render()
}

export function initFieldMenuListeners() {
  document.addEventListener('keydown', (e) => {
    const input = e.target
    if (e.key === 'Enter' && input.classList?.contains('fm-input')) {
      e.preventDefault()
      handleTextInput(input, input.dataset.field, input.dataset.id, input.dataset.new)
      return
    }

    if (!state.fieldMenu) return
    const menu = qs('.field-menu')
    if (!menu) return

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = [...menu.querySelectorAll('.fm-item')]
      if (items.length === 0) return
      const focused = menu.querySelector('.fm-item:focus')
      let idx = items.indexOf(focused)
      if (e.key === 'ArrowDown') idx = idx < items.length - 1 ? idx + 1 : 0
      else idx = idx > 0 ? idx - 1 : items.length - 1
      items[idx].focus()
      return
    }

    if (e.key === 'Enter') {
      const focused = menu.querySelector('.fm-item:focus')
      if (focused) {
        e.preventDefault()
        focused.click()
      }
    }
  })

  document.addEventListener('change', (e) => {
    if (e.target.id === 'fmDateInput') {
      handleDateInput(e.target, e.target.dataset.id, e.target.dataset.new)
    }
  })
}

export async function handleLabelColorChange(labelName, newColor, issueId, isNew) {
  if (isNew === '1' || isNew === true) {
    const labels = state.newIssue.labels || []
    const label = labels.find(l => l.name === labelName)
    if (label) label.color = newColor
  }
  for (const issue of state.issues) {
    const labels = issue.labels || []
    const label = labels.find(l => l.name === labelName)
    if (label) {
      label.color = newColor
      await ensureBody(issue)
      await saveIssue(issue)
    }
  }
  render()
}

export function fieldControl(issue, field, content, cls = '') {
  const isOpen = state.fieldMenu?.issueId === issue.id && state.fieldMenu?.field === field
  return `<button class="field-ctrl ${cls}${isOpen ? ' open' : ''}" data-action="open-field" data-field="${field}" data-id="${issue.id}">${content}</button>`
}
