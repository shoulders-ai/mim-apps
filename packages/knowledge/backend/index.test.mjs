import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  catalogKnowledge,
  createKnowledge,
  deleteKnowledge,
  getKnowledge,
  graphKnowledge,
  knowledgeAgentContext,
  listKnowledge,
  neighborsKnowledge,
  parseKnowledge,
  searchKnowledge,
  serializeKnowledge,
  tools,
  updateKnowledge,
} from './index.mjs'
import { rebuildKnowledgeIndex, searchKnowledgeIndex } from './indexer.mjs'

function createCtx(files = {}, options = {}) {
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
            return { exists: params.path === 'knowledge' ? hasKnowledgeFolder(store) : store.has(params.path) }
          case 'workspace.info':
            return options.workspacePath
              ? { open: true, path: options.workspacePath, name: 'test', initialized: true, missing: [] }
              : { open: false }
          case 'fs.list':
            if (!hasKnowledgeFolder(store)) throw new Error('Path does not exist: knowledge')
            return {
              entries: [...store.keys()]
                .filter(path => path.startsWith('knowledge/'))
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

function hasKnowledgeFolder(store) {
  return [...store.keys()].some(path => path.startsWith('knowledge/'))
}

describe('knowledge package model', () => {
  it('round-trips a full entry', () => {
    const entry = {
      id: 'deploy-notes',
      title: 'How deploys work',
      type: 'project',
      summary: 'Deployment procedure for production releases.',
      tags: ['ops', 'deploy'],
      links: [{ rel: 'references', target: 'release-checklist' }],
      extra: {
        status: 'active',
        rate: '2000/day GBP',
        sensitive: false,
      },
      created: '2026-05-01T10:00:00.000Z',
      updated: '2026-05-02T10:00:00.000Z',
      body: 'Steps:\n\n1. Build\n2. Ship',
    }
    expect(parseKnowledge(entry.id, serializeKnowledge(entry))).toEqual(entry)
  })

  it('tolerates missing frontmatter and csv/list tags', () => {
    expect(parseKnowledge('just-body', 'just body')).toMatchObject({ type: 'note', body: 'just body' })
    expect(parseKnowledge('tagged', '---\ntitle: T\ntags: ops, deploy, q2\n---\nb').tags)
      .toEqual(['ops', 'deploy', 'q2'])
    expect(parseKnowledge('tag-list', '---\ntitle: T\ntags:\n  - ops\n  - deploy\n---\nb').tags)
      .toEqual(['ops', 'deploy'])
  })

  it('parses links and keeps unknown frontmatter in extra', () => {
    const entry = parseKnowledge('nicole-ferko', `---
title: Nicole Ferko
type: person
summary: EVERSANA contact.
tags:
  - eversana
links:
  - "works_at eversana"
  - "contact_for eversana-engagement"
email: nicole@example.com
sensitive: false
---
Body`)

    expect(entry.links).toEqual([
      { rel: 'works_at', target: 'eversana' },
      { rel: 'contact_for', target: 'eversana-engagement' },
    ])
    expect(entry.extra).toEqual({ email: 'nicole@example.com', sensitive: false })
  })
})

describe('knowledge package tools', () => {
  it('declares named public tool descriptors', () => {
    expect(Object.values(tools).map(tool => tool.name).sort()).toEqual([
      'knowledge.catalog',
      'knowledge.create',
      'knowledge.delete',
      'knowledge.get',
      'knowledge.graph',
      'knowledge.list',
      'knowledge.neighbors',
      'knowledge.search',
      'knowledge.update',
    ])
    for (const tool of Object.values(tools)) {
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('list returns folderPresent:false without creating knowledge/', async () => {
    const ctx = createCtx()
    await expect(listKnowledge(ctx)).resolves.toEqual({ items: [], folderPresent: false })
    expect(ctx.files.size).toBe(0)
  })

  it('create reports folderPresent:false when app.enable has not created the data folder', async () => {
    const ctx = createCtx()
    await expect(createKnowledge(ctx, { title: 'X' })).resolves.toEqual({ folderPresent: false })
  })

  it('create/get/list/update/delete round-trips through fs.* tools', async () => {
    const ctx = createCtx({ 'knowledge/.keep': '' })
    const created = await createKnowledge(ctx, {
      title: 'Doc',
      type: 'project',
      summary: '',
      tags: ['x'],
      links: ['references fde-three-views'],
      body: 'hi',
      extra: { status: 'active' },
    })
    expect(created.id).toBe('doc')
    expect(ctx.files.has(`knowledge/${created.id}.md`)).toBe(true)

    const got = await getKnowledge(ctx, { id: created.id })
    expect(got.title).toBe('Doc')
    expect(got.type).toBe('project')
    expect(got.summary).toBe('')
    expect(got.links).toEqual([{ rel: 'references', target: 'fde-three-views' }])
    expect(got.extra.status).toBe('active')
    expect(got.body).toBe('hi')

    const listed = await listKnowledge(ctx)
    expect(listed.folderPresent).toBe(true)
    expect(listed.items.length).toBe(1)
    expect(listed.items[0].body).toBeUndefined()

    const updated = await updateKnowledge(ctx, { id: created.id, title: 'Doc 2' })
    expect(updated.title).toBe('Doc 2')
    expect(updated.created).toBe(created.created)

    const deleted = await deleteKnowledge(ctx, { id: created.id })
    expect(deleted).toEqual({ ok: true })
    expect(ctx.files.has(`knowledge/${created.id}.md`)).toBe(false)
  })

  it('allocates readable slug ids and suffixes collisions', async () => {
    const ctx = createCtx({ 'knowledge/.keep': '' })
    const first = await createKnowledge(ctx, { title: 'FDE: Three Views!' })
    const second = await createKnowledge(ctx, { title: 'FDE Three Views' })

    expect(first.id).toBe('fde-three-views')
    expect(second.id).toBe('fde-three-views-2')
  })

  it('honors explicit slug ids on create', async () => {
    const ctx = createCtx({ 'knowledge/.keep': '' })
    const created = await createKnowledge(ctx, { id: 'nicole-ferko', title: 'Nicole Ferko' })
    expect(created.id).toBe('nicole-ferko')
    await expect(createKnowledge(ctx, { id: 'Nicole Ferko', title: 'Bad' })).rejects.toThrow(/Invalid knowledge id/)
  })

  it('rejects only excessively long summaries', async () => {
    const ctx = createCtx({ 'knowledge/.keep': '' })
    await expect(createKnowledge(ctx, { title: 'Short', summary: 'x'.repeat(321) })).resolves.toMatchObject({ summary: 'x'.repeat(321) })
    await expect(createKnowledge(ctx, { title: 'Long', summary: 'x'.repeat(1001) })).rejects.toThrow(/summary/i)
  })

  it('catalog and neighbors expose graph retrieval without bodies', async () => {
    const eversana = serializeKnowledge({
      id: 'eversana',
      title: 'EVERSANA',
      type: 'org',
      summary: 'Global HEOR company.',
      tags: ['heor'],
      links: [],
      extra: {},
      created: '2026-06-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
      body: 'Body should not leak into catalog.',
    })
    const project = serializeKnowledge({
      id: 'eversana-engagement',
      title: 'EVERSANA Engagement',
      type: 'project',
      summary: 'AI advisory for HEOR team.',
      tags: ['fde', 'client'],
      links: [{ rel: 'engagement_for', target: 'eversana' }],
      extra: {},
      created: '2026-06-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
      body: '',
    })
    const ctx = createCtx({
      'knowledge/eversana.md': eversana,
      'knowledge/eversana-engagement.md': project,
    })

    await expect(catalogKnowledge(ctx)).resolves.toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ id: 'eversana', type: 'org', title: 'EVERSANA', summary: 'Global HEOR company.' }),
      ]),
    })
    const catalog = await catalogKnowledge(ctx)
    expect(catalog.entries[0]).not.toHaveProperty('body')

    const neighbors = await neighborsKnowledge(ctx, { id: 'eversana' })
    expect(neighbors.incoming).toEqual([
      expect.objectContaining({ rel: 'engagement_for', id: 'eversana-engagement', type: 'project' }),
    ])

    const graph = await graphKnowledge(ctx)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toEqual([
      { source: 'eversana-engagement', target: 'eversana', rel: 'engagement_for', missing: false },
    ])
  })

  it('agentContext includes typed catalog details but redacts sensitive summaries', async () => {
    const entry = serializeKnowledge({
      id: 'deploy-notes',
      title: 'Deploy notes',
      type: 'note',
      summary: 'How production deploys work.',
      tags: ['ops'],
      links: [],
      extra: {},
      created: '2026-06-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
      body: '',
    })
    const sensitive = serializeKnowledge({
      id: 'personal-bank-account',
      title: 'Personal Bank Account',
      type: 'record',
      summary: 'Account number DE00 SECRET.',
      tags: ['banking'],
      links: [],
      extra: { sensitive: true },
      created: '2026-06-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
      body: 'DE00 SECRET',
    })
    const ctx = createCtx({
      'knowledge/deploy-notes.md': entry,
      'knowledge/personal-bank-account.md': sensitive,
    })
    const section = await knowledgeAgentContext(ctx)
    expect(section.title).toBe('Knowledge')
    expect(section.body).toContain('2 entries.')
    expect(section.body).toContain('- deploy-notes [note]: Deploy notes — How production deploys work. [ops]')
    expect(section.body).toContain('- personal-bank-account [record]: Personal Bank Account — [sensitive record; read explicitly if needed] [banking]')
    expect(section.body).not.toContain('DE00 SECRET')
  })

  it('search falls back to markdown entries and omits bodies', async () => {
    const entry = serializeKnowledge({
      id: 'fde-three-views',
      title: 'FDE Three Views',
      type: 'note',
      summary: 'Map Loop Stack framework.',
      tags: ['fde'],
      links: [],
      extra: {},
      created: '2026-06-01T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
      body: 'Substrate topology boundaries.',
    })
    const ctx = createCtx({ 'knowledge/fde-three-views.md': entry })
    const result = await searchKnowledge(ctx, { query: 'topology' })
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'fde-three-views', summary: 'Map Loop Stack framework.' }),
    ])
    expect(result.items[0]).not.toHaveProperty('body')
  })

  it('rebuilds a disposable SQLite index under .mim', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'mim-knowledge-'))
    try {
      mkdirSync(join(workspacePath, '.mim'), { recursive: true })
      const ctx = createCtx({}, { workspacePath })
      const result = await rebuildKnowledgeIndex(ctx, [
        {
          id: 'fde-three-views',
          title: 'FDE Three Views',
          type: 'note',
          summary: 'Map Loop Stack framework.',
          tags: ['fde', 'framework'],
          links: [{ rel: 'references', target: 'fde-pitch-notes' }],
          extra: {},
          created: '2026-06-01T00:00:00.000Z',
          updated: '2026-06-01T00:00:00.000Z',
          body: 'Substrate topology boundaries.',
        },
      ])
      expect(result).toMatchObject({ ok: true, indexed: 1 })
      const search = await searchKnowledgeIndex(ctx, 'topology')
      expect(search).toMatchObject({
        ok: true,
        items: [expect.objectContaining({ id: 'fde-three-views', tags: ['fde', 'framework'] })],
      })
      const dbBytes = readFileSync(join(workspacePath, '.mim', 'knowledge.sqlite'))
      expect(dbBytes.length).toBeGreaterThan(0)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
