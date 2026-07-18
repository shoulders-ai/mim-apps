import { state, render, findIssue } from './state.js'
import { STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS, LABEL_COLORS, LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { saveIssue } from './data.js'
import { escapeAttr, escapeHtml, qs } from './utils.js'

export function openFieldMenu(trigger, field, issueId, isNew = false) {
  const prev = state.fieldMenu
  const rect = trigger.getBoundingClientRect()
  if (prev && prev.field === field && prev.issueId === issueId && prev.isNew === isNew) {
    state.fieldMenu = null
    render()
    return
  }
  const width = field === 'priority' ? 180 : 220
  const x = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  // Only the horizontal position is clamped here; the vertical clamp happens
  // in renderFieldMenu once the real menu height is measurable.
  const y = Math.max(8, rect.bottom + 4)
  state.fieldMenu = { field, issueId, isNew, x, y, query: '', colorPickerFor: null, focusInput: true }
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
    case 'remindAt': return issue.remindAt
    default: return ''
  }
}

export function sanitizeLabelName(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-_ ]/g, '').trim()
}

export function rankMatches(names, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return [...names].sort((a, b) => a.localeCompare(b))
  return names
    .map(name => ({ name, at: name.toLowerCase().indexOf(q) }))
    .filter(m => m.at !== -1)
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    .map(m => m.name)
}

const AUTO_COLORS = LABEL_COLORS.filter(c => c !== 'gray')

export function autoLabelColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AUTO_COLORS[h % AUTO_COLORS.length]
}

export function textCommitDecision(field, visible, query) {
  const raw = String(query || '').trim()
  if (field === 'labels') {
    const name = sanitizeLabelName(raw)
    if (!name) return { type: 'none' }
    if (visible.length > 0) return { type: 'toggle', value: visible[0] }
    return { type: 'create', value: name }
  }
  if (field === 'project') {
    if (!raw) return { type: 'none' }
    const exact = visible.find(v => v.toLowerCase() === raw.toLowerCase())
    if (exact) return { type: 'select', value: exact }
    if (visible.length > 0) return { type: 'select', value: visible[0] }
    return { type: 'create', value: raw }
  }
  return { type: 'none' }
}

function knownLabels(current) {
  const known = new Map()
  for (const issue of state.issues) {
    for (const l of (issue.labels || [])) {
      if (!known.has(l.name)) known.set(l.name, l.color || 'gray')
    }
  }
  for (const l of current) {
    if (!known.has(l.name)) known.set(l.name, l.color || 'gray')
  }
  return known
}

function knownProjects() {
  return [...new Set(state.issues.map(i => i.project).filter(Boolean))]
}

function menuItem(field, value, label, visual, selected, issueId, isNew) {
  const cls = selected ? 'fm-item selected' : 'fm-item'
  return `<button class="${cls}" data-action="select-field" data-field="${field}" data-value="${escapeAttr(value)}" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}">
    ${visual || ''}
    <span class="fm-item-label">${escapeHtml(label)}</span>
    ${selected ? '<span class="fm-check">✓</span>' : ''}
  </button>`
}

function statusMenuItems(current, issueId, isNew) {
  const cols = state.enabledColumns
  const visible = STATUSES.filter(s => cols.has(s) || s === current)
  return visible.map(s =>
    menuItem('status', s, STATUS_LABELS[s], statusToken(s), s === current, issueId, isNew)
  ).join('')
}

function priorityMenuItems(current, issueId, isNew) {
  return `<div class="fm-priority-row">${PRIORITIES.map(p => {
    const cls = p === current ? 'fm-priority-opt selected' : 'fm-priority-opt'
    return `<button class="${cls}" data-action="select-field" data-field="priority" data-value="${p}" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}" title="${PRIORITY_LABELS[p]}">${priorityBars(p)}<span class="fm-priority-label">${PRIORITY_LABELS[p]}</span></button>`
  }).join('')}</div>`
}

function assigneeMenuItems(current, issueId, isNew) {
  const items = []
  if (state.userName) {
    items.push(menuItem('assignee', state.userName, state.userName,
      `<span class="avatar-sm">${escapeHtml(state.userName.charAt(0).toUpperCase())}</span>`,
      current === state.userName, issueId, isNew))
  }
  items.push(menuItem('assignee', '', 'Unassigned',
    '<span class="avatar-sm avatar-empty">–</span>',
    !current, issueId, isNew))
  return items.join('')
}

function filterInput(field, issueId, isNew, placeholder) {
  const query = state.fieldMenu?.query || ''
  const idAttr = field === 'labels' ? 'fmLabelInput' : 'fmProjectInput'
  return `<input class="fm-input" id="${idAttr}" type="text" placeholder="${placeholder}" autocomplete="off" value="${escapeAttr(query)}" data-field="${field}" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}">`
}

