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
  it('renders type and summary controls in the list and detail surfaces', () => {
    const html = source()
    const js = script()

    expect(html).toContain('id="typeFilter"')
    expect(html).toContain('id="viewGraph"')
    expect(html).toContain('id="detailType"')
    expect(html).toContain('id="detailSummary"')
    expect(html).toContain('id="newType"')
    expect(html).toContain('id="newSummary"')
    expect(js).toContain("summary: raw.summary || ''")
    expect(js).toContain("type: raw.type || 'note'")
    expect(js).toContain('const excerpt = entry.summary ||')
    expect(js).toContain('class="card-type"')
  })

  it('filters by type and includes summaries in search', () => {
    const js = script()

    expect(js).toContain("let activeType = ''")
    expect(js).toContain('function getAllTypes()')
    expect(js).toContain("(e.type || 'note') === activeType")
    expect(js).toContain("(e.summary || '').toLowerCase().includes(q)")
    expect(js).toContain("typeFilterEl.addEventListener('change'")
  })

  it('loads list entries in small pages', () => {
    const js = script()

    expect(js).toContain('const LIST_PAGE_SIZE = 25')
    expect(js).toContain("runtime.call('knowledge.list', { limit: LIST_PAGE_SIZE, offset })")
    expect(js).toContain("typeof result?.nextOffset === 'number'")
    expect(js).toContain('loaded.push(...items.map(normEntry))')
  })

  it('keeps delete low-emphasis and confirms before deleting', () => {
    const html = source()
    const js = script()

    expect(html).toContain('aria-label="Delete entry"')
    expect(html).not.toContain('<button class="detail-delete-btn" id="detailDeleteBtn">Delete</button>')
    expect(js).toContain('window.confirm(`Delete "${title}"?')
    expect(js).toContain('if (!confirmed) return')
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

    expect(js).toContain('async function createEntry(title, type, summary, tags, body)')
    expect(js).toContain('type,')
    expect(js).toContain('summary,')
    expect(js).toContain("newTypeEl.value = activeType || 'note'")
    expect(js).toContain('newSummaryEl.value.trim()')
  })

  it('renders clickable detail links and a graph view', () => {
    const js = script()

    expect(js).toContain('function renderDetailLinks(entry)')
    expect(js).toContain('function bindDetailLinks()')
    expect(js).toContain('openDetail(id)')
    expect(js).toContain('function renderGraph()')
    expect(js).toContain('function buildGraph(sourceEntries)')
    expect(js).toContain('function renderGraphSvg(graph)')
    expect(js).toContain("contentEl.querySelectorAll('.graph-node')")
  })

  it('keeps graph dimensions stable enough for inspection', () => {
    expect(declaration(ruleFor('.graph-canvas'), 'min-height')).toBe('520px')
    expect(declaration(ruleFor('.graph-svg'), 'min-height')).toBe('520px')
    expect(declaration(ruleFor('.detail-link-item'), 'grid-template-columns')).toBe('100px minmax(0, 1fr)')
  })
})
