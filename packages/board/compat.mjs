import assert from 'node:assert/strict'

const ctx = { actor: 'user' }

export async function smoke({ tools }) {
  const created = await tools.call('issues.create', {
    title: 'Compat issue',
    status: 'backlog',
    priority: 'normal',
    labels: [{ name: 'compat', color: 'blue' }],
    project: 'test-project',
    assignee: 'tester',
    body: 'Created by the Mim compatibility gate.',
  }, ctx)
  assert.match(created.id, /^issue-\d+-[a-z0-9]{4}$/)
  assert.equal(created.title, 'Compat issue')
  assert.equal(created.project, 'test-project')
  assert.equal(created.assignee, 'tester')
  assert.ok(Array.isArray(created.labels))
  assert.equal(created.labels[0].name, 'compat')
  assert.equal(created.labels[0].color, 'blue')

  const got = await tools.call('issues.get', { id: created.id }, ctx)
  assert.equal(got.body, 'Created by the Mim compatibility gate.')
  assert.equal(got.project, 'test-project')
  assert.equal(got.assignee, 'tester')
  assert.equal(got.labels[0].name, 'compat')

  const updated = await tools.call('issues.update', {
    id: created.id,
    title: 'Compat issue updated',
    status: 'done',
    labels: [{ name: 'compat', color: 'green' }],
    project: 'test-project-v2',
  }, ctx)
  assert.equal(updated.status, 'done')
  assert.equal(updated.project, 'test-project-v2')
  assert.equal(updated.labels[0].color, 'green')

  const listed = await tools.call('issues.list', {}, ctx)
  assert.ok(listed.items.some(item => item.id === created.id && item.status === 'done'))

  // Legacy tags compat: create with tags, get back labels
  const legacy = await tools.call('issues.create', {
    title: 'Legacy tags issue',
    status: 'backlog',
    priority: 'normal',
    tags: ['old-tag'],
    body: '',
  }, ctx)
  assert.ok(Array.isArray(legacy.labels))
  assert.equal(legacy.labels[0].name, 'old-tag')
  assert.equal(legacy.labels[0].color, 'gray')
  assert.ok(Array.isArray(legacy.tags))
  assert.ok(legacy.tags.includes('old-tag'))

  await tools.call('issues.delete', { id: legacy.id }, ctx)
  await tools.call('issues.delete', { id: created.id }, ctx)
  const after = await tools.call('issues.list', {}, ctx)
  assert.equal(after.items.some(item => item.id === created.id), false)
}
