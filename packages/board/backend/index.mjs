export const STATUSES = ['backlog', 'plan', 'in-progress', 'review', 'done']
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const LABEL_COLORS = ['gray', 'green', 'yellow', 'blue', 'purple', 'red', 'orange']

const ISSUE_DIR = 'issues'
const ISSUE_ID_RE = /^issue-\d+-[a-z0-9]{4}$/
const DUE_SOON_DAYS = 7

const deliverableSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { path: { type: 'string' }, label: { type: 'string' } },
    required: ['path'],
  },
}

const issueFieldsSchema = {
  title: { type: 'string' },
  status: { type: 'string', enum: STATUSES },
  priority: { type: 'string', enum: PRIORITIES },
  dueDate: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' } },
  project: { type: 'string' },
  assignee: { type: 'string' },
  labels: {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, color: { type: 'string' } },
      required: ['name'],
    },
  },
  waitingFor: { type: 'string' },
  snoozeUntil: { type: 'string' },
  deliverables: deliverableSchema,
  body: { type: 'string' },
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required }
}

function rand4(rand) {
  const n = Math.floor(rand() * 0x10000) & 0xffff
  return n.toString(16).padStart(4, '0')
}

export function newIssueId(now = Date.now, rand = Math.random) {
  return `issue-${Math.floor(now() / 1000)}-${rand4(rand)}`
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
  let current = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('- ')) {
      if (current) out.push(current)
      const rest = line.slice(2).trim()
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(rest)
      if (kv) {
        current = { [kv[1]]: parseScalar(kv[2].trim()) }
      } else {
        current = parseScalar(rest)
        out.push(current)
        current = null
      }
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (kv && current && typeof current === 'object' && !Array.isArray(current)) {
      current[kv[1]] = parseScalar(kv[2].trim())
    }
  }

  if (current) out.push(current)
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
  return trimmed
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''))
}

function coerceStatus(value) {
  return STATUSES.includes(value) ? value : 'backlog'
}

function coercePriority(value) {
  return PRIORITIES.includes(value) ? value : 'normal'
}

function coerceTags(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    return value.split(',').map(t => t.trim()).filter(Boolean)
  }
  return []
}

function coerceLabels(value, tags) {
  if (Array.isArray(value) && value.length > 0 && value.every(v => v && typeof v === 'object' && typeof v.name === 'string')) {
    return value.map(v => ({
      name: v.name,
      color: LABEL_COLORS.includes(v.color) ? v.color : 'gray',
    }))
  }
  if (Array.isArray(tags) && tags.length > 0) {
    return tags.map(t => ({ name: String(t), color: 'gray' }))
  }
  return []
}

function coerceDeliverables(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => item && typeof item === 'object' && typeof item.path === 'string' && item.path.length > 0)
    .map(item => {
      const out = { path: item.path }
      if (typeof item.label === 'string') out.label = item.label
      return out
    })
}

export function parseIssue(id, raw) {
  const { fm, body } = splitFrontmatter(String(raw ?? ''))
  let meta = {}
  try {
    meta = fm === null ? {} : parseFrontmatter(fm)
  } catch {
    meta = {}
  }

  const labels = coerceLabels(meta.labels, coerceTags(meta.tags))
  const issue = {
    id,
    title: typeof meta.title === 'string' ? meta.title : '',
    status: coerceStatus(meta.status),
    priority: coercePriority(meta.priority),
    tags: labels.map(l => l.name),
    project: typeof meta.project === 'string' ? meta.project : '',
    assignee: typeof meta.assignee === 'string' ? meta.assignee : '',
    labels,
    deliverables: coerceDeliverables(meta.deliverables),
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    body,
  }
  if (typeof meta.dueDate === 'string') issue.dueDate = meta.dueDate
  if (typeof meta.waiting_for === 'string') issue.waitingFor = meta.waiting_for
  if (typeof meta.snooze_until === 'string') issue.snoozeUntil = meta.snooze_until
  return issue
}

export function serializeIssue(issue) {
  const lines = [
    `title: ${yamlScalar(issue.title)}`,
    `status: ${yamlScalar(issue.status)}`,
    `priority: ${yamlScalar(issue.priority)}`,
  ]
  if (issue.dueDate !== undefined) lines.push(`dueDate: ${yamlScalar(issue.dueDate)}`)
  if (issue.project) lines.push(`project: ${yamlScalar(issue.project)}`)
  if (issue.assignee) lines.push(`assignee: ${yamlScalar(issue.assignee)}`)
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    lines.push('labels:')
    for (const label of issue.labels) {
      lines.push(`  - name: ${yamlScalar(label.name)}`)
      lines.push(`    color: ${yamlScalar(label.color ?? 'gray')}`)
    }
    lines.push('tags:')
    for (const label of issue.labels) lines.push(`  - ${yamlScalar(label.name)}`)
  } else if (Array.isArray(issue.tags) && issue.tags.length > 0) {
    lines.push('tags:')
    for (const tag of issue.tags) lines.push(`  - ${yamlScalar(tag)}`)
  }
  if (issue.waitingFor !== undefined) lines.push(`waiting_for: ${yamlScalar(issue.waitingFor)}`)
  if (issue.snoozeUntil !== undefined) lines.push(`snooze_until: ${yamlScalar(issue.snoozeUntil)}`)
  if (Array.isArray(issue.deliverables) && issue.deliverables.length > 0) {
    lines.push('deliverables:')
    for (const deliverable of issue.deliverables) {
      lines.push(`  - path: ${yamlScalar(deliverable.path)}`)
      if (deliverable.label !== undefined) lines.push(`    label: ${yamlScalar(deliverable.label)}`)
    }
  }
  lines.push(`created: ${yamlScalar(issue.created)}`)
  lines.push(`updated: ${yamlScalar(issue.updated)}`)
  return `---\n${lines.join('\n')}\n---\n${issue.body ?? ''}`
}

