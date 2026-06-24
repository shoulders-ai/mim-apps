import { rebuildKnowledgeIndex, searchKnowledgeIndex } from './indexer.mjs'

const KNOWLEDGE_DIR = 'knowledge'
const KNOWLEDGE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/
const SUMMARY_RECOMMENDED_CHARS = 320
const SUMMARY_HARD_LIMIT_CHARS = 1000
const AGENT_CONTEXT_MAX_CHARS = 1400

const KNOWN_FIELDS = new Set([
  'id',
  'title',
  'type',
  'summary',
  'tags',
  'links',
  'extra',
  'created',
  'updated',
  'body',
])

const fieldsSchema = {
  id: { type: 'string', description: 'Optional lowercase slug id, e.g. fde-three-views.' },
  title: { type: 'string' },
  type: { type: 'string', description: 'Entry type: person, org, project, note, or record. Defaults to note.' },
  summary: {
    type: 'string',
    maxLength: SUMMARY_RECOMMENDED_CHARS,
    description: `Optional retrieval summary. Keep under ${SUMMARY_RECOMMENDED_CHARS} characters unless there is a strong reason.`,
  },
  tags: { type: 'array', items: { type: 'string' } },
  links: {
    type: 'array',
    items: { type: 'string' },
    description: 'Directed graph links as "relation target-id", e.g. "works_at eversana".',
  },
  extra: {
    type: 'object',
    additionalProperties: true,
    description: 'Type-specific frontmatter fields such as email, role, status, rate, domain, sensitive.',
  },
  body: { type: 'string' },
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required }
}

export function newKnowledgeId(title = 'knowledge') {
  return slugifyId(title) || 'knowledge'
}

function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return { fm: null, body: raw }
  const rest = raw.slice(3)
  const nl = rest.indexOf('\n')
  if (nl === -1) return { fm: null, body: raw }
  const afterOpen = rest.slice(nl + 1)
  const closeMatch = afterOpen.match(/\n?---[ \t]*(\r?\n|$)/)
  if (!closeMatch || closeMatch.index === undefined) return { fm: null, body: raw }
  const fm = afterOpen.slice(0, closeMatch.index)
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length)
  return { fm, body }
}

function parseFrontmatter(text) {
  const meta = {}
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (!match) {
      i += 1
      continue
    }
    const key = match[1]
    const value = match[2].trim()
    if (value !== '') {
      meta[key] = parseScalar(value)
      i += 1
      continue
    }
    const block = []
    i += 1
    while (i < lines.length && /^[ \t]+/.test(lines[i])) {
      block.push(lines[i])
      i += 1
    }
    meta[key] = parseYamlListBlock(block)
  }
  return meta
}

function parseYamlListBlock(lines) {
  const out = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('- ')) continue
    out.push(parseScalar(line.slice(2).trim()))
  }
  return out
}

function parseScalar(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) } catch { return trimmed.slice(1, -1) }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      return trimmed.slice(1, -1).split(',').map(part => parseScalar(part)).filter(Boolean)
    }
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function yamlScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return JSON.stringify(String(value ?? ''))
}

function coerceTags(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    return value.split(',').map(t => t.trim()).filter(Boolean)
  }
  return []
}

function coerceLinks(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(link => {
      if (link && typeof link === 'object' && typeof link.rel === 'string' && typeof link.target === 'string') {
        return { rel: link.rel.trim(), target: link.target.trim() }
      }
      const parts = String(link ?? '').trim().split(/\s+/, 2)
      if (parts.length < 2) return null
      return { rel: parts[0], target: parts[1] }
    })
    .filter(link => link && link.rel && link.target)
}

