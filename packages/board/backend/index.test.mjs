import { describe, expect, it } from 'vitest'
import {
  LABEL_COLORS,
  PRIORITIES,
  STATUSES,
  createIssue,
  deleteIssue,
  getIssue,
  issueAgentContext,
  listIssues,
  parseIssue,
  serializeIssue,
  tools,
  updateIssue,
  validateIssue,
} from './index.mjs'

function createCtx(files = {}) {
  const store = new Map(Object.entries(files))
  const calls = []
  return {
    calls,
    files: store,
    tools: {
      async call(name, params = {}) {
        calls.push([name, params])
        switch (name) {
          case 'fs.exists':
            return { exists: params.path === 'issues' ? hasIssuesFolder(store) : store.has(params.path) }
          case 'fs.list':
            if (!hasIssuesFolder(store)) throw new Error('Path does not exist: issues')
            return {
              entries: [...store.keys()]
                .filter(path => path.startsWith('issues/'))
                .map(path => ({ name: path.split('/').pop(), path, type: 'file' })),
              truncated: false,
            }
          case 'fs.read':
            if (!store.has(params.path)) throw new Error(`File not found: ${params.path}`)
            return { content: store.get(params.path), truncated: false }
          case 'fs.create':
            if (store.has(params.path)) throw new Error(`File already exists: ${params.path}`)
            store.set(params.path, params.content)
            return { created: params.path }
          case 'fs.write':
            store.set(params.path, params.content)
            return { written: params.path }
          case 'fs.delete':
            store.delete(params.path)
            return { deleted: params.path }
          default:
            throw new Error(`Unexpected tool call: ${name}`)
        }
      },
    },
  }
}

function hasIssuesFolder(store) {
  return [...store.keys()].some(path => path.startsWith('issues/'))
}