function projectMenuItems(current, issueId, isNew) {
  const query = state.fieldMenu?.query || ''
  const known = knownProjects()
  const names = rankMatches(known, query)
  const items = []
  if (!query.trim()) {
    items.push(menuItem('project', '', 'No project',
      '<span class="fm-icon-muted">–</span>', !current, issueId, isNew))
  }
  for (const p of names) {
    items.push(menuItem('project', p, p, icon('folder', 12), p === current, issueId, isNew))
  }
  const createName = query.trim()
  if (createName && !known.some(p => p.toLowerCase() === createName.toLowerCase())) {
    items.push(`<button class="fm-item fm-create" data-action="create-project" data-value="${escapeAttr(createName)}" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}">${icon('plus', 12)}<span class="fm-item-label">Create "${escapeHtml(createName)}"</span></button>`)
  }
  if (items.length === 0) items.push('<div class="fm-empty">No matches</div>')
  return items.join('')
}

function labelMenuItems(currentLabels, issueId, isNew) {
  const current = Array.isArray(currentLabels) ? currentLabels : []
  const currentNames = new Set(current.map(l => l.name))
  const known = knownLabels(current)
  const query = state.fieldMenu?.query || ''
  const names = rankMatches([...known.keys()], query)
  const openPicker = state.fieldMenu?.colorPickerFor

  const items = []
  if (!query.trim()) {
    items.push(menuItem('labels', '', 'No labels',
      '<span class="fm-icon-muted">–</span>', current.length === 0, issueId, isNew))
  }
  for (const name of names) {
    const color = known.get(name) || 'gray'
    const dot = `<span class="label-dot" style="background:${LABEL_COLOR_VALUES[color] || LABEL_COLOR_VALUES.gray}"></span>`
    items.push(`<div class="fm-row">
      ${menuItem('labels', name, name, dot, currentNames.has(name), issueId, isNew)}
      <button class="fm-dots${openPicker === name ? ' open' : ''}" data-action="toggle-label-colors" data-label="${escapeAttr(name)}" title="Change color">${icon('dots', 13)}</button>
    </div>`)
    if (openPicker === name) {
      const swatches = LABEL_COLORS.map(c => {
        const active = c === color ? ' active' : ''
        return `<button class="fm-color-dot${active}" data-action="set-label-color" data-label="${escapeAttr(name)}" data-color="${c}" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}"><span style="background:${LABEL_COLOR_VALUES[c]}"></span></button>`
      }).join('')
      items.push(`<div class="fm-colors">${swatches}</div>`)
    }
  }
  const createName = sanitizeLabelName(query)
  if (createName && ![...known.keys()].some(n => n.toLowerCase() === createName)) {
    const dot = `<span class="label-dot" style="background:${LABEL_COLOR_VALUES[autoLabelColor(createName)]}"></span>`
    items.push(`<button class="fm-item fm-create" data-action="create-label" data-value="${escapeAttr(createName)}" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}">${dot}<span class="fm-item-label">Create "${escapeHtml(createName)}"</span></button>`)
  }
  if (items.length === 0) items.push('<div class="fm-empty">No matches</div>')
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
  items.push(`<input class="fm-date-input" id="fmDateInput" type="date" data-id="${escapeAttr(issueId || '')}" data-new="${isNew ? '1' : '0'}"${current ? ` value="${escapeAttr(current)}"` : ''}>`)
  return items.join('')
}

function remindAtMenuItems(current, issueId) {
  const items = []
  items.push(menuItem('remindAt', '', 'No reminder',
    '<span class="fm-icon-muted">–</span>', !current, issueId, false))
  const now = new Date()
  const offsets = [
    { label: 'In 1 hour', hours: 1 },
    { label: 'In 3 hours', hours: 3 },
    { label: 'Tomorrow morning', hours: null, tomorrow: true },
    { label: 'In 2 days', hours: 48 },
    { label: 'In 1 week', hours: 168 },
  ]
  for (const { label, hours, tomorrow } of offsets) {
    let d
    if (tomorrow) {
      d = new Date(now)
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
    } else {
      d = new Date(now.getTime() + hours * 3600000)
    }
    const val = d.toISOString()
    items.push(menuItem('remindAt', val, label, icon('clock', 12), false, issueId, false))
  }
  return items.join('')
}

