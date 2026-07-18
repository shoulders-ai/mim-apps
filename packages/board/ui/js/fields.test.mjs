import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeNewIssueDraft } from './createDraft.js'
import { LABEL_COLORS } from './constants.js'
import { state } from './state.js'

const dataMocks = vi.hoisted(() => ({
  ensureBody: vi.fn(async issue => issue.body || ''),
  saveIssue: vi.fn(),
}))

vi.mock('./data.js', () => dataMocks)

const {
  autoLabelColor,
  openFieldMenu,
  rankMatches,
  sanitizeLabelName,
  textCommitDecision,
} = await import('./fields.js')

describe('Board field menu match ranking', () => {
  it('sorts alphabetically when the query is empty', () => {
    expect(rankMatches(['ux', 'bug', 'infra'], '')).toEqual(['bug', 'infra', 'ux'])
  })

  it('ranks prefix matches before substring matches, then alphabetically', () => {
    expect(rankMatches(['debug', 'build', 'bug'], 'bu')).toEqual(['bug', 'build', 'debug'])
  })

  it('drops names that do not match and compares case-insensitively', () => {
    expect(rankMatches(['Bug', 'infra'], 'bu')).toEqual(['Bug'])
    expect(rankMatches(['infra'], 'zzz')).toEqual([])
  })
})

describe('Board field menu text commit decisions', () => {
  it('toggles the best label match while typing', () => {
    expect(textCommitDecision('labels', ['bug', 'build'], 'bu'))
      .toEqual({ type: 'toggle', value: 'bug' })
  })

  it('creates a sanitized label when nothing matches', () => {
    expect(textCommitDecision('labels', [], 'New Label!'))
      .toEqual({ type: 'create', value: 'new label' })
  })

  it('does nothing on an empty or fully sanitized-away query', () => {
    expect(textCommitDecision('labels', [], '   ')).toEqual({ type: 'none' })
    expect(textCommitDecision('labels', [], '!!!')).toEqual({ type: 'none' })
    expect(textCommitDecision('project', [], '')).toEqual({ type: 'none' })
  })

  it('prefers the exact project match over the ranked first', () => {
    expect(textCommitDecision('project', ['Launchpad', 'launch'], 'Launch'))
      .toEqual({ type: 'select', value: 'launch' })
  })

  it('selects the best project match, else creates', () => {
    expect(textCommitDecision('project', ['Launchpad'], 'Lau'))
      .toEqual({ type: 'select', value: 'Launchpad' })
    expect(textCommitDecision('project', [], 'Skunkworks'))
      .toEqual({ type: 'create', value: 'Skunkworks' })
  })
})

describe('Board label helpers', () => {
  it('sanitizes label names to the storage alphabet', () => {
    expect(sanitizeLabelName('  New Label! ')).toBe('new label')
    expect(sanitizeLabelName('***')).toBe('')
  })

  it('assigns a stable, non-gray color per label name', () => {
    const color = autoLabelColor('bug')
    expect(autoLabelColor('bug')).toBe(color)
    expect(LABEL_COLORS).toContain(color)
    expect(color).not.toBe('gray')
  })
})

describe('Board field menu positioning contracts', () => {
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

  it('switching menus discards pending filter text instead of committing it', () => {
    state.fieldMenu = { field: 'project', issueId: '', isNew: true, x: 0, y: 0, query: 'Lau' }
    const trigger = {
      getBoundingClientRect() {
        return { left: 300, right: 340, top: 96, bottom: 120 }
      },
    }

    openFieldMenu(trigger, 'priority', '', true)

    expect(state.newIssue.project).toBe('')
    expect(state.fieldMenu).toMatchObject({
      field: 'priority',
      isNew: true,
      query: '',
      colorPickerFor: null,
    })
    expect(state.fieldMenu.x).toBe(300)
    expect(state.fieldMenu.y).toBe(124)
  })

  it('clicking the open menu trigger again closes the menu', () => {
    state.fieldMenu = { field: 'status', issueId: 'issue-1', isNew: false, x: 10, y: 10 }
    const trigger = {
      getBoundingClientRect() {
        return { left: 50, right: 90, top: 40, bottom: 64 }
      },
    }

    openFieldMenu(trigger, 'status', 'issue-1', false)

    expect(state.fieldMenu).toBeNull()
  })

  it('clamps horizontally at open; vertical clamping happens at render with the real height', () => {
    const trigger = {
      getBoundingClientRect() {
        return { left: 1150, right: 1190, top: 700, bottom: 780 }
      },
    }

    openFieldMenu(trigger, 'status', 'issue-1', false)

    expect(state.fieldMenu.x).toBe(1200 - 220 - 8)
    expect(state.fieldMenu.y).toBe(784)
  })
})
