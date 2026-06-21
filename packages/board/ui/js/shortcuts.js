import { state, render, closeTopLayer } from './state.js'
import { qs } from './utils.js'

export function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      || document.activeElement?.hasAttribute('contenteditable')

    if (e.key === 'Escape') {
      if (inInput && document.activeElement === qs('#searchInput')) {
        qs('#searchInput').value = ''
        state.searchQuery = ''
        qs('#searchInput').blur()
        render()
        return
      }
      closeTopLayer()
      return
    }

    if (inInput) return

    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault()
      state.newIssue = {
        status: 'backlog',
        priority: 'normal',
        assignee: state.userName,
        project: '',
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

    if (e.key === '/') {
      e.preventDefault()
      const input = qs('#searchInput')
      if (input) input.focus()
      return
    }

    if (e.key === 'b' || e.key === 'B') {
      if (state.page === 'project') {
        state.view = 'board'
        render()
      }
      return
    }

    if (e.key === 'l' || e.key === 'L') {
      if (state.page === 'project') {
        state.view = 'list'
        render()
      }
      return
    }
  })
}
