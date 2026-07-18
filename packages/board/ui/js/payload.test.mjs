import { describe, expect, it } from 'vitest'
import { issueUpdatePayload } from './payload.js'

const base = {
  id: 'issue-1700000000-ab12',
  title: 'Ship it',
  status: 'backlog',
  priority: 'normal',
  labels: [{ name: 'bug', color: 'red' }],
  project: 'Launch',
  assignee: 'Ada',
  dueDate: '',
  remindAt: '',
}

describe('issue update payload', () => {
  it('omits the body when it was never fetched', () => {
    const payload = issueUpdatePayload({ ...base })
    expect(payload.body).toBeUndefined()
    // The wire format drops undefined keys, so the backend merge keeps the
    // stored body instead of overwriting it with ''.
    expect('body' in JSON.parse(JSON.stringify(payload))).toBe(false)
  })

  it('sends an explicitly cleared body', () => {
    const payload = issueUpdatePayload({ ...base, body: '' })
    expect(payload.body).toBe('')
    expect('body' in JSON.parse(JSON.stringify(payload))).toBe(true)
  })

  it('sends a loaded body verbatim', () => {
    expect(issueUpdatePayload({ ...base, body: '# Hello' }).body).toBe('# Hello')
  })

  it('omits empty due date and reminder', () => {
    const wire = JSON.parse(JSON.stringify(issueUpdatePayload({ ...base })))
    expect('dueDate' in wire).toBe(false)
    expect('remindAt' in wire).toBe(false)
  })
})
