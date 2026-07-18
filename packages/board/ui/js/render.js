import { state, setRenderFn, render } from './state.js'
import { renderBoard, initBoardDrag } from './board.js'
import { renderList } from './list.js'
import { renderDetail, initDetailListeners, openDetail, closeDetail, handleDeleteIssue, syncDetailDraftFromDom, startBodyEdit, autoGrow } from './detail.js'
import { makeNewIssueDraft } from './createDraft.js'
import { renderCreateModal, handleCreateIssue, initCreateListeners, syncCreateDraftFromDom } from './create.js'
import { renderFieldMenu, handleFieldSelect, openFieldMenu, initFieldMenuListeners, handleLabelColorChange, handleCreateLabel, handleCreateProject } from './fields.js'
import { renderSettings, handleToggleProp, handleToggleColumn } from './settings.js'
import { renderToolbar, renderReminderPanel } from './toolbar.js'
import { renderToast } from './toast.js'
import { initShortcuts } from './shortcuts.js'
import { loadIssues, loadUserName, loadColumnConfig, enableBoard, onWorkspaceChanged, saveIssue, checkReminders } from './data.js'
import { SVG_DEFS } from './icons.js'
import { qs } from './utils.js'
import { showToast, findIssue } from './state.js'

function renderOffer() {
  return `<div class="offer">
    <div class="offer-title">No issues folder yet</div>
    <div class="offer-sub">The Board stores issues in an <code>issues/</code> folder in your workspace. Create it to start tracking work.</div>
    <button class="offer-btn" data-action="enable-board">Create issues folder</button>
    <div class="offer-error" id="offerError" hidden></div>
  </div>`
}

function renderPage() {
  const content = qs('#content')
  if (!content) return

  if (!state.folderPresent) {
    content.innerHTML = renderOffer()
    return
  }

  if (state.page === 'detail') {
    // Re-rendering replaces the textarea; carry focus, caret, grown height,
    // and scroll position across, or an open editor snaps back to a clipped
    // box and the page jumps to the top.
    const prev = qs('#detailBody')
    const hadFocus = prev && document.activeElement === prev
    const caret = hadFocus ? [prev.selectionStart, prev.selectionEnd] : null
    const scrollTop = qs('.detail-main')?.scrollTop || 0
    content.innerHTML = renderDetail()
    const scroller = qs('.detail-main')
    if (scroller) scroller.scrollTop = scrollTop
    const bodyEl = qs('#detailBody')
    if (bodyEl) {
      autoGrow(bodyEl)
      if (caret) {
        bodyEl.focus()
        bodyEl.setSelectionRange(caret[0], caret[1])
      }
    }
    return
  }

  content.innerHTML = state.view === 'board' ? renderBoard() : renderList()
}

function renderAll() {
  renderToolbar()
  renderPage()
  renderSettings()
  renderFieldMenu()
  renderReminderPanel()
  renderToast()

  const modalLayer = qs('#modalLayer')
  if (modalLayer) modalLayer.innerHTML = renderCreateModal()
}

