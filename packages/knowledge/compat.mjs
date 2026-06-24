import assert from 'node:assert/strict'

const ctx = { actor: 'user' }

export async function smoke({ tools }) {
  const created = await tools.call('knowledge.create', {
    title: 'Compat note',
    tags: ['compat'],
    body: 'Created by the Mim compatibility gate.',
  }, ctx)
  assert.equal(created.id, 'compat-note')
  assert.equal(created.title, 'Compat note')

  const got = await tools.call('knowledge.get', { id: created.id }, ctx)
  assert.equal(got.body, 'Created by the Mim compatibility gate.')

  const updated = await tools.call('knowledge.update', {
    id: created.id,
    title: 'Compat note updated',
    body: 'Updated by compat.',
  }, ctx)
  assert.equal(updated.title, 'Compat note updated')

  const listed = await tools.call('knowledge.list', {}, ctx)
  assert.ok(listed.items.some(item => item.id === created.id))

  const catalog = await tools.call('knowledge.catalog', {}, ctx)
  assert.ok(catalog.entries.some(item => item.id === created.id))

  await tools.call('knowledge.delete', { id: created.id }, ctx)
  const after = await tools.call('knowledge.list', {}, ctx)
  assert.equal(after.items.some(item => item.id === created.id), false)
}
