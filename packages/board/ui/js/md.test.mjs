import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './md.js'

describe('Board markdown renderer', () => {
  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
  })

  it('renders headers', () => {
    expect(renderMarkdown('## header2')).toContain('<h2>header2</h2>')
    expect(renderMarkdown('# top')).toContain('<h1>top</h1>')
    expect(renderMarkdown('### three')).toContain('<h3>three</h3>')
  })

  it('renders emphasis and inline code', () => {
    const html = renderMarkdown('**bold** and *em* and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<code>code</code>')
  })

  it('renders lists and task items', () => {
    const html = renderMarkdown('- one\n- [x] done\n- [ ] open')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li class="task-check checked">done</li>')
    expect(html).toContain('<li class="task-check">open</li>')
  })

  it('renders fenced code blocks without formatting their contents', () => {
    const html = renderMarkdown('```\n**not bold**\n```')
    expect(html).toContain('<pre><code>**not bold**</code></pre>')
  })

  it('renders links with escaped hrefs', () => {
    const html = renderMarkdown('[docs](https://example.com)')
    expect(html).toContain('<a href="https://example.com" target="_blank">docs</a>')
  })

  it('renders tables', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>2</td>')
  })

  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown('</textarea><button data-action="new-issue">bad</button>')
    expect(html).not.toContain('<button')
    expect(html).toContain('&lt;button')
  })

  it('wraps loose text in paragraphs with line breaks', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one<br>two</p>\n<p>three</p>')
  })
})