export function renderFieldMenu() {
  const container = qs('#fieldMenuLayer')
  if (!container) return
  if (!state.fieldMenu) { container.innerHTML = ''; return }

  const { field, issueId, isNew, x, y } = state.fieldMenu
  const cv = currentValue(field, issueId, isNew)

  // Re-rendering replaces the filter input; carry focus and caret across so
  // periodic global renders never interrupt typing.
  const prevInput = qs('.field-menu .fm-input')
  const hadFocus = Boolean(prevInput && document.activeElement === prevInput)
  const caret = hadFocus ? prevInput.selectionStart : null

  let title = 'Set property'
  let head = ''
  let rows = ''
  let width = 220
  switch (field) {
    case 'status': title = 'Status'; rows = statusMenuItems(cv, issueId, isNew); break
    case 'priority': title = 'Priority'; rows = priorityMenuItems(cv, issueId, isNew); width = 180; break
    case 'assignee': title = 'Assignee'; rows = assigneeMenuItems(cv, issueId, isNew); break
    case 'project':
      title = 'Project'
      head = filterInput('project', issueId, isNew, 'Set project...')
      rows = projectMenuItems(cv, issueId, isNew)
      break
    case 'labels':
      title = 'Labels'
      head = filterInput('labels', issueId, isNew, 'Add labels...')
      rows = labelMenuItems(cv, issueId, isNew)
      width = 240
      break
    case 'dueDate': title = 'Due date'; rows = dueDateMenuItems(cv, issueId, isNew); break
    case 'remindAt': title = 'Remind me'; rows = remindAtMenuItems(cv, issueId); break
  }

  container.innerHTML = `<div class="field-menu" style="left:${x}px;top:${y}px;width:${width}px">
    <div class="fm-title">${title}</div>
    ${head}
    <div class="fm-scroll">${rows}</div>
  </div>`

  const menu = container.firstElementChild
  if (menu) {
    const maxTop = window.innerHeight - menu.offsetHeight - 8
    if (y > maxTop) menu.style.top = Math.max(8, maxTop) + 'px'
  }

  const input = qs('.field-menu .fm-input')
  if (input && (hadFocus || state.fieldMenu.focusInput)) {
    input.focus()
    const pos = caret ?? input.value.length
    input.setSelectionRange(pos, pos)
  }
  state.fieldMenu.focusInput = false
}

function labelColorFor(name) {
  return knownLabels([]).get(name) || autoLabelColor(name)
}

function applyLabelToggle(name, issueId, isNew) {
  if (isNew) {
    const existing = state.newIssue.labels || []
    state.newIssue.labels = existing.some(l => l.name === name)
      ? existing.filter(l => l.name !== name)
      : [...existing, { name, color: labelColorFor(name) }]
    return
  }
  const issue = findIssue(issueId)
  if (!issue) return
  const existing = issue.labels || []
  issue.labels = existing.some(l => l.name === name)
    ? existing.filter(l => l.name !== name)
    : [...existing, { name, color: labelColorFor(name) }]
  issue.tags = issue.labels.map(l => l.name)
  saveIssue(issue)
}

function applyLabelCreate(name, issueId, isNew) {
  if (isNew) {
    const existing = state.newIssue.labels || []
    if (!existing.some(l => l.name === name)) {
      state.newIssue.labels = [...existing, { name, color: labelColorFor(name) }]
    }
    return
  }
  const issue = findIssue(issueId)
  if (!issue) return
  if (!(issue.labels || []).some(l => l.name === name)) {
    issue.labels = [...(issue.labels || []), { name, color: labelColorFor(name) }]
    issue.tags = issue.labels.map(l => l.name)
    saveIssue(issue)
  }
}

