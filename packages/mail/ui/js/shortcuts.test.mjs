import { describe, expect, it } from 'vitest'
import { getScope, resolveKey } from './shortcuts.js'

const base = {
  route: 'inbox', threadOpen: false, wide: true,
  menuOpen: false, confirmOpen: false,
  focusRegion: null, hasPendingHunks: false,
}

describe('getScope', () => {
  it('menu beats confirm beats strip beats editor', () => {
    expect(getScope({ ...base, menuOpen: true, confirmOpen: true, focusRegion: 'strip' })).toBe('menu')
    expect(getScope({ ...base, confirmOpen: true, focusRegion: 'strip' })).toBe('confirm')
    expect(getScope({ ...base, focusRegion: 'strip' })).toBe('strip')
    expect(getScope({ ...base, focusRegion: 'editor' })).toBe('editor')
    expect(getScope({ ...base, focusRegion: 'comment' })).toBe('comment')
  })

  it('generic inputs get the input guard scope', () => {
    expect(getScope({ ...base, focusRegion: 'input' })).toBe('input')
  })

  it('routes resolve to list / thread / voices / onboarding', () => {
    expect(getScope(base)).toBe('list')
    expect(getScope({ ...base, threadOpen: true })).toBe('thread')
    expect(getScope({ ...base, threadOpen: true, focusRegion: 'list' })).toBe('list')
    expect(getScope({ ...base, route: 'voices' })).toBe('voices')
    expect(getScope({ ...base, route: 'onboarding' })).toBe('onboarding')
  })
})

describe('resolveKey — input guard', () => {
  it('single keys are dead in inputs', () => {
    expect(resolveKey('input', 'j', {})).toBeNull()
    expect(resolveKey('input', 'e', {})).toBeNull()
    expect(resolveKey('input', '/', {})).toBeNull()
    expect(resolveKey('input', 'c', {})).toBeNull()
  })

  it('Esc always works', () => {
    for (const scope of ['input', 'editor', 'strip', 'confirm', 'menu', 'list', 'thread', 'comment']) {
      expect(resolveKey(scope, 'Escape', {})).toBe('escape')
    }
  })

  it('modified combos pass through untouched (except ⌘⏎)', () => {
    expect(resolveKey('list', 'c', { meta: true })).toBeNull()
    expect(resolveKey('strip', 'Enter', { alt: true })).toBeNull()
    expect(resolveKey('editor', 'Enter', { meta: true })).toBe('primary')
    expect(resolveKey('input', 'Enter', { meta: true })).toBe('primary')
    expect(resolveKey('confirm', 'Enter', { meta: true })).toBe('confirm-send')
  })
})

describe('resolveKey — list scope', () => {
  it('covers the §5.1 list keys', () => {
    expect(resolveKey('list', 'j', {})).toBe('list-next')
    expect(resolveKey('list', 'ArrowDown', {})).toBe('list-next')
    expect(resolveKey('list', 'k', {})).toBe('list-prev')
    expect(resolveKey('list', 'ArrowUp', {})).toBe('list-prev')
    expect(resolveKey('list', 'o', {})).toBe('list-open')
    expect(resolveKey('list', 'Enter', {})).toBe('list-open')
    expect(resolveKey('list', 'e', {})).toBe('archive')
    expect(resolveKey('list', 'r', {})).toBe('reply')
    expect(resolveKey('list', 'c', {})).toBe('compose')
    expect(resolveKey('list', '1', {})).toBe('tab-1')
    expect(resolveKey('list', '4', {})).toBe('tab-4')
    expect(resolveKey('list', '/', {})).toBe('focus-search')
  })
})

describe('resolveKey — thread scope', () => {
  it('covers the §5.1 thread keys', () => {
    expect(resolveKey('thread', 'j', {})).toBe('thread-next')
    expect(resolveKey('thread', 'k', {})).toBe('thread-prev')
    expect(resolveKey('thread', 'e', {})).toBe('archive')
    expect(resolveKey('thread', 'r', {})).toBe('reply')
    expect(resolveKey('thread', 'u', {})).toBe('thread-up')
    expect(resolveKey('thread', 'Enter', {})).toBe('toggle-expand')
  })

  it('WIDE keeps compose and tabs reachable', () => {
    expect(resolveKey('thread', 'c', {}, { wide: true })).toBe('compose')
    expect(resolveKey('thread', '2', {}, { wide: true })).toBe('tab-2')
    expect(resolveKey('thread', 'c', {}, { wide: false })).toBeNull()
  })
})