function coerceExtra(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function entryExtra(meta) {
  const extra = {}
  for (const [key, value] of Object.entries(meta || {})) {
    if (!KNOWN_FIELDS.has(key)) extra[key] = value
  }
  return extra
}

function normalizeSummary(summary) {
  if (summary === undefined || summary === null) return ''
  const value = String(summary)
  if (value.length > SUMMARY_HARD_LIMIT_CHARS) {
    throw new Error(`summary is too long; keep summaries under ${SUMMARY_RECOMMENDED_CHARS} characters`)
  }
  return value
}

function normalizeType(type) {
  const value = typeof type === 'string' && type.trim() ? type.trim() : 'note'
  return value.toLowerCase()
}

function isSensitive(entry) {
  return entry?.extra?.sensitive === true || entry?.extra?.sensitive === 'true'
}

function slugifyId(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug
}

function requireValidId(id) {
  if (!KNOWLEDGE_ID_RE.test(id)) throw new Error(`Invalid knowledge id: ${id}`)
  return id
}

export function parseKnowledge(id, raw) {
  const { fm, body } = splitFrontmatter(String(raw ?? ''))
  let meta = {}
  try {
    meta = fm === null ? {} : parseFrontmatter(fm)
  } catch {
    meta = {}
  }
  return {
    id,
    title: typeof meta.title === 'string' ? meta.title : '',
    type: normalizeType(meta.type),
    summary: normalizeSummary(meta.summary),
    tags: coerceTags(meta.tags),
    links: coerceLinks(meta.links),
    extra: entryExtra(meta),
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    body,
  }
}

export function serializeKnowledge(entry) {
  const lines = [`title: ${yamlScalar(entry.title)}`]
  lines.push(`type: ${yamlScalar(normalizeType(entry.type))}`)
  const summary = normalizeSummary(entry.summary)
  if (summary) lines.push(`summary: ${yamlScalar(summary)}`)
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    lines.push('tags:')
    for (const tag of entry.tags) lines.push(`  - ${yamlScalar(tag)}`)
  }
  const links = coerceLinks(entry.links)
  if (links.length > 0) {
    lines.push('links:')
    for (const link of links) lines.push(`  - ${yamlScalar(`${link.rel} ${link.target}`)}`)
  }
  const extra = coerceExtra(entry.extra)
  for (const [key, value] of Object.entries(extra)) {
    if (KNOWN_FIELDS.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`)
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`)
    }
  }
  lines.push(`created: ${yamlScalar(entry.created)}`)
  lines.push(`updated: ${yamlScalar(entry.updated)}`)
  return `---\n${lines.join('\n')}\n---\n${entry.body ?? ''}`
}

async function folderPresent(ctx) {
  const result = await ctx.tools.call('fs.exists', { path: KNOWLEDGE_DIR })
  return result?.exists === true
}

async function readKnowledgeFile(ctx, id) {
  const result = await ctx.tools.call('fs.read', { path: `${KNOWLEDGE_DIR}/${id}.md`, full: true })
  if (!result || typeof result.content !== 'string') throw new Error(`Knowledge entry not found: ${id}`)
  return parseKnowledge(id, result.content)
}

async function listFullKnowledge(ctx) {
  if (!await folderPresent(ctx)) return { items: [], folderPresent: false }
  const result = await ctx.tools.call('fs.list', { path: KNOWLEDGE_DIR, max_entries: 1000 })
  const entries = Array.isArray(result?.entries) ? result.entries : []
  const items = []
  for (const entry of entries) {
    if (!entry || entry.type !== 'file' || typeof entry.path !== 'string') continue
    if (!entry.path.endsWith('.md')) continue
    const id = entry.path.split('/').pop().replace(/\.md$/, '')
    if (!KNOWLEDGE_ID_RE.test(id)) continue
    try {
      items.push(await readKnowledgeFile(ctx, id))
    } catch {
      // Skip unreadable/corrupt files.
    }
  }
  return { items, folderPresent: true }
}

export async function listKnowledge(ctx) {
  const result = await listFullKnowledge(ctx)
  return {
    ...result,
    items: result.items.map(({ body, ...summary }) => {
      void body
      return summary
    }),
  }
}

export async function getKnowledge(ctx, input) {
  return readKnowledgeFile(ctx, requireId(input))
}

export async function createKnowledge(ctx, input = {}) {
  if (!await folderPresent(ctx)) return { folderPresent: false }
  validateTitle(input)
  const timestamp = new Date().toISOString()
  const entry = {
    id: '',
    title: input.title,
    type: normalizeType(input.type),
    summary: normalizeSummary(input.summary),
    tags: Array.isArray(input.tags) ? input.tags : [],
    links: coerceLinks(input.links),
    extra: { ...coerceExtra(input.extra), ...entryExtra(input) },
    created: timestamp,
    updated: timestamp,
    body: typeof input.body === 'string' ? input.body : '',
  }

  const preferredId = input.id === undefined || input.id === null || input.id === ''
    ? newKnowledgeId(input.title)
    : requireValidId(String(input.id))

  for (let attempt = 1; attempt <= 100; attempt++) {
    entry.id = attempt === 1 ? preferredId : `${preferredId}-${attempt}`
    requireValidId(entry.id)
    const path = `${KNOWLEDGE_DIR}/${entry.id}.md`
    const exists = await ctx.tools.call('fs.exists', { path })
    if (exists?.exists === true) continue
    try {
      await ctx.tools.call('fs.create', { path, content: serializeKnowledge(entry) })
      void refreshKnowledgeIndex(ctx)
      return entry
    } catch (err) {
      if (attempt < 100 && String(err?.message ?? err).includes('already exists')) continue
      throw err
    }
  }
  throw new Error('Could not allocate a unique knowledge id')
}

