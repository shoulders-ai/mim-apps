import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { state, setRenderFn, showToast, pauseToast, resumeToast, closeTopLayer, openMenuName } from './state.js'

function resetLayers() {
  for (const k of Object.keys(state.menus)) state.menus[k] = false
  state.menuAnchor = null
  state.studio.commentFor = null
  state.voices.commentFor = null
  state.studio.confirm = null
}

describe('store shape (§7.1)', () => {
  it('has the spec keys with sane defaults', () => {
    expect(state.tools).toEqual({})
    expect(state.breakpoint).toBe('wide')
    expect(state.route).toMatchObject({ threadId: null, draftId: null })
    expect(state.conn.backfill).toMatchObject({ state: 'pending', done: 0, total: 0 })
    expect(state.inbox.tab).toBe('inbox')
    expect(state.studio).toMatchObject({ open: false, draft: null, confirm: null, commentFor: null })
    expect(state.studio.demoted).toBeInstanceOf(Set)
    expect(state.banner).toBeNull()
  })
})

describe('closeTopLayer cascade (§5.1 Esc order)', () => {
  beforeEach(resetLayers)

  it('menu closes first and reports its invoker', () => {
    state.menus.settings = true
    state.menuAnchor = { invokerId: 'btnSettings' }
    state.studio.commentFor = 'h1'
    state.studio.confirm = 'card'
    expect(closeTopLayer()).toEqual({ kind: 'menu', name: 'settings', invokerId: 'btnSettings' })
    expect(openMenuName()).toBeNull()
    expect(state.studio.commentFor).toBe('h1') // untouched
  })

  it('comment box closes before the confirm card', () => {
    state.studio.commentFor = 'h1'
    state.studio.confirm = 'card'
    expect(closeTopLayer()).toEqual({ kind: 'comment', hunkId: 'h1' })
    expect(state.studio.confirm).toBe('card')
  })

  it('confirm card closes next', () => {
    state.studio.confirm = 'card'
    expect(closeTopLayer()).toEqual({ kind: 'confirm' })
    expect(state.studio.confirm).toBeNull()
  })

  it('a locked (sending) card refuses to close', () => {
    state.studio.confirm = 'sending'
    expect(closeTopLayer()).toEqual({ kind: 'locked' })
    expect(state.studio.confirm).toBe('sending')
  })

  it('the send-failed error card closes on Esc', () => {
    state.studio.confirm = { error: 'SMTP said no' }
    expect(closeTopLayer()).toEqual({ kind: 'confirm' })
    expect(state.studio.confirm).toBeNull()
  })

  it('returns null when only DOM layers remain', () => {
    expect(closeTopLayer()).toBeNull()
  })
})

describe('showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setRenderFn(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    setRenderFn(() => {})
  })

  it('shows for 2.5s without an action', () => {
    showToast('Sent to Anna Schmidt')
    expect(state.toast.msg).toBe('Sent to Anna Schmidt')
    vi.advanceTimersByTime(2499)
    expect(state.toast.msg).toBe('Sent to Anna Schmidt')
    vi.advanceTimersByTime(2)
    expect(state.toast.msg).toBe('')
  })

  it('shows for 8s when carrying an action', () => {
    showToast('Archived', { label: 'Undo', fn: () => {} })
    vi.advanceTimersByTime(7999)
    expect(state.toast.msg).toBe('Archived')
    vi.advanceTimersByTime(2)
    expect(state.toast.msg).toBe('')
  })

  it('a new toast replaces the old one and its timer', () => {
    showToast('First')
    vi.advanceTimersByTime(1000)
    showToast('Second')
    vi.advanceTimersByTime(1000)
    expect(state.toast.msg).toBe('Second')
    vi.advanceTimersByTime(1600)
    expect(state.toast.msg).toBe('')
  })

  it('pauseToast holds the message; resumeToast restarts a short timer', () => {
    showToast('Archived', { label: 'Undo', fn: () => {} })
    vi.advanceTimersByTime(7000)
    pauseToast()
    vi.advanceTimersByTime(60000)
    expect(state.toast.msg).toBe('Archived')
    resumeToast()
    vi.advanceTimersByTime(2999)
    expect(state.toast.msg).toBe('Archived')
    vi.advanceTimersByTime(2)
    expect(state.toast.msg).toBe('')
  })
})