function handleClick(e) {
  const target = e.target.closest('[data-action]')

  if (!target) {
    let changed = false
    if (state.fieldMenu && !e.target.closest('.field-menu')) {
      state.fieldMenu = null
      changed = true
    }
    if (state.settingsOpen && !e.target.closest('.settings-popover') && !e.target.closest('[data-action="toggle-settings"]')) {
      state.settingsOpen = false
      changed = true
    }
    if (state.reminderPanelOpen && !e.target.closest('.reminder-panel') && !e.target.closest('[data-action="toggle-reminders"]')) {
      state.reminderPanelOpen = false
      changed = true
    }
    if (state.deleteConfirmId) {
      state.deleteConfirmId = null
      changed = true
    }
    if (changed) render()
    return
  }

  const action = target.dataset.action
  if (state.deleteConfirmId && action !== 'delete-issue') {
    state.deleteConfirmId = null
  }
  // Dismissing a menu discards pending filter text; creating from it takes
  // Enter or the explicit Create row. No render here — the trigger must stay
  // attached for open-field's rect measurement, and every action below
  // renders on its own.
  if (state.fieldMenu && !e.target.closest('.field-menu')
    && action !== 'open-field' && action !== 'open-new-field') {
    state.fieldMenu = null
  }

  if (action === 'open-detail') {
    e.stopPropagation()
    if (e.target.closest('.field-ctrl')) return
    openDetail(target.dataset.id)
    return
  }

  if (action === 'open-field') {
    e.stopPropagation()
    syncDetailDraftFromDom()
    openFieldMenu(target, target.dataset.field, target.dataset.id, false)
    return
  }

  if (action === 'open-new-field') {
    e.stopPropagation()
    syncCreateDraftFromDom()
    openFieldMenu(target, target.dataset.field, '', true)
    return
  }

  if (action === 'select-field') {
    e.stopPropagation()
    handleFieldSelect(target)
    return
  }

  if (action === 'set-label-color') {
    e.stopPropagation()
    handleLabelColorChange(target.dataset.label, target.dataset.color, target.dataset.id, target.dataset.new)
    return
  }

  if (action === 'toggle-label-colors') {
    e.stopPropagation()
    if (state.fieldMenu) {
      const name = target.dataset.label
      state.fieldMenu.colorPickerFor = state.fieldMenu.colorPickerFor === name ? null : name
      render()
    }
    return
  }

  if (action === 'create-label') {
    e.stopPropagation()
    handleCreateLabel(target)
    return
  }

  if (action === 'create-project') {
    e.stopPropagation()
    handleCreateProject(target)
    return
  }

  if (action === 'toggle-settings') {
    state.settingsOpen = !state.settingsOpen
    state.fieldMenu = null
    state.reminderPanelOpen = false
    render()
    return
  }

  if (action === 'toggle-reminders') {
    state.reminderPanelOpen = !state.reminderPanelOpen
    state.settingsOpen = false
    state.fieldMenu = null
    render()
    return
  }

  if (action === 'dismiss-reminder') {
    const issue = findIssue(target.dataset.id)
    if (issue) {
      issue.remindAt = ''
      saveIssue(issue)
    }
    state.firedReminders = state.firedReminders.filter(r => r.id !== target.dataset.id)
    if (state.firedReminders.length === 0) state.reminderPanelOpen = false
    render()
    return
  }

  if (action === 'snooze-reminder') {
    const issue = findIssue(target.dataset.id)
    const hours = parseInt(target.dataset.hours, 10) || 1
    if (issue) {
      issue.remindAt = new Date(Date.now() + hours * 3600000).toISOString()
      saveIssue(issue)
    }
    state.firedReminders = state.firedReminders.filter(r => r.id !== target.dataset.id)
    if (state.firedReminders.length === 0) state.reminderPanelOpen = false
    showToast(`Snoozed ${hours}h`)
    render()
    return
  }

  if (action === 'dismiss-all-reminders') {
    for (const r of state.firedReminders) {
      const issue = findIssue(r.id)
      if (issue) {
        issue.remindAt = ''
        saveIssue(issue)
      }
    }
    state.firedReminders = []
    state.reminderPanelOpen = false
    showToast('All reminders dismissed')
    render()
    return
  }

  if (action === 'set-board') {
    state.view = 'board'
    render()
    return
  }

  if (action === 'set-list') {
    state.view = 'list'
    render()
    return
  }

  if (action === 'set-group') {
    state.groupBy = target.dataset.group || 'status'
    render()
    return
  }

  if (action === 'set-filter') {
    state.priorityFilter = target.dataset.priority || 'all'
    render()
    return
  }

  if (action === 'new-issue') {
    state.newIssue = makeNewIssueDraft({
      status: target.dataset.status || 'backlog',
      project: target.dataset.project || '',
      userName: state.userName,
    })
    state.modalOpen = true
    state.settingsOpen = false
    state.fieldMenu = null
    render()
    requestAnimationFrame(() => {
      const el = qs('#createTitle')
      if (el) el.focus()
    })
    return
  }

  if (action === 'close-modal') {
    state.modalOpen = false
    state.fieldMenu = null
    render()
    return
  }

  if (action === 'create-issue') {
    handleCreateIssue()
    return
  }

  if (action === 'toggle-create-more') {
    syncCreateDraftFromDom()
    state.createMore = !state.createMore
    render()
    return
  }

  if (action === 'edit-body') {
    if (e.target.closest('a')) return
    startBodyEdit()
    return
  }

  if (action === 'go-back') {
    closeDetail()
    return
  }

  if (action === 'delete-issue') {
    handleDeleteIssue(target.dataset.id)
    return
  }

  if (action === 'col-menu') {
    const status = target.dataset.status
    state.hiddenStatuses.add(status)
    render()
    return
  }

  if (action === 'show-column') {
    const status = target.closest('[data-status]')?.dataset.status
    if (status) {
      state.hiddenStatuses.delete(status)
      render()
    }
    return
  }

  if (action === 'toggle-prop') {
    handleToggleProp(target.dataset.prop)
    return
  }

  if (action === 'toggle-column') {
    handleToggleColumn(target.dataset.col)
    return
  }

  if (action === 'enable-board') {
    target.disabled = true
    enableBoard().catch(err => {
      const errEl = qs('#offerError')
      if (errEl) {
        errEl.textContent = 'Could not create the issues folder: ' + (err?.message || String(err))
        errEl.hidden = false
      }
      target.disabled = false
    })
    return
  }
}

