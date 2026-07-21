import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const here = dirname(fileURLToPath(import.meta.url))

function source() {
  return readFileSync(join(here, 'index.html'), 'utf8')
}

function script() {
  return source().match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? ''
}

function styles() {
  const style = source().match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1]
  if (!style) throw new Error('Missing knowledge style block')
  return postcss.parse(style)
}

function ruleFor(selector) {
  let match = null
  styles().walkRules(rule => {
    if (!match && rule.selector === selector) match = rule
  })
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match
}

function declaration(rule, property) {
  const match = rule.nodes.find(node => node.type === 'decl' && node.prop === property)
  if (!match || match.type !== 'decl') throw new Error(`Missing ${property} declaration`)
  return match.value
}

describe('Knowledge UI contract', () => {
  it('paints the first page immediately and streams the rest in the background', () => {
    const js = script()

    expect(js).toContain('const FIRST_PAGE_SIZE')
    expect(js).toContain('const PAGE_SIZE')
    expect(js).toContain('async function loadFirstPage()')
    expect(js).toContain('async function loadRemainingPages(')
    expect(js).toContain("runtime.call('knowledge.list', { limit: FIRST_PAGE_SIZE, offset: 0 })")
    expect(js).toContain("typeof result?.nextOffset === 'number'")
    // A stale background load must never clobber a newer workspace's entries.
    expect(js).toContain('loadGen')
    expect(js).toContain('function renderSkeleton()')
  })

  it('searches through the backend FTS index with a debounce and client-side fallback', () => {
    const js = script()

    expect(js).toContain('const SEARCH_DEBOUNCE_MS')
    expect(js).toContain("runtime.call('knowledge.search'")
    // Stale responses must be dropped, not rendered.
    expect(js).toContain('searchSeq')
    expect(js).toContain('function clientMatch(')
    expect(js).toContain("(entry.summary || '').toLowerCase().includes(q)")
  })

  it('shows entry counts and filters by type', () => {
    const html = source()
    const js = script()

    expect(html).toContain('id="entryCount"')
    expect(js).toContain("let activeType = ''")
    expect(js).toContain('function computeTypeCounts()')
    expect(js).toContain("(e.type || 'note') === activeType")
  })

  it('ranks the tag bar by frequency with an overflow popover', () => {
    const js = script()

    expect(js).toContain('function computeTagCounts()')
    expect(js).toContain('const TAG_BAR_LIMIT')
    expect(js).toContain('function renderTagBar()')
    expect(js).toContain('openTagOverflow')
  })

  it('edits tags through a token editor with corpus autocomplete', () => {
    const js = script()

    expect(js).toContain('function createTagEditor(')
    expect(js).toContain('suggest')
    // Case-insensitive duplicate guard.
    expect(js).toContain('toLowerCase() === ')
  })

  it('uses multi-line summary fields with a character counter', () => {
    const html = source()
    const js = script()

    expect(html).toContain('id="newSummary"')
    expect(html).not.toContain('<input type="text" id="newSummary"')
    expect(js).toContain('detailSummary')
    expect(js).toContain('function bindSummaryCounter(')
    expect(js).toContain('function autoGrow(')
  })

  it('opens entries in view mode and only saves on explicit action', () => {
    const js = script()

    expect(js).toContain('function renderDetailView(')
    expect(js).toContain('function renderDetailEdit(')
    expect(js).toContain('async function saveDetailChanges()')
    // No silent blur autosave on metadata.
    expect(js).not.toContain("detailTitleEl.addEventListener('blur'")
    expect(js).not.toContain("detailTagsEl.addEventListener('blur'")
  })

  it('confirms deletes inline and offers undo', () => {
    const js = script()

    expect(js).not.toContain('window.confirm')
    expect(js).toContain('armDelete')
    expect(js).toContain('function showToast(')
    expect(js).toContain("'Undo'")
  })

  it('shows backlinks in the detail view', () => {
    const js = script()

    expect(js).toContain("runtime.call('knowledge.neighbors'")
    expect(js).toContain('incoming')
  })

  it('preserves graph fields and extra metadata when saving through the detail view', () => {
    const js = script()

    expect(js).toContain("type: entry.type || 'note'")
    expect(js).toContain("summary: entry.summary || ''")
    expect(js).toContain("links: (entry.links || []).map(link => `${link.rel} ${link.target}`)")
    expect(js).toContain('extra: entry.extra || {}')
    expect(js).toContain('Object.assign(entry, normEntry(full))')
  })

  it('creates typed entries with optional summaries', () => {
    const js = script()

    expect(js).toContain('async function createEntry(')
    expect(js).toContain("newTypeEl.value = activeType || 'note'")
    expect(js).toContain('newSummaryEl.value.trim()')
  })

  it('renders an interactive force graph with degree sizing and a legend', () => {
    const js = script()

    expect(js).toContain('function renderGraph()')
    expect(js).toContain('function buildGraph(')
    expect(js).toContain('function tickGraph(')
    expect(js).toContain('function nodeRadius(')
    expect(js).toContain('function fitGraphView(')
    expect(js).toContain("'wheel'")
    expect(js).toContain("'pointerdown'")
    expect(js).toContain('graph-legend')
    // The layout must not clamp nodes to a hard rectangle.
    expect(js).not.toContain('clamp(node.x + node.vx')
  })

  it('highlights the hovered node neighborhood and relation labels', () => {
    const js = script()

    expect(js).toContain('adjacency')
    expect(js).toContain('graph-edge-label')
    expect(js).toContain("classList.add('hl')")
  })

  it('supports tables, task lists, and rules in markdown', () => {
    const js = script()

    expect(js).toContain('function renderTables(')
    expect(js).toContain('task-check')
    expect(js).toContain('<hr>')
  })

  it('navigates the card grid from the keyboard', () => {
    const js = script()

    expect(js).toContain("'ArrowRight'")
    expect(js).toContain("'ArrowDown'")
    expect(js).toContain('function moveCardFocus(')
    expect(js).toContain('tabindex="0"')
  })

  it('keeps graph dimensions stable enough for inspection', () => {
    expect(declaration(ruleFor('.graph-canvas'), 'min-height')).toBe('520px')
    expect(declaration(ruleFor('.graph-svg'), 'min-height')).toBe('520px')
  })

  it('respects reduced-motion preferences', () => {
    const html = source()
    expect(html).toContain('prefers-reduced-motion')
  })

  it('offers board and timeline projections alongside list and graph', () => {
    const html = source()
    const js = script()

    expect(html).toContain('id="viewBoard"')
    expect(html).toContain('id="viewTimeline"')
    expect(js).toContain('function renderBoard()')
    expect(js).toContain('function renderTimeline()')
    // Both views reuse the shared filter pipeline instead of refetching.
    expect(js.match(/getFilteredEntries\(\)/g).length).toBeGreaterThanOrEqual(4)
  })

  it('groups the board by frontmatter status with known columns first', () => {
    const js = script()

    expect(js).toContain('const STATUS_ORDER')
    expect(js).toContain('function statusOf(')
    expect(js).toContain('function boardColumnOrder(')
    // Unknown statuses must still get a column, not disappear.
    expect(js).toContain('filter(status => !seen.has(status)).sort()')
    // Every canonical status must resolve to a color token.
    expect(js).toContain('const STATUS_COLORS')
    expect(js).toContain('STATUS_ORDER = Object.keys(STATUS_COLORS)')
  })

  it('persists a user-dragged column order in app KV storage', () => {
    const js = script()

    expect(js).toContain("runtime.call('package.data.kv.get', { key: BOARD_ORDER_KEY })")
    expect(js).toContain("runtime.call('package.data.kv.set', { key: BOARD_ORDER_KEY, value: order })")
    expect(js).toContain('function startBoardDrag(')
    // The stored order wins; canonical order is only a fallback.
    expect(js).toContain('for (const status of boardOrder || []) take(status)')
    // A failed KV read must not break the board.
    expect(js).toContain('board order load error')
  })

  it('scales timeline staleness bars against a bounded window', () => {
    const js = script()

    expect(js).toContain('const TIMELINE_MAX_DAYS')
    expect(js).toContain('function daysSince(')
    // Entries without any date must be excluded, not rendered as fresh.
    expect(js).toContain('row.days !== null')
  })
})
