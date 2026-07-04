import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeNewIssueDraft } from './createDraft.js'
import { state } from './state.js'

vi.mock('./data.js', () => ({
  deleteIssue: vi.fn(),
  ensureBody: vi.fn(async issue => issue.body || ''),
  saveIssue: vi.fn(),
}))

const { renderDetail, syncDetailDraftFromDom, handleDeleteIssue } = await import('./detail.js')

describe('Board detail view draft contracts', () => {
  beforeEach(() => {
    state.issues = [{
      ...makeNewIssueDraft(),
      id: 'issue-1700000000-ab12',
      title: '<button data-action="new-issue">bad</button>',
      body: '</textarea><button data-action="new-issue">bad</button>',
      status: 'backlog',
      priority: 'normal',
      labels: [{ name: '<b>bug</b>', color: 'red' }],
      tags: ['<b>bug</b>'],
      project: '<img src=x>',
      assignee: '<script>',
      dueDate: '',
      created: '2026-01-01T00:00:00.000Z',
      updated: '',
    }]
    state.detailIssueId = 'issue-1700000000-ab12'
    state.page = 'detail'
  })

  afterEach(() => {
    delete globalThis.document
  })

  it('escapes issue text instead of rendering it as controls', () => {
    const html = renderDetail()

    expect(html).toContain('&lt;button data-action=&quot;new-issue&quot;&gt;bad&lt;/button&gt;')
    expect(html).toContain('&lt;/textarea&gt;&lt;button data-action=&quot;new-issue&quot;&gt;bad&lt;/button&gt;')
    expect(html).toContain('&lt;b&gt;bug&lt;/b&gt;')
    expect(html).not.toContain('<button data-action="new-issue">bad</button>')
  })

  it('syncs detail input values into issue state before rerenders', () => {
    const title = { value: 'Updated title' }
    const body = { value: 'Updated body' }
    globalThis.document = {
      querySelector(selector) {
        if (selector === '#detailTitle') return title
        if (selector === '#detailBody') return body
        return null
      },
    }

    syncDetailDraftFromDom()

    expect(state.issues[0].title).toBe('Updated title')
    expect(state.issues[0].body).toBe('Updated body')
  })

  it('delete requires two clicks to confirm', async () => {
    const id = state.issues[0].id
    state.deleteConfirmId = null

    await handleDeleteIssue(id)
    expect(state.deleteConfirmId).toBe(id)
    expect(state.page).toBe('detail')

    const html = renderDetail()
    expect(html).toContain('Confirm delete')

    globalThis.document = {
      querySelector() { return null },
    }
    await handleDeleteIssue(id)
    expect(state.deleteConfirmId).toBeNull()
    expect(state.page).toBe('project')
  })

  it('does not turn an unloaded blank body into a user edit', () => {
    delete state.issues[0].body
    const title = { value: 'Updated title' }
    const body = { value: '' }
    globalThis.document = {
      querySelector(selector) {
        if (selector === '#detailTitle') return title
        if (selector === '#detailBody') return body
        return null
      },
    }

    syncDetailDraftFromDom()

    expect(state.issues[0].title).toBe('Updated title')
    expect(state.issues[0].body).toBeUndefined()
  })
})

describe('Board detail description modes', () => {
  beforeEach(() => {
    state.issues = [{
      ...makeNewIssueDraft(),
      id: 'issue-1700000000-cd34',
      title: 'Ship it',
      body: '## header2\n\nSome *text*',
      status: 'backlog',
      priority: 'normal',
      labels: [],
      tags: [],
      project: '',
      assignee: '',
      dueDate: '',
      created: '2026-01-01T00:00:00.000Z',
      updated: '',
    }]
    state.detailIssueId = 'issue-1700000000-cd34'
    state.page = 'detail'
    state.detailBodyEditing = false
  })

  afterEach(() => {
    delete globalThis.document
    state.detailBodyEditing = false
  })

  it('renders the body as markdown when not editing', () => {
    const html = renderDetail()
    expect(html).toContain('<h2>header2</h2>')
    expect(html).toContain('<em>text</em>')
    expect(html).not.toContain('id="detailBody"')
    expect(html).toContain('data-action="edit-body"')
  })

  it('renders the textarea when editing', () => {
    state.detailBodyEditing = true
    const html = renderDetail()
    expect(html).toContain('id="detailBody"')
    expect(html).toContain('## header2')
    expect(html).not.toContain('<h2>header2</h2>')
  })

  it('shows a click-to-edit placeholder for an empty body', () => {
    state.issues[0].body = ''
    const html = renderDetail()
    expect(html).toContain('data-action="edit-body"')
    expect(html).toContain('Add a description')
  })

  it('does not offer editing before the body has loaded', () => {
    delete state.issues[0].body
    const html = renderDetail()
    expect(html).not.toContain('data-action="edit-body"')
    expect(html).not.toContain('id="detailBody"')
  })
})
