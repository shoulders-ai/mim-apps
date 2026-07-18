import { runtime } from '/sdk/mim.js'
import { STATUSES, PRIORITIES, STATUS_ALIAS, PRIORITY_ALIAS, DEFAULT_COLUMNS } from './constants.js'
import { issueUpdatePayload } from './payload.js'
import { state, render, showToast } from './state.js'

function normStatus(s) {
  if (STATUS_ALIAS[s]) return STATUS_ALIAS[s]
  return STATUSES.includes(s) ? s : 'backlog'
}

function normPriority(p) {
  if (PRIORITY_ALIAS[p]) return PRIORITY_ALIAS[p]
  return PRIORITIES.includes(p) ? p : 'normal'
}

function normLabel(l) {
  if (l && typeof l === 'object' && typeof l.name === 'string') {
    return { name: l.name, color: l.color || 'gray' }
  }
  return null
}

function normIssue(raw) {
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map(normLabel).filter(Boolean)
    : Array.isArray(raw.tags)
      ? raw.tags.map(t => ({ name: String(t), color: 'gray' }))
      : []

  return {
    id: raw.id,
    title: raw.title || '',
    status: normStatus(raw.status),
    priority: normPriority(raw.priority),
    labels,
    tags: labels.map(l => l.name),
    project: raw.project || '',
    assignee: raw.assignee || '',
    dueDate: raw.dueDate || '',
    remindAt: raw.remindAt || '',
    created: raw.created || '',
    updated: raw.updated || '',
    body: typeof raw.body === 'string' ? raw.body : undefined,
  }
}

export async function loadIssues() {
  const result = await runtime.call('issues.list', {})
  state.folderPresent = result.folderPresent !== false
  state.issues = (result.items || []).map(normIssue)
}

export async function loadUserName() {
  try {
    const stored = await runtime.data.kv.get('userName')
    if (stored) { state.userName = stored; return }
  } catch {}
  try {
    const config = await runtime.call('config.get', {})
    if (config?.user?.name) {
      state.userName = config.user.name
      return
    }
  } catch {}
}

export async function saveUserName(name) {
  state.userName = name
  try {
    await runtime.data.kv.set('userName', name)
  } catch {}
}

export async function loadColumnConfig() {
  try {
    const stored = await runtime.data.kv.get('enabledColumns')
    if (Array.isArray(stored) && stored.length > 0) {
      state.enabledColumns = new Set(stored)
      return
    }
  } catch {}
  state.enabledColumns = new Set(DEFAULT_COLUMNS)
}

export async function saveColumnConfig() {
  try {
    await runtime.data.kv.set('enabledColumns', [...state.enabledColumns])
  } catch {}
}

export async function saveIssue(issue) {
  const result = await runtime.call('issues.update', issueUpdatePayload(issue))
  if (result?.folderPresent === false) { state.folderPresent = false; return }
  if (result?.id) {
    const merged = normIssue(result)
    if (merged.body === undefined) merged.body = issue.body
    const idx = state.issues.findIndex(i => i.id === issue.id)
    if (idx !== -1) state.issues[idx] = merged
  }
}

export async function createIssue(title, opts = {}) {
  const result = await runtime.call('issues.create', {
    title,
    status: opts.status || 'backlog',
    priority: opts.priority || 'normal',
    labels: opts.labels || [],
    project: opts.project || '',
    assignee: opts.assignee || '',
    dueDate: opts.dueDate || undefined,
    body: opts.body || '',
  })
  if (!result || result.folderPresent === false) {
    state.folderPresent = false
    render()
    return null
  }
  const issue = normIssue(result)
  if (issue.body === undefined) issue.body = ''
  state.issues.push(issue)
  return issue
}

export async function deleteIssue(id) {
  await runtime.call('issues.delete', { id })
  state.issues = state.issues.filter(i => i.id !== id)
}

export async function ensureBody(issue) {
  if (typeof issue.body === 'string') return issue.body
  try {
    const full = await runtime.call('issues.get', { id: issue.id })
    if (typeof issue.body === 'string') return issue.body
    issue.body = typeof full.body === 'string' ? full.body : ''
  } catch {
    if (typeof issue.body === 'string') return issue.body
    issue.body = ''
  }
  return issue.body
}

export async function enableBoard() {
  await runtime.call('app.enable', { app: 'board' })
  await loadIssues()
  render()
}

export function onWorkspaceChanged(fn) {
  runtime.on('workspace:changed', fn)
  runtime.on('apps:changed', fn)
}

export function checkReminders() {
  const now = new Date()
  const fired = []
  for (const issue of state.issues) {
    if (!issue.remindAt) continue
    if (issue.status === 'done' || issue.status === 'cancelled') continue
    if (new Date(issue.remindAt) <= now) {
      fired.push({ id: issue.id, title: issue.title, remindAt: issue.remindAt })
    }
  }
  state.firedReminders = fired
}
