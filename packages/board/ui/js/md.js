// Minimal markdown renderer for issue descriptions. Input is escaped first,
// so raw HTML in a body can never become live markup.
import { escapeHtml, escapeAttr } from './utils.js'

export function renderMarkdown(md) {
  if (!md) return ''
  let html = escapeHtml(md)

  // Pull code out before inline formatting so `*` and `_` inside code
  // never turn into emphasis; restored after block assembly.
  const stash = []
  const stashed = (markup) => `\x00${stash.push(markup) - 1}\x00`
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    stashed(`<pre><code>${code.trimEnd()}</code></pre>`))
  html = html.replace(/`([^`]+)`/g, (_, code) => stashed(`<code>${code}</code>`))
  html = html.replace(/^---+\s*$/gm, '<hr>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) =>
    `<a href="${escapeAttr(href)}" target="_blank">${label}</a>`)

  html = html.replace(/^[-*] \[x\] (.+)$/gm, '<li class="task-check checked">$1</li>')
  html = html.replace(/^[-*] \[ \] (.+)$/gm, '<li class="task-check">$1</li>')
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>')

  html = renderTables(html)

  const isPreBlock = (block) => {
    const m = /^\x00(\d+)\x00$/.exec(block)
    return m !== null && stash[Number(m[1])].startsWith('<pre')
  }

  html = html.split(/\n{2,}/).map(block => {
    block = block.trim()
    if (!block) return ''
    if (block.startsWith('<h') || block.startsWith('<pre') ||
        block.startsWith('<ul') || block.startsWith('<ol') ||
        block.startsWith('<blockquote') || block.startsWith('<table') ||
        block.startsWith('<hr') || isPreBlock(block)) return block
    return `<p>${block.replace(/\n/g, '<br>')}</p>`
  }).join('\n')

  return html.replace(/\x00(\d+)\x00/g, (_, i) => stash[Number(i)])
}

function renderTables(html) {
  return html.replace(/((?:^|\n)\|[^\n]+\|\s*\n\|[-:\s|]+\|\s*\n(?:\|[^\n]+\|\s*\n?)+)/g, (tableBlock) => {
    const lines = tableBlock.trim().split('\n').filter(Boolean)
    if (lines.length < 3) return tableBlock
    const parseRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    const headers = parseRow(lines[0])
    const rows = lines.slice(2).map(parseRow)
    return '<table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') +
      '</tr></thead><tbody>' + rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') +
      '</tbody></table>'
  })
}