export async function updateKnowledge(ctx, input = {}) {
  if (!await folderPresent(ctx)) return { folderPresent: false }
  const id = requireId(input)
  const existing = await readKnowledgeFile(ctx, id)
  const patch = { ...input }
  delete patch.id
  const patchExtra = { ...coerceExtra(patch.extra), ...entryExtra(patch) }
  for (const key of Object.keys(patchExtra)) delete patch[key]
  delete patch.extra
  const merged = {
    ...existing,
    ...patch,
    type: Object.hasOwn(patch, 'type') ? normalizeType(patch.type) : existing.type,
    summary: Object.hasOwn(patch, 'summary') ? normalizeSummary(patch.summary) : existing.summary,
    links: Object.hasOwn(patch, 'links') ? coerceLinks(patch.links) : existing.links,
    extra: { ...existing.extra, ...patchExtra },
    id: existing.id,
    created: existing.created,
  }
  validateTitle(merged)
  merged.updated = new Date().toISOString()
  await ctx.tools.call('fs.write', { path: `${KNOWLEDGE_DIR}/${id}.md`, content: serializeKnowledge(merged) })
  void refreshKnowledgeIndex(ctx)
  return merged
}

export async function deleteKnowledge(ctx, input = {}) {
  if (!await folderPresent(ctx)) return { folderPresent: false }
  const id = requireId(input)
  const path = `${KNOWLEDGE_DIR}/${id}.md`
  const exists = await ctx.tools.call('fs.exists', { path })
  if (exists?.exists === true) await ctx.tools.call('fs.delete', { path })
  void refreshKnowledgeIndex(ctx)
  return { ok: true }
}

function requireId(input) {
  if (!input || typeof input.id !== 'string' || input.id.length === 0) throw new Error('Missing required parameter: id')
  return requireValidId(input.id)
}

function validateTitle(input) {
  if (typeof input.title !== 'string' || input.title.trim() === '') throw new Error('title is required')
}

function titleOf(title) {
  return typeof title === 'string' && title.trim() ? title.trim() : '(untitled)'
}

function summaryOf(entry) {
  if (isSensitive(entry)) return '[sensitive record; read explicitly if needed]'
  if (entry.summary) return entry.summary
  const firstLine = String(entry.body || '').split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return firstLine ? firstLine.replace(/^#+\s+/, '').slice(0, SUMMARY_RECOMMENDED_CHARS) : ''
}

function compactEntry(entry) {
  return {
    id: entry.id,
    type: entry.type || 'note',
    title: titleOf(entry.title),
    summary: entry.summary || '',
    tags: entry.tags || [],
    sensitive: isSensitive(entry),
  }
}

export async function catalogKnowledge(ctx) {
  const { items } = await listKnowledge(ctx)
  void refreshKnowledgeIndex(ctx)
  return {
    entries: items.map(compactEntry),
  }
}

export async function neighborsKnowledge(ctx, input) {
  const id = requireId(input)
  const { items } = await listKnowledge(ctx)
  const byId = new Map(items.map(entry => [entry.id, entry]))
  const entry = byId.get(id)
  const outgoing = []
  const incoming = []

  if (entry) {
    for (const link of entry.links || []) {
      const target = byId.get(link.target)
      outgoing.push(target
        ? { rel: link.rel, id: target.id, type: target.type, title: target.title, summary: target.summary }
        : { rel: link.rel, id: link.target, missing: true })
    }
  }

  for (const other of items) {
    if (other.id === id) continue
    for (const link of other.links || []) {
      if (link.target === id) {
        incoming.push({ rel: link.rel, id: other.id, type: other.type, title: other.title, summary: other.summary })
      }
    }
  }

  return { id, outgoing, incoming }
}

export async function graphKnowledge(ctx) {
  const { items } = await listKnowledge(ctx)
  const ids = new Set(items.map(entry => entry.id))
  const edges = []
  for (const entry of items) {
    for (const link of entry.links || []) {
      edges.push({ source: entry.id, target: link.target, rel: link.rel, missing: !ids.has(link.target) })
    }
  }
  return {
    nodes: items.map(compactEntry),
    edges,
  }
}

export async function searchKnowledge(ctx, input = {}) {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) return { items: [], index: 'none' }

  const full = await listFullKnowledge(ctx)
  const indexResult = await refreshKnowledgeIndex(ctx, full.items)
  if (indexResult?.ok) {
    const indexed = await searchKnowledgeIndex(ctx, query, typeof input.limit === 'number' ? input.limit : 25)
    if (indexed.ok) return { items: indexed.items, index: 'sqlite' }
  }
  const q = query.toLowerCase()
  const matched = full.items.filter(entry =>
    entry.id.toLowerCase().includes(q) ||
    (entry.title || '').toLowerCase().includes(q) ||
    (entry.type || '').toLowerCase().includes(q) ||
    (entry.summary || '').toLowerCase().includes(q) ||
    (entry.tags || []).some(tag => tag.toLowerCase().includes(q)) ||
    (entry.body || '').toLowerCase().includes(q)
  )
  return {
    items: matched.map(({ body, ...summary }) => {
      void body
      return summary
    }),
    index: 'markdown',
  }
}

