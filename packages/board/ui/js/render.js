import { state, setRenderFn, render } from './state.js'
import { renderBoard, initBoardDrag } from './board.js'
import { renderList } from './list.js'
import { renderDetail, initDetailListeners, openDetail, closeDetail, handleDeleteIssue } from './detail.js'
import { renderCreateModal, handleCreateIssue, initCreateListeners } from './create.js'
import { renderFieldMenu, handleFieldSelect, openFieldMenu, initFieldMenuListeners, handleLabelColorChange } from './fields.js'
import { renderSettings, handleToggleProp } from './settings.js'
import { renderToolbar } from './toolbar.js'
import { renderToast } from './toast.js'
import { initShortcuts } from './shortcuts.js'
import { loadIssues, loadUserName, enableBoard, onWorkspaceChanged } from './data.js'
import { SVG_DEFS } from './icons.js'
import { qs } from './utils.js'
import { showToast } from './state.js'

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
    content.innerHTML = renderDetail()
    return
  }

  content.innerHTML = state.view === 'board' ? renderBoard() : renderList()
}

function renderAll() {
  renderToolbar()
  renderPage()
  renderSettings()
  renderFieldMenu()
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
    if (changed) render()
    return
  }

  const action = target.dataset.action

  if (action === 'open-detail') {
    e.stopPropagation()
    if (e.target.closest('.field-ctrl')) return
    openDetail(target.dataset.id)
    return
  }

  if (action === 'open-field') {
    e.stopPropagation()
    openFieldMenu(target, target.dataset.field, target.dataset.id, false)
    return
  }

  if (action === 'open-new-field') {
    e.stopPropagation()
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

  if (action === 'toggle-settings') {
    state.settingsOpen = !state.settingsOpen
    state.fieldMenu = null
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
    state.newIssue = {
      status: target.dataset.status || 'backlog',
      priority: 'normal',
      assignee: state.userName,
      project: target.dataset.project || '',
      labels: [],
    }
    state.modalOpen = true
    state.settingsOpen = false
    state.fieldMenu = null
    render()
    requestAnimationFrame(() => {
      const el = qs('#createTitle')
      if (el) { el.textContent = ''; el.focus() }
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
    state.createMore = !state.createMore
    render()
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
  if (e.target.id === 'searchInput') {
    state.searchQuery = e.target.value
    render()
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
  const app = qs('#app')
  app.innerHTML = `${SVG_DEFS}
    <div id="toolbar"></div>
    <section id="content"><div class="loading">Loading...</div></section>
    <div id="settingsLayer"></div>
    <div id="fieldMenuLayer"></div>
    <div id="toastLayer"></div>
    <div id="modalLayer"></div>
    <div class="kbd-hint"><kbd>C</kbd> create <kbd>/</kbd> search <kbd>B</kbd> board <kbd>L</kbd> list</div>`

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
    await Promise.all([loadIssues(), loadUserName()])
  } catch (err) {
    console.warn('[board] init error:', err)
  }

  render()

  onWorkspaceChanged(async () => {
    try {
      await loadIssues()
    } catch (err) {
      console.warn('[board] reload error:', err)
    }
    render()
  })
}
