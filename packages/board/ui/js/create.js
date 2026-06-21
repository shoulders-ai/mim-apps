import { state, render, showToast } from './state.js'
import { STATUS_LABELS, PRIORITY_LABELS, LABEL_COLOR_VALUES } from './constants.js'
import { statusToken, priorityBars, icon } from './icons.js'
import { createIssue, saveUserName } from './data.js'
import { qs, userInitial } from './utils.js'

function chipButton(field, content) {
  return `<button class="create-chip" data-action="open-new-field" data-field="${field}">${content}</button>`
}

export function renderCreateModal() {
  if (!state.modalOpen) return ''

  const n = state.newIssue
  const statusLabel = STATUS_LABELS[n.status] || n.status
  const priorityLabel = n.priority === 'normal' ? 'Priority' : (PRIORITY_LABELS[n.priority] || n.priority)
  const assigneeLabel = n.assignee || 'Assignee'
  const assigneeIcon = n.assignee
    ? `<span class="avatar-sm">${userInitial(n.assignee)}</span>`
    : icon('user', 13)
  const projectLabel = n.project || 'Project'

  const labelsChip = n.labels.length > 0
    ? n.labels.map(l => {
        const color = LABEL_COLOR_VALUES[l.color] || LABEL_COLOR_VALUES.gray
        return `<span class="label-pill compact"><span class="label-dot" style="background:${color}"></span>${l.name}</span>`
      }).join('')
    : `${icon('tag', 13)} Labels`

  const namePrompt = !state.userName
    ? `<div class="name-prompt">
        <span>What's your name?</span>
        <input class="name-input" id="nameInput" type="text" placeholder="Your name..." autocomplete="off">
      </div>`
    : ''

  return `<div class="overlay" id="createOverlay">
    <div class="create-modal">
      <div class="create-header">
        <span class="create-team">${statusToken(n.status)} Board</span>
        <span class="create-sep">›</span>
        <span>New issue</span>
        <span class="create-spacer"></span>
        <button class="create-close" data-action="close-modal">${icon('close', 14)}</button>
      </div>
      <div class="create-body">
        ${namePrompt}
        <div class="create-title" id="createTitle" contenteditable="true" data-placeholder="Issue title"></div>
        <div class="create-desc">Add description...</div>
        <div class="create-chips">
          ${chipButton('status', `${statusToken(n.status)} ${statusLabel}`)}
          ${chipButton('priority', `${priorityBars(n.priority)} ${priorityLabel}`)}
          ${chipButton('assignee', `${assigneeIcon} ${assigneeLabel}`)}
          ${chipButton('project', `${icon('folder', 13)} ${projectLabel}`)}
          ${chipButton('labels', labelsChip)}
        </div>
      </div>
      <div class="create-footer">
        <div class="create-spacer"></div>
        <button class="create-more-toggle ${state.createMore ? 'on' : ''}" data-action="toggle-create-more">
          <span class="toggle-track"><span class="toggle-knob"></span></span>
        </button>
        <span class="create-more-label">Create more</span>
        <button class="create-submit" data-action="create-issue">Create issue</button>
      </div>
    </div>
  </div>`
}

export async function handleCreateIssue() {
  const titleEl = qs('#createTitle')
  const nameInputEl = qs('#nameInput')

  if (nameInputEl && nameInputEl.value.trim()) {
    await saveUserName(nameInputEl.value.trim())
    state.newIssue.assignee = state.userName
  }

  const rawTitle = titleEl ? titleEl.textContent.trim() : ''
  const title = rawTitle || 'Untitled issue'

  const created = await createIssue(title, {
    status: state.newIssue.status,
    priority: state.newIssue.priority,
    assignee: state.newIssue.assignee || state.userName,
    project: state.newIssue.project,
    labels: state.newIssue.labels,
  })

  if (!created) return

  if (state.createMore) {
    state.newIssue = {
      status: state.newIssue.status,
      priority: 'normal',
      assignee: state.userName,
      project: state.newIssue.project,
      labels: [],
    }
    render()
    requestAnimationFrame(() => {
      const el = qs('#createTitle')
      if (el) { el.textContent = ''; el.focus() }
    })
  } else {
    state.modalOpen = false
    state.fieldMenu = null
  }

  showToast('Issue created')
  render()
}

export function initCreateListeners() {
  document.addEventListener('keydown', (e) => {
    if (!state.modalOpen) return
    const active = document.activeElement
    if (e.key === 'Enter' && active?.id === 'createTitle') {
      e.preventDefault()
      handleCreateIssue()
    }
    if (e.key === 'Enter' && active?.id === 'nameInput') {
      e.preventDefault()
      const val = active.value.trim()
      if (val) {
        saveUserName(val)
        state.newIssue.assignee = state.userName
        render()
        requestAnimationFrame(() => {
          const el = qs('#createTitle')
          if (el) el.focus()
        })
      }
    }
  })
}
