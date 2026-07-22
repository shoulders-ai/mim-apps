// Behavioral contracts for the data layer (design-panel ruling):
//   1. A stale ui_thread response must never clobber the thread the user is
//      now looking at (rapid j/k navigation, keepExpanded refetch included).
//   2. Opening a thread flips the row read optimistically, but the server
//      ui_mark call fires only after ~800ms of dwell — selection pass-over
//      during held-down j/k never marks threads read on the server.
//   3. A draft_edit conflict never discards prose: reload the head, restore
//      the user's local text, re-send it on the new base revision; a second
//      conflict stops retrying and surfaces opError without touching the
//      buffer.
//
// The mock sits at the system boundary only: the /sdk/mim.js runtime that
// data.js imports dynamically (same boundary pattern as the board tests'
// vi.mock of their data module).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMock = vi.hoisted(() => ({
  call: vi.fn(),
  secrets: { set: vi.fn() },
}))

vi.mock('/sdk/mim.js', () => ({ runtime: runtimeMock }))

import { state, setRenderFn } from './state.js'
import { loadThread, openThread, backToList, queueDraftEdit, flushEdits, setSecret } from './data.js'

// The mocked /sdk/mim.js is served lazily: in a full-suite run the very
// first dynamic import can reject before the mock registry answers (data.js
// retries on the next call, so only the first import races). Warm it up
// once so no test races that first import.
beforeAll(async () => {
  for (let i = 0; i < 20; i++) {
    try { await setSecret('warmup', ''); return } catch { await new Promise(r => setTimeout(r, 10)) }
  }
})

// ── helpers ──

const rawRow = (id, extra = {}) => ({
  id, subject: `subject-${id}`, snippet: '', from_name: 'Anna',
  from_email: 'anna@example.com', last_message_at: 1000, is_unread: true,
  ...extra,
})

const rawMsg = (id, threadId) => ({
  id, thread_id: threadId, from_name: 'Anna', from_email: 'anna@example.com',
  body_text: `body of ${id}`, internal_date: 1000,
})

const threadPayload = (threadId, msgIds) => ({
  thread: rawRow(threadId),
  messages: msgIds.map(m => rawMsg(m, threadId)),
  drafts: [],
})

// Route package.tools.execute by tool name; state.tools maps key -> same name.
function respondWith(handlers) {
  runtimeMock.call.mockImplementation(async (method, args) => {
    if (method !== 'package.tools.execute') return {}
    const h = handlers[args.name]
    if (!h) throw new Error(`unexpected tool call: ${args.name}`)
    return typeof h === 'function' ? h(args.input) : h
  })
}

function toolInputs(name) {
  return runtimeMock.call.mock.calls
    .filter(([method, args]) => method === 'package.tools.execute' && args?.name === name)
    .map(([, args]) => args.input)
}

beforeEach(() => {
  vi.useFakeTimers()
  setRenderFn(() => {})
  runtimeMock.call.mockReset()
  state.tools = {
    ui_thread: 'ui_thread',
    ui_mark: 'ui_mark',
    draft_edit: 'draft_edit',
    ui_draft: 'ui_draft',
  }
  state.route = { view: 'inbox', threadId: null, draftId: null }
  state.inbox.threads = []
  state.inbox.selectedId = null
  state.thread = { thread: null, messages: [], drafts: [], expanded: new Set(), unquoted: new Set(), error: '' }
  Object.assign(state.studio, {
    open: false, draft: null, body: '', baseRevisionId: null, dirty: false,
    proposal: null, revisions: [], demoted: new Set(), stale: [], opError: '',
  })
  state.toast = { msg: '', action: null }
})

afterEach(() => {
  vi.useRealTimers()
  setRenderFn(() => {})
})

// ── 1. loadThread race guard ──

