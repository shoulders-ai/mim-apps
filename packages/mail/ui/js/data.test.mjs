import { describe, expect, it } from 'vitest'
import { toolMapFromCapabilities } from './data.js'

// package.capabilities.list returns { packages: [{ packageId, tools }] }
// (mim-os src/main/tools/packageRuntime.ts). Discovery must parse that shape;
// the pkg_ hash prefix is opaque and never hardcoded (CONTRACTS §3.2).
describe('toolMapFromCapabilities', () => {
  // id is the backend export key (mim-os packageRuntime toolSummary); name is
  // the public name — dotted when granted, pkg_<hash>__<key> for ui-only.
  const tool = (name, id, packageId = 'mail') => ({
    name,
    id,
    packageId,
    label: id,
    description: '',
    inputSchema: { type: 'object', properties: {} },
  })

  it('maps named and ui-only mail tools from the packages envelope', () => {
    const map = toolMapFromCapabilities({
      packages: [
        {
          packageId: 'mail',
          tools: [tool('mail.search', 'search'), tool('mail.draft.get', 'draft_get'), tool('pkg_a1b2c3__connect_start', 'connect_start'), tool('pkg_a1b2c3__ui_inbox', 'ui_inbox')],
        },
        { packageId: 'board', tools: [tool('board.issues', 'issues', 'board')] },
      ],
    })
    expect(map.search).toBe('mail.search')
    expect(map.draft_get).toBe('mail.draft.get')
    expect(map.connect_start).toBe('pkg_a1b2c3__connect_start')
    expect(map.ui_inbox).toBe('pkg_a1b2c3__ui_inbox')
    expect(Object.values(map)).not.toContain('board.issues')
  })

  it('derives keys from NAMED_KEYS and the pkg suffix when id is absent', () => {
    const map = toolMapFromCapabilities({
      packages: [
        { packageId: 'mail', tools: [{ name: 'mail.search' }, { name: 'pkg_a1b2c3__connect_start' }] },
      ],
    })
    expect(map.search).toBe('mail.search')
    expect(map.connect_start).toBe('pkg_a1b2c3__connect_start')
  })

  it('tolerates packages entries without tools', () => {
    const map = toolMapFromCapabilities({ packages: [{ packageId: 'mail' }, null] })
    expect(map).toEqual({})
  })

  it('still accepts a flat tools array', () => {
    const map = toolMapFromCapabilities({ tools: [tool('mail.search', 'search'), tool('pkg_ff__connect_status', 'connect_status')] })
    expect(map.search).toBe('mail.search')
    expect(map.connect_status).toBe('pkg_ff__connect_status')
  })

  it('returns an empty map for unrecognized shapes', () => {
    expect(toolMapFromCapabilities(null)).toEqual({})
    expect(toolMapFromCapabilities({})).toEqual({})
  })
})
