import { describe, expect, it } from 'vitest'
import {
  locateHunks, nextActive, firstPending, hunkIdsInParagraph,
  diffWords, applyHunkLocal, classifyRemoval, normHunkChanges, stripHtml,
} from './hunks.js'

const body = 'Hi Anna,\n\nthanks for the numbers you sent over.\n\nI would keep the infra line where it is.\n\nBest,\nPaul'

function h(id, original, proposed, extra = {}) {
  return { id, original_text: original, proposed_text: proposed, note: '', status: 'pending', ...extra }
}

describe('locateHunks', () => {
  it('locates unique matches in document order with paragraph indices', () => {
    const { vms, unanchored } = locateHunks(body, [
      h('b', 'infra line', 'infrastructure line'),
      h('a', 'thanks for the numbers', 'thanks a lot for the numbers'),
    ])
    expect(unanchored).toEqual([])
    expect(vms.map(v => v.id)).toEqual(['a', 'b'])
    expect(vms[0].paraIndex).toBe(1)
    expect(vms[1].paraIndex).toBe(2)
  })

  it('flags zero and ambiguous matches as unanchored', () => {
    const { vms, unanchored } = locateHunks(body, [
      h('gone', 'no such text', 'x'),
      h('multi', 'the', 'a'), // appears twice
    ])
    expect(vms).toEqual([])
    expect(unanchored.sort()).toEqual(['gone', 'multi'])
  })

  it('classifies deletions via empty proposed_text', () => {
    const { vms } = locateHunks(body, [h('d', 'I would keep the infra line where it is.', '')])
    expect(vms[0].kind).toBe('rem')
  })

  it('skips non-pending hunks', () => {
    const { vms, unanchored } = locateHunks(body, [h('x', 'infra line', 'y', { status: 'stale' })])
    expect(vms).toEqual([])
    expect(unanchored).toEqual([])
  })

  it('NFC-normalizes before matching', () => {
    const decomposed = 'Café time'
    const { vms } = locateHunks(decomposed, [h('n', 'Café', 'Bar')])
    expect(vms).toHaveLength(1)
  })
})

describe('cycling', () => {
  const { vms } = locateHunks(body, [
    h('a', 'thanks for the numbers', 'x'),
    h('b', 'infra line', 'y'),
    h('c', 'Best,', 'Cheers,'),
  ])

  it('moves in document order and wraps at both ends', () => {
    expect(firstPending(vms)).toBe('a')
    expect(nextActive(vms, 'a', 1)).toBe('b')
    expect(nextActive(vms, 'c', 1)).toBe('a')
    expect(nextActive(vms, 'a', -1)).toBe('c')
  })

  it('starts from the edge when active is unknown', () => {
    expect(nextActive(vms, null, 1)).toBe('a')
    expect(nextActive(vms, 'zz', -1)).toBe('c')
  })

  it('demoted hunks drop out of the cycle', () => {
    const demoted = new Set(['b'])
    expect(nextActive(vms, 'a', 1, demoted)).toBe('c')
    expect(firstPending(vms, new Set(['a']))).toBe('b')
    expect(nextActive(vms, 'a', 1, new Set(['a', 'b', 'c']))).toBe(null)
  })

  it('hunkIdsInParagraph groups by paragraph', () => {
    expect(hunkIdsInParagraph(vms, 1)).toEqual(['a'])
    expect(hunkIdsInParagraph(vms, 3)).toEqual(['c'])
  })
})

describe('diffWords', () => {
  it('marks only changed runs', () => {
    const segs = diffWords('thanks for the quick numbers', 'thanks a lot for the numbers')
    const changed = segs.filter(s => s.changed).map(s => s.text.trim())
    expect(changed.join(' ')).toContain('a lot')
    expect(segs.filter(s => !s.changed).map(s => s.text).join('')).toContain('thanks')
  })

  it('returns one changed segment for a full rewrite', () => {
    const segs = diffWords('alpha beta', 'gamma delta')
    expect(segs.every(s => s.changed)).toBe(true)
  })

  it('empty original marks everything changed', () => {
    expect(diffWords('', 'new text')).toEqual([{ text: 'new text', changed: true }])
  })

  it('identical strings produce one unchanged segment', () => {
    expect(diffWords('same here', 'same here')).toEqual([{ text: 'same here', changed: false }])
  })
})