async function refreshKnowledgeIndex(ctx, knownItems) {
  try {
    const entries = knownItems || (await listFullKnowledge(ctx)).items
    return await rebuildKnowledgeIndex(ctx, entries)
  } catch {
    return { ok: false }
  }
}

export async function knowledgeAgentContext(ctx) {
  const { items } = await listKnowledge(ctx)
  if (items.length === 0) return { title: 'Knowledge', body: 'No knowledge entries yet.' }
  const lines = [`${items.length} entries. Use knowledge.catalog to choose entries, then knowledge.get for full bodies.\n`]
  for (const entry of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const tags = (entry.tags || []).length ? ` [${entry.tags.join(', ')}]` : ''
    const summary = summaryOf(entry)
    const summaryText = summary ? ` — ${summary}` : ''
    lines.push(`- ${entry.id} [${entry.type || 'note'}]: ${titleOf(entry.title)}${summaryText}${tags}`)
    if (lines.join('\n').length > AGENT_CONTEXT_MAX_CHARS) {
      lines.push(`... ${items.length - lines.length + 1} more entries omitted; call knowledge.catalog for the full catalog.`)
      break
    }
  }
  return { title: 'Knowledge', body: lines.join('\n') }
}

export const tools = {
  list: {
    name: 'knowledge.list',
    label: 'List knowledge',
    description: 'List knowledge entry summaries from knowledge/. Returns {items, folderPresent}; bodies are omitted.',
    inputSchema: objectSchema({}),
    audience: ['chat'],
    execute: listKnowledge,
  },
  catalog: {
    name: 'knowledge.catalog',
    label: 'Knowledge catalog',
    description: 'Returns all knowledge entries as a compact catalog: id, type, title, optional short summary, tags. No body. Use this first to find entries before reading them with knowledge.get. No SQL is required.',
    inputSchema: objectSchema({}),
    audience: ['chat'],
    execute: catalogKnowledge,
  },
  get: {
    name: 'knowledge.get',
    label: 'Get knowledge',
    description: 'Get one full knowledge entry including its body.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']),
    audience: ['chat'],
    execute: getKnowledge,
  },
  create: {
    name: 'knowledge.create',
    label: 'Create knowledge',
    description: 'Create a new knowledge markdown file in knowledge/.',
    inputSchema: objectSchema(fieldsSchema, ['title']),
    audience: ['chat'],
    execute: createKnowledge,
  },
  update: {
    name: 'knowledge.update',
    label: 'Update knowledge',
    description: 'Update fields on an existing knowledge markdown file.',
    inputSchema: objectSchema({ id: { type: 'string' }, ...fieldsSchema }, ['id']),
    audience: ['chat'],
    execute: updateKnowledge,
  },
  neighbors: {
    name: 'knowledge.neighbors',
    label: 'Knowledge neighbors',
    description: 'Returns entries connected to a given entry via frontmatter links, in both directions. Use after knowledge.catalog to explore the graph. No SQL is required.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']),
    audience: ['chat'],
    execute: neighborsKnowledge,
  },
  graph: {
    name: 'knowledge.graph',
    label: 'Knowledge graph',
    description: 'Returns knowledge graph nodes and directed edges from links frontmatter. No bodies. This is the graph API; callers do not query SQLite directly.',
    inputSchema: objectSchema({}),
    audience: ['chat'],
    execute: graphKnowledge,
  },
  search: {
    name: 'knowledge.search',
    label: 'Search knowledge',
    description: 'Plain-text search over title, id, type, summary, tags, and body. Returns matching entries without bodies. The SQLite FTS index is internal; pass normal search words, not SQL.',
    inputSchema: objectSchema({
      query: { type: 'string', description: 'Plain-text search terms. Do not pass SQL.' },
      limit: { type: 'number', description: 'Optional maximum number of results.' },
    }, ['query']),
    audience: ['chat'],
    execute: searchKnowledge,
  },
  delete: {
    name: 'knowledge.delete',
    label: 'Delete knowledge',
    description: 'Delete a knowledge markdown file from knowledge/.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']),
    audience: ['chat'],
    execute: deleteKnowledge,
  },
}

export const agentContext = knowledgeAgentContext
