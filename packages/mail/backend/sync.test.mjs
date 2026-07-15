// sync.test.mjs — tests for Gmail backfill + incremental sync
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSync } from './sync.mjs'
import { buildGmailMessage, buildProfile, buildLabelsResponse, buildMessageList, buildHistoryResponse, base64url } from './testUtils.mjs'
import { parseMessage } from './gmail.mjs'

/**
 * Minimal in-memory fake store implementing just the methods sync calls.
 * CONTRACT-GAP report: see bottom of test file for the exact method set.
 */
function fakeStore(initialAccount) {
  const accounts = new Map()
  const messages = new Map()       // compositeKey(accountId, gmailId) → parsed msg
  const labels = new Map()         // accountId → [labels]
  const deletedMessages = []       // track deletions for assertions
  const labelChanges = []          // track label changes for assertions

  if (initialAccount) {
    accounts.set(initialAccount.id, { ...initialAccount })
  }

  return {
    // --- Account methods ---
    getAccount(id) {
      return accounts.get(id) || null
    },
    upsertAccount(account) {
      const existing = accounts.get(account.id) || {}
      accounts.set(account.id, { ...existing, ...account })
    },
    updateAccount(id, patch) {
      const existing = accounts.get(id)
      if (!existing) throw new Error(`Account ${id} not found`)
      accounts.set(id, { ...existing, ...patch })
    },

    // --- Label methods ---
    upsertLabels(accountId, rows) {
      labels.set(accountId, rows)
    },
    listLabels(accountId) {
      return labels.get(accountId) || []
    },

    // --- Message methods ---
    upsertMessage(accountId, msg) {
      const key = `${accountId}:${msg.gmail_id}`
      messages.set(key, { accountId, ...msg })
    },
    deleteMessageByGmailId(accountId, gmailId) {
      const key = `${accountId}:${gmailId}`
      messages.delete(key)
      deletedMessages.push({ accountId, gmailId })
    },
    applyLabelChange(accountId, gmailId, addIds, removeIds) {
      labelChanges.push({ accountId, gmailId, addIds, removeIds })
      // Update the stored message's label_ids_json if it exists
      const key = `${accountId}:${gmailId}`
      const msg = messages.get(key)
      if (msg) {
        let currentLabels = JSON.parse(msg.label_ids_json || '[]')
        currentLabels = currentLabels.filter(l => !removeIds.includes(l))
        for (const id of addIds) {
          if (!currentLabels.includes(id)) currentLabels.push(id)
        }
        msg.label_ids_json = JSON.stringify(currentLabels)
        msg.is_unread = currentLabels.includes('UNREAD') ? 1 : 0
      }
    },

    // --- Test accessors ---
    _accounts: accounts,
    _messages: messages,
    _deletedMessages: deletedMessages,
    _labelChanges: labelChanges,
  }
}

/**
 * Fake Gmail client for sync tests.
 */
function fakeGmail({
  profileResponse,
  labelsResponse,
  listPages = [],
  messageStore = {},
  historyPages = [],
  historyError,
} = {}) {
  let listCallCount = 0
  let historyCallCount = 0
  const getMessageCalls = []

  return {
    async profile() {
      return profileResponse || buildProfile()
    },
    async listLabels() {
      return labelsResponse || buildLabelsResponse()
    },
    async listMessages(q, pageToken) {
      const idx = pageToken ? parseInt(pageToken.replace('page_', ''), 10) : 0
      const page = listPages[idx] || buildMessageList({ messages: [] })
      listCallCount++
      return page
    },
    async getMessage(id) {
      if (messageStore[id]) return messageStore[id]
      return buildGmailMessage({ id, threadId: `thread_${id}` })
    },
    async history(startHistoryId, pageToken) {
      if (historyError) {
        const err = new Error(historyError.message || 'History error')
        err.status = historyError.status
        throw err
      }
      const idx = pageToken ? parseInt(pageToken.replace('page_', ''), 10) : 0
      const page = historyPages[idx] || buildHistoryResponse()
      historyCallCount++
      return page
    },
    parseMessage,
    _getMessageCalls: getMessageCalls,
    get _listCallCount() { return listCallCount },
    get _historyCallCount() { return historyCallCount },
  }
}