function handleInput(e) {
  if (e.target.id === 'createTitle') {
    state.newIssue.title = e.target.textContent
    return
  }
  if (e.target.id === 'createBody') {
    state.newIssue.body = e.target.value
    e.target.style.height = 'auto'
    e.target.style.height = e.target.scrollHeight + 'px'
    return
  }
  if (e.target.id === 'nameInput') {
    state.newIssue.nameInput = e.target.value
    return
  }
  if (e.target.id === 'searchInput') {
    state.searchQuery = e.target.value
    renderPage()
  }
}

function handleChange(e) {
  const sel = e.target.dataset?.select
  if (sel === 'sort') {
    state.sortMode = e.target.value
    render()
  }
  if (sel === 'project-filter') {
    state.projectFilter = e.target.value
    render()
  }
}

function handleOverlayClick(e) {
  if (e.target.id === 'createOverlay') {
    state.modalOpen = false
    state.fieldMenu = null
    render()
  }
}

export async function init() {
  // index.html ships the scaffold and a skeleton board statically so the
  // app paints before this module graph and the runtime socket are up;
  // adopt it and only inject the SVG sprite.
  const app = qs('#app')
  const defs = document.createElement('div')
  defs.innerHTML = SVG_DEFS
  app.prepend(defs.firstElementChild || defs)

  setRenderFn(renderAll)
  initBoardDrag()
  initDetailListeners()
  initCreateListeners()
  initFieldMenuListeners()
  initShortcuts()
  document.addEventListener('click', handleClick)
  document.addEventListener('click', handleOverlayClick)
  document.addEventListener('input', handleInput)
  document.addEventListener('change', handleChange)

  try {
    await Promise.all([loadIssues(), loadUserName(), loadColumnConfig()])
  } catch (err) {
    console.warn('[board] init error:', err)
  }

  checkReminders()
  render()

  setInterval(() => {
    checkReminders()
    render()
  }, 60000)

  onWorkspaceChanged(async () => {
    try {
      await loadIssues()
    } catch (err) {
      console.warn('[board] reload error:', err)
    }
    checkReminders()
    render()
  })
}