describe('applyHunkLocal', () => {
  it('replaces the unique span', () => {
    const out = applyHunkLocal('a b c', { original_text: 'b', proposed_text: 'X' })
    expect(out).toBe('a X c')
  })

  it('collapses a 3+ newline seam to two on deletion', () => {
    const out = applyHunkLocal('one\n\ntwo\n\nthree', { original_text: 'two', proposed_text: '' })
    expect(out).toBe('one\n\nthree')
  })

  it('keeps a 2-newline seam untouched on inline deletion', () => {
    const out = applyHunkLocal('keep this. drop this. end', { original_text: ' drop this.', proposed_text: '' })
    expect(out).toBe('keep this. end')
  })

  it('returns null when the span cannot be located uniquely', () => {
    expect(applyHunkLocal('a a', { original_text: 'a', proposed_text: 'b' })).toBeNull()
    expect(applyHunkLocal('abc', { original_text: 'zz', proposed_text: 'b' })).toBeNull()
  })
})

describe('classifyRemoval', () => {
  it('whole paragraph vs sentence', () => {
    expect(classifyRemoval({ original_text: 'Whole para.' }, 'Whole para.')).toBe('paragraph')
    expect(classifyRemoval({ original_text: 'One bit.' }, 'One bit. More here.')).toBe('sentence')
  })
})

describe('normHunkChanges', () => {
  it('accepts array-of-rows payloads', () => {
    const out = normHunkChanges([
      { id: 'a', status: 'stale' },
      { hunk_id: 'b', status: 'pending' },
      { id: 'c', status: 'accepted' },
    ])
    expect(out).toEqual({ stale: ['a'], pending: ['b'] })
  })

  it('accepts object payloads and empty input', () => {
    expect(normHunkChanges({ stale: ['x'], pending: ['y'] })).toEqual({ stale: ['x'], pending: ['y'] })
    expect(normHunkChanges(null)).toEqual({ stale: [], pending: [] })
  })
})

describe('stripHtml', () => {
  const { vms } = locateHunks(body, [h('a', 'thanks for the numbers', 'thanks a lot for the numbers', { note: 'Warmer opening' })])

  it('renders the note, counter, actions and word marks', () => {
    const html = stripHtml(vms[0], { index: 2, total: 3 })
    expect(html).toContain('Warmer opening')
    expect(html).toContain('2 / 3')
    expect(html).toContain('Accept ⏎')
    expect(html).toContain('mark class="word"')
    expect(html).toContain('aria-label="Proposed change 2 of 3: Warmer opening"')
    expect(html).toContain('tabindex="0"')
  })

  it('deletion strips have no body and say what is removed', () => {
    const { vms: del } = locateHunks(body, [h('d', 'I would keep the infra line where it is.', '')])
    const html = stripHtml(del[0], { index: 1, total: 1, paraText: 'I would keep the infra line where it is.' })
    expect(html).toContain('Remove this paragraph')
    expect(html).not.toContain('strip-body')
  })

  it('escapes hunk content', () => {
    const { vms: xss } = locateHunks('safe <script> here', [h('x', '<script>', 'ok')])
    const html = stripHtml(xss[0], { index: 1, total: 1 })
    expect(html).not.toContain('<script>')
  })

  it('renders the comment box when open', () => {
    const html = stripHtml(vms[0], { index: 1, total: 1, commentOpen: true, commentValue: 'too formal' })
    expect(html).toContain('hunkCommentInput')
    expect(html).toContain('too formal')
    expect(html).toContain('Ask to revise')
    expect(html).toContain('Reject with note')
  })

  it('renders the revising shimmer as a strip-scoped region', () => {
    const html = stripHtml(vms[0], { index: 1, total: 1, revising: true })
    expect(html).toContain('Revising…')
    // Without data-region the focused shimmer would leak j/k to thread nav.
    expect(html).toContain('data-region="strip"')
  })
})