export function validateIssue(partial) {
  const errors = []
  if (typeof partial.title !== 'string' || partial.title.trim() === '') errors.push('title is required')
  if (partial.status !== undefined && !STATUSES.includes(partial.status)) errors.push('invalid status')
  if (partial.priority !== undefined && !PRIORITIES.includes(partial.priority)) errors.push('invalid priority')
  if (partial.labels !== undefined) {
    for (const l of partial.labels ?? []) {
      if (!l || typeof l.name !== 'string' || l.name.trim() === '') {
        errors.push('each label needs a non-empty name')
        break
      }
      if (l.color !== undefined && !LABEL_COLORS.includes(l.color)) {
        errors.push(`invalid label color: ${l.color}`)
        break
      }
    }
  }
  if (partial.deliverables !== undefined) {
    for (const d of partial.deliverables ?? []) {
      if (!d || typeof d.path !== 'string' || d.path === '') {
        errors.push('each deliverable needs a path')
        break
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

async function folderPresent(ctx) {
  const result = await ctx.tools.call('fs.exists', { path: ISSUE_DIR })
  return result?.exists === true
}

async function readIssueFile(ctx, id) {
  const path = `${ISSUE_DIR}/${id}.md`
  const result = await ctx.tools.call('fs.read', { path, full: true })
  if (!result || typeof result.content !== 'string') throw new Error(`Issue not found: ${id}`)
  return parseIssue(id, result.content)
}

export async function listIssues(ctx) {
  if (!await folderPresent(ctx)) return { items: [], folderPresent: false }
  const result = await ctx.tools.call('fs.list', { path: ISSUE_DIR, max_entries: 1000 })
  const entries = Array.isArray(result?.entries) ? result.entries : []
  const items = []
  for (const entry of entries) {
    if (!entry || entry.type !== 'file' || typeof entry.path !== 'string') continue
    if (!entry.path.endsWith('.md')) continue
    const id = entry.path.split('/').pop().replace(/\.md$/, '')
    try {
      const issue = await readIssueFile(ctx, id)
      const { body, ...summary } = issue
      void body
      items.push(summary)
    } catch {
      // Skip unreadable/corrupt files.
    }
  }
  return { items, folderPresent: true }
}

export async function getIssue(ctx, input) {
  const id = requireId(input)
  return readIssueFile(ctx, id)
}

export async function createIssue(ctx, input = {}) {
  if (!await folderPresent(ctx)) return { folderPresent: false }
  const validation = validateIssue(input)
  if (!validation.ok) throw new Error(validation.errors.join('; '))

  const timestamp = new Date().toISOString()
  const labels = Array.isArray(input.labels)
    ? coerceLabels(input.labels, [])
    : coerceLabels(null, Array.isArray(input.tags) ? input.tags : [])
  const issue = {
    id: '',
    title: input.title,
    status: input.status ?? 'backlog',
    priority: input.priority ?? 'normal',
    tags: labels.map(l => l.name),
    project: typeof input.project === 'string' ? input.project : '',
    assignee: typeof input.assignee === 'string' ? input.assignee : '',
    labels,
    deliverables: Array.isArray(input.deliverables) ? input.deliverables : [],
    created: timestamp,
    updated: timestamp,
    body: typeof input.body === 'string' ? input.body : '',
  }
  if (input.dueDate !== undefined) issue.dueDate = input.dueDate
  if (input.waitingFor !== undefined) issue.waitingFor = input.waitingFor
  if (input.snoozeUntil !== undefined) issue.snoozeUntil = input.snoozeUntil

  for (let attempt = 0; attempt < 5; attempt++) {
    issue.id = newIssueId()
    const path = `${ISSUE_DIR}/${issue.id}.md`
    const exists = await ctx.tools.call('fs.exists', { path })
    if (exists?.exists === true) continue
    try {
      await ctx.tools.call('fs.create', { path, content: serializeIssue(issue) })
      return issue
    } catch (err) {
      if (attempt < 4 && String(err?.message ?? err).includes('already exists')) continue
      throw err
    }
  }
  throw new Error('Could not allocate a unique issue id')
}

export async function updateIssue(ctx, input = {}) {
  if (!await folderPresent(ctx)) return { folderPresent: false }
  const id = requireId(input)
  const existing = await readIssueFile(ctx, id)
  const patch = { ...input }
  delete patch.id
  if (Array.isArray(patch.labels)) {
    patch.labels = coerceLabels(patch.labels, [])
    patch.tags = patch.labels.map(l => l.name)
  } else if (Array.isArray(patch.tags) && !Array.isArray(patch.labels)) {
    patch.labels = coerceLabels(null, patch.tags)
    patch.tags = patch.labels.map(l => l.name)
  }
  const merged = { ...existing, ...patch, id: existing.id, created: existing.created }
  const validation = validateIssue(merged)
  if (!validation.ok) throw new Error(validation.errors.join('; '))
  merged.updated = new Date().toISOString()
  await ctx.tools.call('fs.write', { path: `${ISSUE_DIR}/${id}.md`, content: serializeIssue(merged) })
  return merged
}

export async function deleteIssue(ctx, input = {}) {
  if (!await folderPresent(ctx)) return { folderPresent: false }
  const id = requireId(input)
  const path = `${ISSUE_DIR}/${id}.md`
  const exists = await ctx.tools.call('fs.exists', { path })
  if (exists?.exists === true) await ctx.tools.call('fs.delete', { path })
  return { ok: true }
}

function requireId(input) {
  if (!input || typeof input.id !== 'string' || input.id.length === 0) throw new Error('Missing required parameter: id')
  if (!ISSUE_ID_RE.test(input.id)) throw new Error(`Invalid issue id: ${input.id}`)
  return input.id
}

function titleOf(title) {
  return typeof title === 'string' && title.trim() ? title.trim() : '(untitled)'
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

export async function issueAgentContext(ctx) {
  const { items } = await listIssues(ctx)
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id))
  if (sorted.length === 0) return { title: 'Issues', body: 'No issues yet.' }

  const byStatus = new Map()
  for (const issue of sorted) byStatus.set(issue.status, (byStatus.get(issue.status) ?? 0) + 1)
  const counts = STATUSES
    .filter(status => byStatus.has(status))
    .map(status => `${status} ${byStatus.get(status)}`)

  const now = Date.now()
  const today = dayKey(now)
  const horizon = dayKey(now + DUE_SOON_DAYS * 86400000)
  const lines = [`Counts: ${counts.join(', ')}`]
  appendIssueList(lines, 'In progress', sorted.filter(i => i.status === 'in-progress'), i => {
    const parts = [titleOf(i.title)]
    if (i.project) parts.push(`[${i.project}]`)
    if (i.assignee) parts.push(`@${i.assignee}`)
    return parts.join(' ')
  })
  appendIssueList(lines, 'Waiting on', sorted.filter(i => i.waitingFor), i => `${titleOf(i.title)} (waiting for ${i.waitingFor})`)
  appendIssueList(lines, 'Snoozed', sorted.filter(i => i.snoozeUntil), i => `${titleOf(i.title)} (until ${i.snoozeUntil})`)
  appendIssueList(lines, 'Overdue', sorted.filter(i => i.dueDate && i.dueDate < today), i => `${titleOf(i.title)} (due ${i.dueDate})`)
  appendIssueList(lines, 'Due soon', sorted.filter(i => i.dueDate && i.dueDate >= today && i.dueDate <= horizon), i => `${titleOf(i.title)} (due ${i.dueDate})`)
  return { title: 'Issues', body: lines.join('\n') }
}

function appendIssueList(lines, label, items, format) {
  if (items.length === 0) return
  lines.push('')
  lines.push(`${label}:`)
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`- ${format(item)}`)
  }
}

export const tools = {
  list: {
    name: 'issues.list',
    label: 'List issues',
    description: 'List issue summaries from issues/. Returns {items, folderPresent}; item bodies are omitted.',
    inputSchema: objectSchema({}),
    audience: ['chat'],
    execute: listIssues,
  },
  get: {
    name: 'issues.get',
    label: 'Get issue',
    description: 'Get one full issue including its body.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']),
    audience: ['chat'],
    execute: getIssue,
  },
  create: {
    name: 'issues.create',
    label: 'Create issue',
    description: 'Create a new issue markdown file in issues/.',
    inputSchema: objectSchema(issueFieldsSchema, ['title']),
    audience: ['chat'],
    execute: createIssue,
  },
  update: {
    name: 'issues.update',
    label: 'Update issue',
    description: 'Update fields on an existing issue markdown file.',
    inputSchema: objectSchema({ id: { type: 'string' }, ...issueFieldsSchema }, ['id']),
    audience: ['chat'],
    execute: updateIssue,
  },
  delete: {
    name: 'issues.delete',
    label: 'Delete issue',
    description: 'Delete an issue markdown file from issues/.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id']),
    audience: ['chat'],
    execute: deleteIssue,
  },
}

export const agentContext = issueAgentContext