describe('createSync — backfill', () => {
  it('captures historyId from profile BEFORE listing (load-bearing order)', async () => {
    const callOrder = []

    const gmail = {
      async profile() {
        callOrder.push('profile')
        return buildProfile({ historyId: '55555' })
      },
      async listLabels() {
        callOrder.push('labels')
        return buildLabelsResponse()
      },
      async listMessages() {
        callOrder.push('listMessages')
        return buildMessageList({ messages: [] })
      },
      async getMessage(id) { return buildGmailMessage({ id }) },
      parseMessage,
    }

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail })
    await sync.backfill('acct1')

    // Profile must be called before listMessages
    expect(callOrder.indexOf('profile')).toBeLessThan(callOrder.indexOf('listMessages'))

    // pending_history_id should have been set from profile
    const account = store.getAccount('acct1')
    expect(account.history_id).toBe('55555')
  })

  it('upserts labels from listLabels response', async () => {
    const gmail = fakeGmail({
      labelsResponse: buildLabelsResponse([
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'L1', name: 'Work', type: 'user' },
      ]),
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail })
    await sync.backfill('acct1')

    const labels = store.listLabels('acct1')
    expect(labels).toHaveLength(2)
    expect(labels[0].gmail_id).toBe('INBOX')
    expect(labels[1].name).toBe('Work')
  })

  it('fetches and upserts messages from list pages', async () => {
    const msg1 = buildGmailMessage({ id: 'msg_1', threadId: 't1', bodyText: 'Body 1' })
    const msg2 = buildGmailMessage({ id: 'msg_2', threadId: 't2', bodyText: 'Body 2' })

    const gmail = fakeGmail({
      listPages: [
        buildMessageList({ messages: [{ id: 'msg_1', threadId: 't1' }, { id: 'msg_2', threadId: 't2' }] }),
      ],
      messageStore: { msg_1: msg1, msg_2: msg2 },
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail })
    await sync.backfill('acct1')

    // Both messages should be in the store
    expect(store._messages.has('acct1:msg_1')).toBe(true)
    expect(store._messages.has('acct1:msg_2')).toBe(true)
    expect(store._messages.get('acct1:msg_1').body_text).toBe('Body 1')
  })

  it('handles pagination (multiple list pages)', async () => {
    const gmail = fakeGmail({
      listPages: [
        buildMessageList({
          messages: [{ id: 'msg_1', threadId: 't1' }],
          nextPageToken: 'page_1',
        }),
        buildMessageList({
          messages: [{ id: 'msg_2', threadId: 't2' }],
          // no nextPageToken — last page
        }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail })
    await sync.backfill('acct1')

    expect(store._messages.has('acct1:msg_1')).toBe(true)
    expect(store._messages.has('acct1:msg_2')).toBe(true)
  })

  it('resumes from backfill_cursor', async () => {
    let listQuery
    const gmail = {
      async profile() { return buildProfile() },
      async listLabels() { return buildLabelsResponse() },
      async listMessages(q, pageToken) {
        listQuery = { q, pageToken }
        return buildMessageList({ messages: [] })
      },
      async getMessage(id) { return buildGmailMessage({ id }) },
      parseMessage,
    }

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'running', sync_window_days: 180,
      backfill_cursor: 'saved_cursor_token',
      backfill_done: 50, backfill_total: 100,
    })

    const sync = createSync({ store, gmail })
    await sync.backfill('acct1')

    expect(listQuery.pageToken).toBe('saved_cursor_token')
  })

  it('sets backfill_state to done on success', async () => {
    const gmail = fakeGmail()
    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail })
    await sync.backfill('acct1')

    const account = store.getAccount('acct1')
    expect(account.backfill_state).toBe('done')
    expect(account.last_sync_at).toBeTruthy()
    expect(account.backfill_cursor).toBeNull()
  })

  it('sets backfill_state to error on failure', async () => {
    const gmail = {
      async profile() { throw new Error('Network error') },
      parseMessage,
    }
    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail })
    await expect(sync.backfill('acct1')).rejects.toThrow('Network error')

    const account = store.getAccount('acct1')
    expect(account.backfill_state).toBe('error')
    expect(account.last_error).toBe('Network error')
  })

  it('calls progress callback during backfill', async () => {
    const progressCalls = []
    const gmail = fakeGmail({
      listPages: [
        buildMessageList({ messages: [{ id: 'msg_1', threadId: 't1' }], resultSizeEstimate: 50 }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail, progress: (p) => progressCalls.push(p) })
    await sync.backfill('acct1')

    expect(progressCalls.length).toBeGreaterThanOrEqual(1)
    expect(progressCalls[0].backfill_total).toBe(50)
  })

  it('respects signal for cancellation', async () => {
    const abortController = new AbortController()
    let listCallCount = 0
    const gmail = {
      async profile() { return buildProfile() },
      async listLabels() { return buildLabelsResponse() },
      async listMessages() {
        listCallCount++
        if (listCallCount === 1) {
          abortController.abort()
          return buildMessageList({
            messages: [{ id: 'msg_1', threadId: 't1' }],
            nextPageToken: 'page_1',
          })
        }
        return buildMessageList({ messages: [] })
      },
      async getMessage(id) { return buildGmailMessage({ id }) },
      parseMessage,
    }

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'pending', sync_window_days: 180,
    })

    const sync = createSync({ store, gmail, signal: abortController.signal })
    await sync.backfill('acct1')

    // Should not have fetched the second page
    expect(listCallCount).toBe(1)
  })

  it('throws for missing account', async () => {
    const store = fakeStore()
    const gmail = fakeGmail()
    const sync = createSync({ store, gmail })
    await expect(sync.backfill('nonexistent')).rejects.toThrow('not found')
  })
})

