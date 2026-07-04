import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeNewIssueDraft } from './createDraft.js'
import { state } from './state.js'

const dataMocks = vi.hoisted(() => ({
  ensureBody: vi.fn(async issue => issue.body || ''),
  saveIssue: vi.fn(),
}))

vi.mock('./data.js', () => dataMocks)

const { commitFieldMenuTextInput } = await import('./fields.js')

describe('Board field menu text input contracts', () => {
  beforeEach(() => {
    state.newIssue = makeNewIssueDraft({ userName: 'Ada' })
    state.fieldMenu = { field: 'project', issueId: '', isNew: true, x: 0, y: 0 }
  })

  afterEach(() => {
    delete globalThis.document
  })

  it('commits a typed project when the menu is closed by mouse flow', () => {
    const input = {
      value: 'Launch',
      dataset: { field: 'project', id: '', new: '1' },
    }
    globalThis.document = {
      querySelector(selector) {
        return selector === '.field-menu .fm-input' ? input : null
      },
    }

    expect(commitFieldMenuTextInput({ close: true })).toBe(true)
    expect(state.newIssue.project).toBe('Launch')
    expect(state.fieldMenu).toBeNull()
  })
})

describe('Board field menu positioning contracts', () => {
  const openFieldMenuImport = import('./fields.js')

  beforeEach(() => {
    state.issues = []
    state.newIssue = makeNewIssueDraft({ userName: 'Ada' })
    state.fieldMenu = null
    globalThis.window = { innerWidth: 1200, innerHeight: 800 }
    globalThis.document = {
      querySelector() { return null },
    }
  })

  afterEach(() => {
    delete globalThis.document
    delete globalThis.window
  })

  it('positions the menu from the trigger rect measured before any commit re-render', async () => {
    const { openFieldMenu } = await openFieldMenuImport
    // A project menu is open with uncommitted text. Opening another field's
    // menu commits that text, which re-renders and detaches the clicked
    // trigger — after that its rect reads (0,0).
    state.fieldMenu = { field: 'project', issueId: '', isNew: true, x: 0, y: 0 }
    const input = {
      value: 'Launch',
      dataset: { field: 'project', id: '', new: '1' },
    }
    globalThis.document = {
      querySelector(selector) {
        return selector === '.field-menu .fm-input' ? input : null
      },
    }
    const trigger = {
      getBoundingClientRect() {
        const detached = state.newIssue.project === 'Launch'
        return detached
          ? { left: 0, right: 0, top: 0, bottom: 0 }
          : { left: 300, right: 340, top: 96, bottom: 120 }
      },
    }

    openFieldMenu(trigger, 'priority', '', true)

    expect(state.newIssue.project).toBe('Launch')
    expect(state.fieldMenu).toMatchObject({ field: 'priority', isNew: true })
    expect(state.fieldMenu.x).toBe(300)
    expect(state.fieldMenu.y).toBe(124)
  })

  it('clicking the open menu trigger again closes the menu', async () => {
    const { openFieldMenu } = await openFieldMenuImport
    state.fieldMenu = { field: 'status', issueId: 'issue-1', isNew: false, x: 10, y: 10 }
    const trigger = {
      getBoundingClientRect() {
        return { left: 50, right: 90, top: 40, bottom: 64 }
      },
    }

    openFieldMenu(trigger, 'status', 'issue-1', false)

    expect(state.fieldMenu).toBeNull()
  })

  it('clamps the menu inside the viewport', async () => {
    const { openFieldMenu } = await openFieldMenuImport
    const trigger = {
      getBoundingClientRect() {
        return { left: 1150, right: 1190, top: 700, bottom: 780 }
      },
    }

    openFieldMenu(trigger, 'status', 'issue-1', false)

    expect(state.fieldMenu.x).toBe(1200 - 220 - 8)
    expect(state.fieldMenu.y).toBe(800 - 300)
  })
})
