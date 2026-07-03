import { makeNewIssueDraft } from './createDraft.js'
import { DEFAULT_COLUMNS } from './constants.js'

let _render = () => {}

export const state = {
  issues: [],
  folderPresent: true,
  userName: '',

  view: 'board',
  page: 'project',
  detailIssueId: null,

  settingsOpen: false,
  modalOpen: false,
  fieldMenu: null,
  toast: '',
  toastTimer: null,
  searchQuery: '',
  priorityFilter: 'all',
  projectFilter: '',
  sortMode: 'priority',
  groupBy: 'status',
  hiddenStatuses: new Set(),

  dragId: null,
  deleteConfirmId: null,

  newIssue: makeNewIssueDraft(),
  createMore: false,
  createSubmitting: false,

  displayProps: new Set(['priority', 'labels', 'dueDate', 'assignee']),

  enabledColumns: new Set(DEFAULT_COLUMNS),

  firedReminders: [],
  reminderPanelOpen: false,
}

export function setRenderFn(fn) {
  _render = fn
}

export function render() {
  _render()
}

export function showToast(message) {
  if (state.toastTimer) clearTimeout(state.toastTimer)
  state.toast = message
  render()
  state.toastTimer = setTimeout(() => {
    state.toast = ''
    render()
  }, 1300)
}

export function findIssue(id) {
  return state.issues.find(i => i.id === id) || null
}

export function closeTopLayer() {
  if (state.fieldMenu) {
    state.fieldMenu = null
    render()
    return true
  }
  if (state.reminderPanelOpen) {
    state.reminderPanelOpen = false
    render()
    return true
  }
  if (state.modalOpen) {
    state.modalOpen = false
    render()
    return true
  }
  if (state.settingsOpen) {
    state.settingsOpen = false
    render()
    return true
  }
  if (state.page === 'detail') {
    state.page = 'project'
    render()
    return true
  }
  return false
}