describe('createSync — incremental', () => {
  it('requires backfill_state done', async () => {
    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'running', history_id: '100',
    })
    const gmail = fakeGmail()
    const sync = createSync({ store, gmail })

    await expect(sync.incremental('acct1')).rejects.toThrow('Backfill must complete')
  })

  it('requires history_id', async () => {
    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: null,
    })
    const gmail = fakeGmail()
    const sync = createSync({ store, gmail })

    await expect(sync.incremental('acct1')).rejects.toThrow('No history_id')
  })

  it('applies messagesAdded — fetches full and upserts', async () => {
    const addedMsg = buildGmailMessage({
      id: 'new_msg', threadId: 'new_thread', bodyText: 'New message body',
    })

    const gmail = fakeGmail({
      historyPages: [
        buildHistoryResponse({
          history: [{
            messagesAdded: [{ message: { id: 'new_msg' } }],
          }],
          historyId: '200',
        }),
      ],
      messageStore: { new_msg: addedMsg },
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    expect(store._messages.has('acct1:new_msg')).toBe(true)
    expect(store._messages.get('acct1:new_msg').body_text).toBe('New message body')
  })

  it('applies messagesDeleted', async () => {
    const gmail = fakeGmail({
      historyPages: [
        buildHistoryResponse({
          history: [{
            messagesDeleted: [{ message: { id: 'old_msg' } }],
          }],
          historyId: '200',
        }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })
    // Pre-populate message
    store.upsertMessage('acct1', { gmail_id: 'old_msg', body_text: 'old' })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    expect(store._messages.has('acct1:old_msg')).toBe(false)
    expect(store._deletedMessages).toContainEqual({ accountId: 'acct1', gmailId: 'old_msg' })
  })

  it('applies labelsAdded', async () => {
    const gmail = fakeGmail({
      historyPages: [
        buildHistoryResponse({
          history: [{
            labelsAdded: [{
              message: { id: 'msg_1' },
              labelIds: ['IMPORTANT'],
            }],
          }],
          historyId: '200',
        }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })
    store.upsertMessage('acct1', { gmail_id: 'msg_1', label_ids_json: '["INBOX"]' })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    expect(store._labelChanges).toContainEqual({
      accountId: 'acct1', gmailId: 'msg_1',
      addIds: ['IMPORTANT'], removeIds: [],
    })
  })

  it('applies labelsRemoved', async () => {
    const gmail = fakeGmail({
      historyPages: [
        buildHistoryResponse({
          history: [{
            labelsRemoved: [{
              message: { id: 'msg_1' },
              labelIds: ['UNREAD'],
            }],
          }],
          historyId: '200',
        }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })
    store.upsertMessage('acct1', { gmail_id: 'msg_1', label_ids_json: '["INBOX","UNREAD"]', is_unread: 1 })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    // Label change should have been applied
    const msg = store._messages.get('acct1:msg_1')
    expect(msg.is_unread).toBe(0)
  })

  it('updates history_id on success', async () => {
    const gmail = fakeGmail({
      historyPages: [
        buildHistoryResponse({ history: [], historyId: '999' }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    const account = store.getAccount('acct1')
    expect(account.history_id).toBe('999')
    expect(account.last_sync_at).toBeTruthy()
  })

  it('handles history pagination', async () => {
    const gmail = fakeGmail({
      historyPages: [
        buildHistoryResponse({
          history: [{ messagesAdded: [{ message: { id: 'msg_1' } }] }],
          historyId: '200',
          nextPageToken: 'page_1',
        }),
        buildHistoryResponse({
          history: [{ messagesAdded: [{ message: { id: 'msg_2' } }] }],
          historyId: '300',
        }),
      ],
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    expect(store._messages.has('acct1:msg_1')).toBe(true)
    expect(store._messages.has('acct1:msg_2')).toBe(true)
    expect(store.getAccount('acct1').history_id).toBe('300')
  })

  it('on history 404: re-lists 7 days + resets historyId from fresh profile', async () => {
    let profileCallCount = 0
    let listQuery

    const gmail = {
      async profile() {
        profileCallCount++
        return buildProfile({ historyId: '77777' })
      },
      async listLabels() { return buildLabelsResponse() },
      async listMessages(q, pageToken) {
        listQuery = q
        return buildMessageList({ messages: [] })
      },
      async getMessage(id) { return buildGmailMessage({ id }) },
      async history() {
        const err = new Error('Not found')
        err.status = 404
        throw err
      },
      parseMessage,
    }

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })

    const sync = createSync({ store, gmail })
    await sync.incremental('acct1')

    // Should have called profile to get new historyId
    expect(profileCallCount).toBe(1)
    // Should have re-listed with 7-day window
    expect(listQuery).toBe('newer_than:7d')
    // history_id should be reset
    expect(store.getAccount('acct1').history_id).toBe('77777')
  })

  it('sets last_error on non-404 failure', async () => {
    const gmail = fakeGmail({
      historyError: { status: 500, message: 'Internal error' },
    })

    const store = fakeStore({
      id: 'acct1', email: 'user@test.com',
      backfill_state: 'done', history_id: '100',
    })

    const sync = createSync({ store, gmail })
    await expect(sync.incremental('acct1')).rejects.toThrow()

    expect(store.getAccount('acct1').last_error).toBe('Internal error')
  })
})

/**
 * CONTRACT-GAP: Fake store methods assumed by sync tests.
 * Wave 2 must verify these match the real store (§8.1) signatures.
 *
 * Store methods used by sync:
 *   - getAccount(id) → account | null
 *   - upsertAccount({ id, email, ... })
 *   - updateAccount(id, patch)
 *   - upsertLabels(accountId, rows)
 *   - listLabels(accountId)
 *   - upsertMessage(accountId, msgData)
 *   - deleteMessageByGmailId(accountId, gmailId)
 *   - applyLabelChange(accountId, gmailId, addIds, removeIds)
 */
