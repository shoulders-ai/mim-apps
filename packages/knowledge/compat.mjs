import assert from 'node:assert/strict'

const ctx = { actor: 'user' }

export async function smoke({ tools }) {
  const created = await tools.call('knowledge.create', {
    title: 'Compat note',
    tags: '["compat","tool-input"]',
    links: '["references compat-reference"]',
    body: 'Created by the Mim compatibility gate.',
  }, ctx)
  assert.equal(created.id, 'compat-note')
  assert.equal(created.title, 'Compat note')

  const got = await tools.call('knowledge.get', { id: created.id }, ctx)
  assert.equal(got.body, 'Created by the Mim compatibility gate.')
  assert.deepEqual(got.tags, ['compat', 'tool-input'])
  assert.deepEqual(got.links, [{ rel: 'references', target: 'compat-reference' }])

  const updated = await tools.call('knowledge.update', {
    id: created.id,
    title: 'Compat note updated',
    tags: 'compat, updated',
    links: 'mentions compat-person',
    body: 'Updated by compat.',
  }, ctx)
  assert.equal(updated.title, 'Compat note updated')
  assert.deepEqual(updated.tags, ['compat', 'updated'])
  assert.deepEqual(updated.links, [{ rel: 'mentions', target: 'compat-person' }])

  const listed = await tools.call('knowledge.list', {}, ctx)
  assert.ok(listed.items.some(item => item.id === created.id))

  const catalog = await tools.call('knowledge.catalog', {}, ctx)
  assert.ok(catalog.entries.some(item => item.id === created.id))

  await tools.call('knowledge.delete', { id: created.id }, ctx)
  const after = await tools.call('knowledge.list', {}, ctx)
  assert.equal(after.items.some(item => item.id === created.id), false)
}