describe('loadThread race guard', () => {
  it('a stale response landing after the route moved on does not mutate state.thread', async () => {
    let resolveA
    respondWith({
      ui_thread: input => input.thread_id === 'A'
        ? new Promise(res => { resolveA = res })
        : threadPayload('B', ['mB1']),
    })

    state.route = { view: 'thread', threadId: 'A', draftId: null }
    const slowA = loadThread('A')

    // User j/k's on to B before A's response lands.
    state.route.threadId = 'B'
    await loadThread('B')
    expect(state.thread.error).toBe('')
    expect(state.thread.thread.id).toBe('B')
    expect(state.thread.messages.map(m => m.id)).toEqual(['mB1'])

    resolveA(threadPayload('A', ['mA1', 'mA2']))
    await slowA

    // B is still on screen — the older response must not clobber it.
    expect(state.thread.thread.id).toBe('B')
    expect(state.thread.messages.map(m => m.id)).toEqual(['mB1'])
    expect([...state.thread.expanded]).toEqual(['mB1'])
  })

  it('the keepExpanded refetch path is guarded too', async () => {
    respondWith({ ui_thread: input => threadPayload(input.thread_id, ['mA1']) })
    state.route = { view: 'thread', threadId: 'B', draftId: null }
    state.thread.thread = { id: 'B' }
    state.thread.messages = [{ id: 'mB1' }]
    state.thread.expanded = new Set(['mB1'])

    await loadThread('A', { keepExpanded: true })

    expect(state.thread.thread.id).toBe('B')
    expect(state.thread.messages.map(m => m.id)).toEqual(['mB1'])
  })

  it('a fresh response for the current route mutates state.thread', async () => {
    respondWith({ ui_thread: input => threadPayload(input.thread_id, ['m1', 'm2']) })
    state.route = { view: 'thread', threadId: 'A', draftId: null }

    await loadThread('A')

    expect(state.thread.thread.id).toBe('A')
    expect(state.thread.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect([...state.thread.expanded]).toEqual(['m2'])
    expect(state.thread.error).toBe('')
  })
})

// ── 2. deferred markRead ──

describe('openThread deferred markRead', () => {
  beforeEach(() => {
    state.inbox.threads = [
      { id: 'A', unread: true, kind: 'thread' },
      { id: 'B', unread: true, kind: 'thread' },
    ]
    respondWith({
      ui_thread: input => threadPayload(input.thread_id, [`m-${input.thread_id}`]),
      ui_mark: {},
    })
  })

  it('flips the row optimistically but does not call ui_mark before the dwell', async () => {
    await openThread('A')
    expect(state.inbox.threads[0].unread).toBe(false)
    expect(toolInputs('ui_mark')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(799)
    expect(toolInputs('ui_mark')).toHaveLength(0)
  })

  it('calls ui_mark after the thread has been open ~800ms', async () => {
    await openThread('A')
    await vi.advanceTimersByTimeAsync(800)
    expect(toolInputs('ui_mark')).toEqual([{ thread_id: 'A', read: true }])
  })

  it('pass-over during rapid j/k never marks skipped threads read on the server', async () => {
    await openThread('A')
    await vi.advanceTimersByTimeAsync(300)
    await openThread('B')
    await vi.advanceTimersByTimeAsync(800)
    // A was passed over — only B, the thread the user dwelled on, is marked.
    expect(toolInputs('ui_mark')).toEqual([{ thread_id: 'B', read: true }])
    expect(state.inbox.threads[0].unread).toBe(false) // optimistic flip kept
  })

  it('navigating back to the list before the dwell cancels the server call', async () => {
    await openThread('A')
    backToList()
    await vi.advanceTimersByTimeAsync(800)
    expect(toolInputs('ui_mark')).toHaveLength(0)
  })
})

// ── 3. draft_edit conflict never discards prose ──

describe('draft_edit conflict', () => {
  beforeEach(() => {
    Object.assign(state.studio, {
      open: true,
      draft: { id: 'd1' },
      body: 'my prose',
      baseRevisionId: 'r1',
    })
  })

  it('restores the local body after reload and re-sends it on the new base revision', async () => {
    const edits = []
    respondWith({
      draft_edit: input => {
        edits.push(input)
        return edits.length === 1 ? { conflict: true } : { revision_id: 'r3' }
      },
      ui_draft: { draft: { id: 'd1', current_revision_id: 'r2' }, body: 'server text', revisions: [] },
    })

    queueDraftEdit()
    await flushEdits()

    expect(edits).toHaveLength(2)
    expect(edits[0]).toMatchObject({ draft_id: 'd1', body: 'my prose', base_revision_id: 'r1' })
    expect(edits[1]).toMatchObject({ draft_id: 'd1', body: 'my prose', base_revision_id: 'r2' })
    expect(state.studio.body).toBe('my prose')     // the user's prose always wins
    expect(state.studio.baseRevisionId).toBe('r3') // ledgered on top of the new head
    expect(state.studio.opError).toBe('')
    expect(state.toast.msg).toBe('Draft changed elsewhere — kept your text')
  })

  it('does not re-send when the reloaded body already matches the local text', async () => {
    respondWith({
      draft_edit: () => ({ conflict: true }),
      ui_draft: { draft: { id: 'd1', current_revision_id: 'r2' }, body: 'my prose', revisions: [] },
    })

    queueDraftEdit()
    await flushEdits()

    expect(toolInputs('draft_edit')).toHaveLength(1)
    expect(state.studio.body).toBe('my prose')
    expect(state.studio.baseRevisionId).toBe('r2')
    expect(state.toast.msg).toBe('Draft changed elsewhere — kept your text')
  })

  it('a second conflict stops retrying and surfaces opError without touching the buffer', async () => {
    respondWith({
      draft_edit: () => ({ conflict: true }),
      ui_draft: { draft: { id: 'd1', current_revision_id: 'r2' }, body: 'server text', revisions: [] },
    })

    queueDraftEdit()
    await flushEdits()

    expect(toolInputs('draft_edit')).toHaveLength(2) // original + single retry, never loops
    expect(toolInputs('ui_draft')).toHaveLength(1)   // no second reload over the buffer
    expect(state.studio.body).toBe('my prose')
    expect(state.studio.dirty).toBe(true)            // a later edit will retry naturally
    expect(state.studio.opError).toBe('Draft is changing too fast — your text is preserved locally')
  })
})