describe('resolveKey — editor scope', () => {
  it('Tab cycles hunks only while pending hunks exist', () => {
    expect(resolveKey('editor', 'Tab', {}, { hasPendingHunks: true })).toBe('hunk-next')
    expect(resolveKey('editor', 'Tab', { shift: true }, { hasPendingHunks: true })).toBe('hunk-prev')
    expect(resolveKey('editor', 'Tab', {}, { hasPendingHunks: false })).toBeNull()
  })

  it('⌘⏎ is the primary path; plain typing passes through', () => {
    expect(resolveKey('editor', 'Enter', { meta: true })).toBe('primary')
    expect(resolveKey('editor', 'Enter', { ctrl: true })).toBe('primary')
    expect(resolveKey('editor', 'Enter', {})).toBeNull()
    expect(resolveKey('editor', 'j', {})).toBeNull()
  })
})

describe('resolveKey — strip scope', () => {
  it('covers the §5.1 strip keys', () => {
    expect(resolveKey('strip', 'Enter', {})).toBe('hunk-accept')
    expect(resolveKey('strip', 'Backspace', {})).toBe('hunk-reject')
    expect(resolveKey('strip', 'Delete', {})).toBe('hunk-reject')
    expect(resolveKey('strip', 'c', {})).toBe('hunk-comment')
    expect(resolveKey('strip', 'Tab', {})).toBe('hunk-next')
    expect(resolveKey('strip', 'Tab', { shift: true })).toBe('hunk-prev')
    expect(resolveKey('strip', 'j', {})).toBe('hunk-next')
    expect(resolveKey('strip', 'k', {})).toBe('hunk-prev')
    expect(resolveKey('strip', 'A', { shift: true })).toBe('accept-all')
  })

  it('there is no accept-all outside the strip scope', () => {
    expect(resolveKey('list', 'A', { shift: true })).toBeNull()
    expect(resolveKey('editor', 'A', { shift: true })).toBeNull()
  })
})

describe('resolveKey — confirm card', () => {
  it('plain Enter stays native (activates the FOCUSED button — Send or Cancel)', () => {
    // Mapping plain Enter to confirm-send would fire Send from a focused
    // Cancel button or from the editor behind the card.
    expect(resolveKey('confirm', 'Enter', {})).toBeNull()
    expect(resolveKey('confirm', 'j', {})).toBeNull()
    expect(resolveKey('confirm', 'Tab', {})).toBeNull() // trap handles Tab
  })

  it('⌘⏎ is the only send accelerator', () => {
    expect(resolveKey('confirm', 'Enter', { meta: true })).toBe('confirm-send')
    expect(resolveKey('confirm', 'Enter', { ctrl: true })).toBe('confirm-send')
    expect(resolveKey('confirm', 'Enter', { meta: true, alt: true })).toBeNull()
  })
})

describe('resolveKey — comment box', () => {
  it('Enter submits, single keys type normally', () => {
    expect(resolveKey('comment', 'Enter', {})).toBe('comment-submit')
    expect(resolveKey('comment', 'c', {})).toBeNull()
  })
})

describe('resolveKey — ruling additions (z, ?, g)', () => {
  it('z fires undo-toast in list and thread scopes only', () => {
    expect(resolveKey('list', 'z', {})).toBe('undo-toast')
    expect(resolveKey('thread', 'z', {})).toBe('undo-toast')
    expect(resolveKey('input', 'z', {})).toBeNull()
    expect(resolveKey('editor', 'z', {})).toBeNull()
    expect(resolveKey('strip', 'z', {})).toBeNull()
  })

  it('? opens help from non-input scopes', () => {
    expect(resolveKey('list', '?', { shift: true })).toBe('help')
    expect(resolveKey('thread', '?', { shift: true })).toBe('help')
    expect(resolveKey('voices', '?', { shift: true })).toBe('help')
    expect(resolveKey('input', '?', { shift: true })).toBeNull()
    expect(resolveKey('editor', '?', { shift: true })).toBeNull()
  })

  it('g opens the thread in Gmail from thread scope only', () => {
    expect(resolveKey('thread', 'g', {})).toBe('open-gmail')
    expect(resolveKey('list', 'g', {})).toBeNull()
  })
})