export function handleFieldSelect(target) {
  const { field, value, id, new: isNewFlag } = target.dataset
  const isNew = isNewFlag === '1'

  if (field === 'labels') {
    if (!value) {
      if (isNew) {
        state.newIssue.labels = []
      } else {
        const issue = findIssue(id)
        if (issue) {
          issue.labels = []
          issue.tags = []
          saveIssue(issue)
        }
      }
    } else {
      applyLabelToggle(value, id, isNew)
    }
    render()
    return
  }

  if (isNew) {
    if (field === 'status') state.newIssue.status = value
    if (field === 'priority') state.newIssue.priority = value
    if (field === 'assignee') state.newIssue.assignee = value
    if (field === 'project') state.newIssue.project = value
  } else {
    const issue = findIssue(id)
    if (!issue) return
    if (field === 'status') issue.status = value
    if (field === 'priority') issue.priority = value
    if (field === 'assignee') issue.assignee = value
    if (field === 'project') issue.project = value
    if (field === 'dueDate') issue.dueDate = value
    if (field === 'remindAt') {
      issue.remindAt = value
      if (!value) {
        state.firedReminders = state.firedReminders.filter(r => r.id !== id)
      }
    }
    saveIssue(issue)
  }
  state.fieldMenu = null
  render()
}

export function handleCreateLabel(target) {
  const name = sanitizeLabelName(target.dataset.value)
  if (!name) return
  applyLabelCreate(name, target.dataset.id, target.dataset.new === '1')
  render()
}

export function handleCreateProject(target) {
  const name = String(target.dataset.value || '').trim()
  if (!name) return
  if (target.dataset.new === '1') {
    state.newIssue.project = name
  } else {
    const issue = findIssue(target.dataset.id)
    if (issue) {
      issue.project = name
      saveIssue(issue)
    }
  }
  state.fieldMenu = null
  render()
}

function commitMenuText(input) {
  const field = input.dataset.field
  const issueId = input.dataset.id
  const isNew = input.dataset.new === '1'
  const query = input.value

  if (field === 'labels') {
    const current = currentValue('labels', issueId, isNew)
    const known = knownLabels(Array.isArray(current) ? current : [])
    const visible = rankMatches([...known.keys()], query)
    const decision = textCommitDecision('labels', visible, query)
    if (decision.type === 'toggle') applyLabelToggle(decision.value, issueId, isNew)
    if (decision.type === 'create') applyLabelCreate(decision.value, issueId, isNew)
    if (decision.type !== 'none') render()
    return
  }

  if (field === 'project') {
    const visible = rankMatches(knownProjects(), query)
    const decision = textCommitDecision('project', visible, query)
    if (decision.type === 'none') return
    if (isNew) {
      state.newIssue.project = decision.value
    } else {
      const issue = findIssue(issueId)
      if (issue) {
        issue.project = decision.value
        saveIssue(issue)
      }
    }
    state.fieldMenu = null
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
    if (input.classList?.contains('fm-input')) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitMenuText(input)
        return
      }
      // Escape clears the filter first; a second Escape closes the menu via
      // the global shortcut handler.
      if (e.key === 'Escape' && input.value) {
        e.stopImmediatePropagation()
        input.value = ''
        if (state.fieldMenu) {
          state.fieldMenu.query = ''
          state.fieldMenu.focusInput = true
          renderFieldMenu()
        }
        return
      }
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
      return
    }

    // Typing while an option row is focused routes back into the filter
    // input, so filtering continues seamlessly after arrow-key navigation.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const filterEl = menu.querySelector('.fm-input')
      const active = document.activeElement
      if (filterEl && active !== filterEl && !['INPUT', 'TEXTAREA'].includes(active?.tagName)) {
        filterEl.focus()
      }
    }
  })

  document.addEventListener('input', (e) => {
    if (!state.fieldMenu) return
    if (!e.target.classList?.contains('fm-input')) return
    state.fieldMenu.query = e.target.value
    renderFieldMenu()
  })

  document.addEventListener('change', (e) => {
    if (e.target.id === 'fmDateInput') {
      handleDateInput(e.target, e.target.dataset.id, e.target.dataset.new)
    }
  })
}

export function handleLabelColorChange(labelName, newColor, issueId, isNew) {
  if (isNew === '1' || isNew === true) {
    const label = (state.newIssue.labels || []).find(l => l.name === labelName)
    if (label) label.color = newColor
  }
  for (const issue of state.issues) {
    const label = (issue.labels || []).find(l => l.name === labelName)
    if (label) {
      label.color = newColor
      saveIssue(issue)
    }
  }
  if (state.fieldMenu) state.fieldMenu.colorPickerFor = null
  render()
}

export function fieldControl(issue, field, content, cls = '') {
  const isOpen = state.fieldMenu?.issueId === issue.id && state.fieldMenu?.field === field
  return `<button class="field-ctrl ${cls}${isOpen ? ' open' : ''}" data-action="open-field" data-field="${field}" data-id="${escapeAttr(issue.id)}">${content}</button>`
}