describe('board package issue model', () => {
  it('exports the authoritative issue enums', () => {
    expect(STATUSES).toEqual(['backlog', 'plan', 'in-progress', 'review', 'done'])
    expect(PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent'])
    expect(LABEL_COLORS).toEqual(['gray', 'green', 'yellow', 'blue', 'purple', 'red', 'orange'])
  })

  it('round-trips a full issue and keeps literal disk keys', () => {
    const issue = {
      id: 'issue-1700000000-ab12',
      title: 'Ship the thing',
      status: 'in-progress',
      priority: 'high',
      dueDate: '2026-06-01',
      tags: ['ops', 'q2'],
      project: 'alpha',
      assignee: 'alice',
      labels: [
        { name: 'ops', color: 'blue' },
        { name: 'q2', color: 'green' },
      ],
      waitingFor: 'design review',
      snoozeUntil: '2026-05-30',
      deliverables: [
        { path: 'docs/spec.md', label: 'Spec' },
        { path: 'src/feature.ts' },
      ],
      created: '2026-05-01T10:00:00.000Z',
      updated: '2026-05-02T10:00:00.000Z',
      body: 'Body text here.\n\nMore detail.',
    }
    const serialized = serializeIssue(issue)
    expect(serialized).toContain('waiting_for:')
    expect(serialized).toContain('snooze_until:')
    expect(serialized).toContain('dueDate:')
    expect(serialized).toContain('project:')
    expect(serialized).toContain('assignee:')
    expect(serialized).toContain('labels:')
    expect(serialized).not.toContain('waitingFor:')
    expect(serialized).not.toContain('snoozeUntil:')
    expect(parseIssue(issue.id, serialized)).toEqual(issue)
  })

  it('tolerates missing and broken frontmatter', () => {
    expect(parseIssue('issue-1700000000-ab12', 'just body').body).toBe('just body')
    expect(parseIssue('issue-1700000000-ab12', '---\ntitle: Broken').body).toContain('title: Broken')
    expect(parseIssue('issue-1700000000-ab12', '---\ntitle: X\nstatus: nonsense\npriority: nope\n---\nb')).toMatchObject({
      status: 'backlog',
      priority: 'normal',
    })
  })

  it('validates required and enum fields', () => {
    expect(validateIssue({ title: 'Valid', status: 'backlog', priority: 'normal' }).ok).toBe(true)
    expect(validateIssue({ title: '', status: 'backlog', priority: 'normal' }).ok).toBe(false)
    expect(validateIssue({ title: 'X', status: 'nope', priority: 'normal' }).ok).toBe(false)
    expect(validateIssue({ title: 'X', status: 'backlog', priority: 'urgent', deliverables: [{ label: 'no path' }] }).ok).toBe(false)
  })

  it('validates label names and colors', () => {
    expect(validateIssue({ title: 'X', labels: [{ name: 'bug', color: 'red' }] }).ok).toBe(true)
    expect(validateIssue({ title: 'X', labels: [{ name: 'bug' }] }).ok).toBe(true)
    expect(validateIssue({ title: 'X', labels: [{ name: '' }] }).ok).toBe(false)
    expect(validateIssue({ title: 'X', labels: [{ name: 'bug', color: 'neon' }] }).ok).toBe(false)
  })

  it('migrates tags to labels when only tags are present in frontmatter', () => {
    const raw = '---\ntitle: "Legacy"\nstatus: "backlog"\npriority: "normal"\ntags:\n  - "bug"\n  - "infra"\ncreated: "2026-01-01T00:00:00.000Z"\nupdated: "2026-01-01T00:00:00.000Z"\n---\nbody'
    const issue = parseIssue('issue-1700000000-ab12', raw)
    expect(issue.labels).toEqual([
      { name: 'bug', color: 'gray' },
      { name: 'infra', color: 'gray' },
    ])
    expect(issue.tags).toEqual(['bug', 'infra'])
  })

  it('uses labels directly when both labels and tags are present', () => {
    const raw = '---\ntitle: "Modern"\nstatus: "backlog"\npriority: "normal"\nlabels:\n  - name: "bug"\n    color: "red"\ntags:\n  - "bug"\ncreated: "2026-01-01T00:00:00.000Z"\nupdated: "2026-01-01T00:00:00.000Z"\n---\n'
    const issue = parseIssue('issue-1700000000-ab12', raw)
    expect(issue.labels).toEqual([{ name: 'bug', color: 'red' }])
    expect(issue.tags).toEqual(['bug'])
  })

  it('defaults project, assignee, and labels to empty values', () => {
    const raw = '---\ntitle: "Bare"\nstatus: "backlog"\npriority: "normal"\ncreated: "2026-01-01T00:00:00.000Z"\nupdated: "2026-01-01T00:00:00.000Z"\n---\n'
    const issue = parseIssue('issue-1700000000-ab12', raw)
    expect(issue.project).toBe('')
    expect(issue.assignee).toBe('')
    expect(issue.labels).toEqual([])
  })
})

describe('board package issue tools', () => {
  it('declares named public tool descriptors', () => {
    expect(Object.values(tools).map(tool => tool.name).sort()).toEqual([
      'issues.create',
      'issues.delete',
      'issues.get',
      'issues.list',
      'issues.update',
    ])
    for (const tool of Object.values(tools)) {
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('list returns folderPresent:false without creating issues/', async () => {
    const ctx = createCtx()
    await expect(listIssues(ctx)).resolves.toEqual({ items: [], folderPresent: false })
    expect(ctx.files.size).toBe(0)
  })

  it('create reports folderPresent:false when app.enable has not created the data folder', async () => {
    const ctx = createCtx()
    await expect(createIssue(ctx, { title: 'X' })).resolves.toEqual({ folderPresent: false })
  })

  it('create/get/list/update/delete round-trips through fs.* tools', async () => {
    const ctx = createCtx({ 'issues/.keep': '' })
    const created = await createIssue(ctx, {
      title: 'First',
      status: 'backlog',
      priority: 'normal',
      body: 'hello',
      project: 'acme',
      assignee: 'bob',
      labels: [{ name: 'bug', color: 'red' }, { name: 'urgent', color: 'orange' }],
    })
    expect(created.id).toMatch(/^issue-\d+-[a-z0-9]{4}$/)
    expect(ctx.files.has(`issues/${created.id}.md`)).toBe(true)
    expect(created.project).toBe('acme')
    expect(created.assignee).toBe('bob')
    expect(created.labels).toEqual([{ name: 'bug', color: 'red' }, { name: 'urgent', color: 'orange' }])
    expect(created.tags).toEqual(['bug', 'urgent'])

    const got = await getIssue(ctx, { id: created.id })
    expect(got.title).toBe('First')
    expect(got.body).toBe('hello')
    expect(got.project).toBe('acme')
    expect(got.assignee).toBe('bob')
    expect(got.labels).toEqual([{ name: 'bug', color: 'red' }, { name: 'urgent', color: 'orange' }])

    await createIssue(ctx, { title: 'Second', status: 'plan', priority: 'high' })
    const listed = await listIssues(ctx)
    expect(listed.folderPresent).toBe(true)
    expect(listed.items.length).toBe(2)
    expect(listed.items.some(item => item.body !== undefined)).toBe(false)

    const updated = await updateIssue(ctx, { id: created.id, status: 'done' })
    expect(updated.status).toBe('done')
    expect(updated.created).toBe(created.created)
    expect(updated.project).toBe('acme')

    const deleted = await deleteIssue(ctx, { id: created.id })
    expect(deleted).toEqual({ ok: true })
    expect(ctx.files.has(`issues/${created.id}.md`)).toBe(false)
  })

  it('agentContext summarizes issue state', async () => {
    const one = serializeIssue({
      id: 'issue-1700000000-ab12',
      title: 'Implement migration',
      status: 'in-progress',
      priority: 'high',
      tags: [],
      project: '',
      assignee: '',
      labels: [],
      waitingFor: 'review',
      deliverables: [],
      created: '2026-06-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
      body: '',
    })
    const ctx = createCtx({ 'issues/issue-1700000000-ab12.md': one })
    const section = await issueAgentContext(ctx)
    expect(section.title).toBe('Issues')
    expect(section.body).toContain('Counts: in-progress 1')
    expect(section.body).toContain('Waiting on:')
  })
})
