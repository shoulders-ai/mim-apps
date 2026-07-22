import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from './store.mjs'

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-store-test-'))
  return { dir, dbPath: join(dir, 'mail.sqlite') }
}

describe('createStore', () => {
  let tmp, store

  beforeEach(() => {
    tmp = tmpDb()
    store = createStore({ dbPath: tmp.dbPath })
  })

  afterEach(() => {
    if (store?.close) store.close()
    rmSync(tmp.dir, { recursive: true, force: true })
  })

  // --- Migration idempotency ---

  describe('migrations', () => {
    it('creates schema and sets schema_version', () => {
      // Force open
      store.listLabels('no-account')
      // Re-open same DB — must not throw
      store.close()
      const store2 = createStore({ dbPath: tmp.dbPath })
      const labels = store2.listLabels('no-account')
      expect(labels).toEqual([])
      store2.close()
    })

    it('is idempotent across multiple opens', () => {
      store.listLabels('x')
      store.close()
      const s2 = createStore({ dbPath: tmp.dbPath })
      s2.listLabels('x')
      s2.close()
      const s3 = createStore({ dbPath: tmp.dbPath })
      s3.listLabels('x')
      s3.close()
      // No throw = success
      store = null
    })
  })

  // --- Accounts ---

  describe('accounts', () => {
    it('upsertAccount + getAccount round-trip', () => {
      store.upsertAccount({ id: 'a1', email: 'alice@example.com', created_at: '2024-01-01' })
      const acc = store.getAccount('a1')
      expect(acc.email).toBe('alice@example.com')
      expect(acc.backfill_state).toBe('pending')
    })

    it('updateAccount patches fields', () => {
      store.upsertAccount({ id: 'a1', email: 'alice@example.com', created_at: '2024-01-01' })
      store.updateAccount('a1', { history_id: '12345', backfill_state: 'done' })
      const acc = store.getAccount('a1')
      expect(acc.history_id).toBe('12345')
      expect(acc.backfill_state).toBe('done')
    })

    it('upsertAccount defaults created_at so update-only callers can omit it', () => {
      // sync.mjs stores the profile email via upsertAccount({ id, email })
      // with no created_at; node:sqlite refuses to bind undefined.
      store.upsertAccount({ id: 'a1', email: '', created_at: '2024-01-01' })
      store.upsertAccount({ id: 'a1', email: 'alice@example.com' })
      const acc = store.getAccount('a1')
      expect(acc.email).toBe('alice@example.com')
      expect(acc.created_at).toBe('2024-01-01')

      // Fresh insert without created_at gets a timestamp, not a crash.
      store.upsertAccount({ id: 'a2', email: 'bob@example.com' })
      expect(store.getAccount('a2').created_at).toBeTruthy()
    })
  })

  // --- Labels ---

  describe('labels', () => {
    it('upsertLabels + listLabels round-trip', () => {
      store.upsertLabels('a1', [
        { id: 'l1', gmail_id: 'INBOX', name: 'Inbox', type: 'system' },
        { id: 'l2', gmail_id: 'SENT', name: 'Sent', type: 'system' },
      ])
      const labels = store.listLabels('a1')
      expect(labels).toHaveLength(2)
      expect(labels.map(l => l.name).sort()).toEqual(['Inbox', 'Sent'])
    })

    it('upsertLabels updates existing', () => {
      store.upsertLabels('a1', [
        { id: 'l1', gmail_id: 'INBOX', name: 'Inbox', type: 'system' },
      ])
      store.upsertLabels('a1', [
        { id: 'l1', gmail_id: 'INBOX', name: 'Inbox Renamed', type: 'system' },
      ])
      const labels = store.listLabels('a1')
      expect(labels).toHaveLength(1)
      expect(labels[0].name).toBe('Inbox Renamed')
    })

    it('upsertLabels generates row ids when absent and keeps them stable across syncs', () => {
      // sync.mjs upserts labels as {gmail_id, name, type} with no id.
      store.upsertLabels('a1', [{ gmail_id: 'INBOX', name: 'Inbox', type: 'system' }])
      const [first] = store.listLabels('a1')
      expect(first.id).toBeTruthy()
      store.upsertLabels('a1', [{ gmail_id: 'INBOX', name: 'Inbox Renamed', type: 'system' }])
      const [second] = store.listLabels('a1')
      expect(second.id).toBe(first.id)
      expect(second.name).toBe('Inbox Renamed')
    })
  })

  // --- Messages + Thread rollups ---

  describe('upsertMessage + thread rollups', () => {
    it('creates thread and message, maintains rollups', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: JSON.stringify([{ email: 'bob@example.com' }]),
        subject: 'Hello',
        snippet: 'Hi there',
        body_text: 'Hi there Bob',
        internal_date: 1700000000000,
        is_unread: 1,
        is_from_me: 0,
        rfc822_message_id: '<msg1@example.com>',
      })

      const threads = store.searchThreads({ accountId: 'a1', limit: 10 })
      expect(threads).toHaveLength(1)
      expect(threads[0].subject).toBe('Hello')
      expect(threads[0].message_count).toBe(1)
      expect(threads[0].is_unread).toBe(1)
      expect(threads[0].snippet).toBe('Hi there')
    })

    it('second message updates thread rollup', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hello',
        snippet: 'First',
        body_text: 'First message',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      store.upsertMessage('a1', {
        gmail_id: 'gm2',
        thread_gmail_id: 'gt1',
        from_name: 'Bob',
        from_email: 'bob@example.com',
        to_json: '[]',
        subject: 'Re: Hello',
        snippet: 'Second',
        body_text: 'Second message',
        internal_date: 1700000001000,
        is_unread: 1,
        is_from_me: 0,
      })

      const threads = store.searchThreads({ accountId: 'a1', limit: 10 })
      expect(threads).toHaveLength(1)
      expect(threads[0].message_count).toBe(2)
      expect(threads[0].is_unread).toBe(1)
      expect(threads[0].snippet).toBe('Second')
      expect(threads[0].last_message_at).toBe(1700000001000)
    })

    it('searchThreads rows carry the latest sender without loading messages', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hello',
        snippet: 'First',
        body_text: 'First message',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
        label_ids_json: JSON.stringify(['INBOX']),
      })
      store.upsertMessage('a1', {
        gmail_id: 'gm2',
        thread_gmail_id: 'gt1',
        from_name: 'Bob',
        from_email: 'bob@example.com',
        to_json: '[]',
        subject: 'Re: Hello',
        snippet: 'Second',
        body_text: 'Second message',
        internal_date: 1700000001000,
        is_unread: 0,
        is_from_me: 0,
        label_ids_json: JSON.stringify(['INBOX']),
      })

      // All three query branches: plain, label-filtered, FTS.
      const all = store.searchThreads({ accountId: 'a1', limit: 10 })
      expect(all[0].last_from_name).toBe('Bob')
      expect(all[0].last_from_email).toBe('bob@example.com')

      const inbox = store.searchThreads({ accountId: 'a1', tab: 'inbox', limit: 10 })
      expect(inbox[0].last_from_name).toBe('Bob')

      const fts = store.searchThreads({ accountId: 'a1', query: 'hello', limit: 10 })
      expect(fts[0].last_from_name).toBe('Bob')
    })

    it('updating an existing message recalculates thread rollup', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hello',
        snippet: 'Version 1',
        body_text: 'Version 1 body',
        internal_date: 1700000000000,
        is_unread: 1,
        is_from_me: 0,
      })

      // Update same message
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hello',
        snippet: 'Version 2',
        body_text: 'Version 2 body',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      const threads = store.searchThreads({ accountId: 'a1', limit: 10 })
      expect(threads).toHaveLength(1)
      expect(threads[0].message_count).toBe(1)
      expect(threads[0].snippet).toBe('Version 2')
      expect(threads[0].is_unread).toBe(0)
    })
  })

  // --- FTS ---

  describe('FTS', () => {
    it('search finds messages by body', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Quarterly report',
        body_text: 'The quarterly results show growth in all sectors',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      store.upsertMessage('a1', {
        gmail_id: 'gm2',
        thread_gmail_id: 'gt2',
        from_name: 'Bob',
        from_email: 'bob@example.com',
        to_json: '[]',
        subject: 'Lunch?',
        body_text: 'Want to grab lunch tomorrow?',
        internal_date: 1700000001000,
        is_unread: 0,
        is_from_me: 0,
      })

      const results = store.searchThreads({ accountId: 'a1', query: 'quarterly', limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('Quarterly report')
    })

    it('FTS is updated on message update (delete+insert)', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Old subject',
        body_text: 'Original body text about bananas',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      // Update the message
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'New subject',
        body_text: 'Updated body text about oranges',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      // Old text should not be found
      const old = store.searchThreads({ accountId: 'a1', query: 'bananas', limit: 10 })
      expect(old).toHaveLength(0)

      // New text should be found
      const newer = store.searchThreads({ accountId: 'a1', query: 'oranges', limit: 10 })
      expect(newer).toHaveLength(1)
    })
  })

  // --- deleteMessageByGmailId ---

  describe('deleteMessageByGmailId', () => {
    it('removes message and updates thread', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hello',
        snippet: 'First',
        body_text: 'First message',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      store.upsertMessage('a1', {
        gmail_id: 'gm2',
        thread_gmail_id: 'gt1',
        from_name: 'Bob',
        from_email: 'bob@example.com',
        to_json: '[]',
        subject: 'Re: Hello',
        snippet: 'Second',
        body_text: 'Second message',
        internal_date: 1700000001000,
        is_unread: 0,
        is_from_me: 0,
      })

      store.deleteMessageByGmailId('a1', 'gm2')
      const threads = store.searchThreads({ accountId: 'a1', limit: 10 })
      expect(threads).toHaveLength(1)
      expect(threads[0].message_count).toBe(1)
    })

    it('removes FTS entry for deleted message', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Unique findme',
        body_text: 'Findme body text',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })

      store.deleteMessageByGmailId('a1', 'gm1')
      const results = store.searchThreads({ accountId: 'a1', query: 'findme', limit: 10 })
      expect(results).toHaveLength(0)
    })
  })

  // --- applyLabelChange ---

  describe('applyLabelChange', () => {
    it('adds and removes label ids', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hi',
        body_text: 'Body',
        internal_date: 1700000000000,
        is_unread: 1,
        is_from_me: 0,
        label_ids_json: '["INBOX","UNREAD"]',
      })

      store.applyLabelChange('a1', 'gm1', ['STARRED'], ['UNREAD'])
      const msg = store.getMessage(store.searchThreads({ accountId: 'a1', limit: 1 })[0].id)
      // getMessage returns by thread id - we need the message
      // Let's use getThreadMessages instead
      const thread = store.searchThreads({ accountId: 'a1', limit: 1 })[0]
      const msgs = store.getThreadMessages(thread.id)
      const labels = JSON.parse(msgs[0].label_ids_json)
      expect(labels).toContain('INBOX')
      expect(labels).toContain('STARRED')
      expect(labels).not.toContain('UNREAD')
    })

    it('updates is_unread when UNREAD label changes', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Hi',
        body_text: 'Body',
        internal_date: 1700000000000,
        is_unread: 1,
        is_from_me: 0,
        label_ids_json: '["INBOX","UNREAD"]',
      })

      store.applyLabelChange('a1', 'gm1', [], ['UNREAD'])
      const thread = store.searchThreads({ accountId: 'a1', limit: 1 })[0]
      // Thread unread should be recalculated
      expect(thread.is_unread).toBe(0)
    })
  })

  // --- searchThreads with tabs ---

  describe('searchThreads tabs', () => {
    beforeEach(() => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Inbox msg',
        body_text: 'Inbox body',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
        label_ids_json: '["INBOX"]',
      })

      store.upsertMessage('a1', {
        gmail_id: 'gm2',
        thread_gmail_id: 'gt2',
        from_name: 'Me',
        from_email: 'me@example.com',
        to_json: '[]',
        subject: 'Sent msg',
        body_text: 'Sent body',
        internal_date: 1700000001000,
        is_unread: 0,
        is_from_me: 1,
        label_ids_json: '["SENT"]',
      })
    })

    it('tab=inbox filters to threads with INBOX messages', () => {
      const results = store.searchThreads({ accountId: 'a1', tab: 'inbox', limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('Inbox msg')
    })

    it('tab=sent filters to threads with SENT messages', () => {
      const results = store.searchThreads({ accountId: 'a1', tab: 'sent', limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('Sent msg')
    })

    it('tab=all returns everything', () => {
      const results = store.searchThreads({ accountId: 'a1', tab: 'all', limit: 10 })
      expect(results).toHaveLength(2)
    })

    it('supports limit and offset', () => {
      const page1 = store.searchThreads({ accountId: 'a1', tab: 'all', limit: 1, offset: 0 })
      expect(page1).toHaveLength(1)
      const page2 = store.searchThreads({ accountId: 'a1', tab: 'all', limit: 1, offset: 1 })
      expect(page2).toHaveLength(1)
      expect(page1[0].id).not.toBe(page2[0].id)
    })
  })

  // --- getThread / getThreadMessages / getMessage ---

  describe('thread and message retrieval', () => {
    it('getThread returns thread by internal id', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Test',
        body_text: 'Body',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })
      const threads = store.searchThreads({ accountId: 'a1', limit: 1 })
      const thread = store.getThread(threads[0].id)
      expect(thread.gmail_id).toBe('gt1')
    })

    it('getThreadMessages returns messages sorted by internal_date', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Test',
        body_text: 'First',
        internal_date: 1700000001000,
        is_unread: 0,
        is_from_me: 0,
      })
      store.upsertMessage('a1', {
        gmail_id: 'gm2',
        thread_gmail_id: 'gt1',
        from_name: 'Bob',
        from_email: 'bob@example.com',
        to_json: '[]',
        subject: 'Re: Test',
        body_text: 'Second',
        internal_date: 1700000002000,
        is_unread: 0,
        is_from_me: 0,
      })
      const threads = store.searchThreads({ accountId: 'a1', limit: 1 })
      const msgs = store.getThreadMessages(threads[0].id)
      expect(msgs).toHaveLength(2)
      expect(msgs[0].body_text).toBe('First')
      expect(msgs[1].body_text).toBe('Second')
    })

    it('getMessage returns a single message by id', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm1',
        thread_gmail_id: 'gt1',
        from_name: 'Alice',
        from_email: 'alice@example.com',
        to_json: '[]',
        subject: 'Test',
        body_text: 'Body',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 0,
      })
      const threads = store.searchThreads({ accountId: 'a1', limit: 1 })
      const msgs = store.getThreadMessages(threads[0].id)
      const msg = store.getMessage(msgs[0].id)
      expect(msg.gmail_id).toBe('gm1')
      expect(msg.body_text).toBe('Body')
    })
  })

  // --- Drafts ---

  describe('drafts', () => {
    it('createDraft + getDraft round-trip', () => {
      const draft = store.createDraft({
        account_id: 'a1',
        to_json: JSON.stringify([{ email: 'bob@example.com' }]),
        subject: 'Draft subject',
      })
      expect(draft.id).toBeTruthy()
      expect(draft.state).toBe('composing')

      const fetched = store.getDraft(draft.id)
      expect(fetched.subject).toBe('Draft subject')
    })

    it('updateDraft patches fields', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Old' })
      store.updateDraft(draft.id, { subject: 'New', voice_id: 'v1' })
      const fetched = store.getDraft(draft.id)
      expect(fetched.subject).toBe('New')
      expect(fetched.voice_id).toBe('v1')
    })

    it('listDrafts filters by state', () => {
      store.createDraft({ account_id: 'a1', subject: 'Active' })
      const d2 = store.createDraft({ account_id: 'a1', subject: 'Discarded' })
      store.updateDraft(d2.id, { state: 'discarded' })

      const composing = store.listDrafts({ state: 'composing' })
      expect(composing).toHaveLength(1)
      expect(composing[0].subject).toBe('Active')

      const discarded = store.listDrafts({ state: 'discarded' })
      expect(discarded).toHaveLength(1)

      const all = store.listDrafts({})
      expect(all).toHaveLength(2)
    })
  })

  // --- Revisions ---

  describe('revisions', () => {
    it('appendRevision assigns sequential seq values', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({
        draftId: draft.id,
        body: 'First draft',
        source: 'ai_initial',
      })
      const r2 = store.appendRevision({
        draftId: draft.id,
        body: 'Second draft',
        source: 'human_edit',
      })

      expect(r1.seq).toBe(1)
      expect(r2.seq).toBe(2)

      const updated = store.getDraft(draft.id)
      expect(updated.current_revision_id).toBe(r2.id)
    })

    it('appendRevision enforces unique seq per draft', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      store.appendRevision({ draftId: draft.id, body: 'v1', source: 'ai_initial' })
      store.appendRevision({ draftId: draft.id, body: 'v2', source: 'human_edit' })
      const r3 = store.appendRevision({ draftId: draft.id, body: 'v3', source: 'human_edit' })
      expect(r3.seq).toBe(3)
    })

    it('appendRevision revokes approval when draft is approved', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'v1', source: 'ai_initial' })

      // Approve the draft
      store.updateDraft(draft.id, {
        state: 'approved',
        approved_revision_id: r1.id,
        approved_at: new Date().toISOString(),
      })

      // New revision should revert to composing + append approval_revoked provenance
      store.appendRevision({ draftId: draft.id, body: 'v2', source: 'human_edit' })

      const updated = store.getDraft(draft.id)
      expect(updated.state).toBe('composing')

      const prov = store.listProvenance({ draftId: draft.id })
      const revoked = prov.find(p => p.kind === 'approval_revoked')
      expect(revoked).toBeTruthy()
    })

    it('getRevision and listRevisions', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'v1', source: 'ai_initial' })
      const r2 = store.appendRevision({ draftId: draft.id, body: 'v2', source: 'human_edit' })

      const rev = store.getRevision(r1.id)
      expect(rev.body_text).toBe('v1')
      expect(rev.source).toBe('ai_initial')

      const all = store.listRevisions(draft.id)
      expect(all).toHaveLength(2)
      expect(all[0].seq).toBe(1)
      expect(all[1].seq).toBe(2)
    })
  })

  // --- Proposals & Hunks ---

  describe('proposals and hunks', () => {
    it('createProposal with hunks', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'Hello world', source: 'ai_initial' })

      const proposal = store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'Improve greeting',
        origin: 'user_request',
        hunks: [
          {
            seq: 1,
            original_text: 'Hello',
            proposed_text: 'Hi',
            note: 'More casual',
            status: 'pending',
          },
        ],
      })

      expect(proposal.id).toBeTruthy()

      const fetched = store.getProposal(proposal.id, { withHunks: true })
      expect(fetched.hunks).toHaveLength(1)
      expect(fetched.hunks[0].original_text).toBe('Hello')
    })

    it('pendingProposal returns the latest pending proposal', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'Body', source: 'ai_initial' })

      store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'First',
        origin: 'user_request',
        hunks: [],
      })

      const pending = store.pendingProposal('draft', draft.id)
      expect(pending).toBeTruthy()
      expect(pending.intent_text).toBe('First')
    })

    it('getHunk returns a single hunk row by id, null when missing', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'Hello world', source: 'ai_initial' })
      const proposal = store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'Fix',
        origin: 'user_request',
        hunks: [{ seq: 1, original_text: 'Hello', proposed_text: 'Hi', status: 'pending' }],
      })
      const withHunks = store.getProposal(proposal.id, { withHunks: true })
      const hunk = store.getHunk(withHunks.hunks[0].id)
      expect(hunk).toMatchObject({
        id: withHunks.hunks[0].id,
        proposal_id: proposal.id,
        original_text: 'Hello',
        proposed_text: 'Hi',
        status: 'pending',
      })
      expect(store.getHunk('missing')).toBeNull()
    })

    it('listProposals returns all proposals for a target in creation order', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const other = store.createDraft({ account_id: 'a1', subject: 'Other' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'Body', source: 'ai_initial' })
      const rOther = store.appendRevision({ draftId: other.id, body: 'Body', source: 'ai_initial' })

      const p1 = store.createProposal({
        target_kind: 'draft', target_id: draft.id, base_revision_id: r1.id,
        intent_text: 'First', origin: 'user_request', hunks: [],
      })
      const p2 = store.createProposal({
        target_kind: 'draft', target_id: draft.id, base_revision_id: r1.id,
        intent_text: 'Second', origin: 'chat_agent', hunks: [],
      })
      store.createProposal({
        target_kind: 'draft', target_id: other.id, base_revision_id: rOther.id,
        intent_text: 'Elsewhere', origin: 'user_request', hunks: [],
      })
      store.updateProposal(p1.id, { status: 'dismissed', resolved_at: new Date().toISOString() })

      const list = store.listProposals({ targetKind: 'draft', targetId: draft.id })
      expect(list.map(p => p.id)).toEqual([p1.id, p2.id])
      expect(list[0].status).toBe('dismissed')
      expect(store.listProposals({ targetKind: 'draft', targetId: 'missing' })).toEqual([])
    })

    it('a dismissed proposal found via listProposals flips _untouchedCheck', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'Body', source: 'ai_initial' })
      expect(store._untouchedCheck(draft.id)).toBe(true)
      const p1 = store.createProposal({
        target_kind: 'draft', target_id: draft.id, base_revision_id: r1.id,
        intent_text: 'First', origin: 'user_request', hunks: [],
      })
      store.updateProposal(p1.id, { status: 'dismissed', resolved_at: new Date().toISOString() })
      expect(store._untouchedCheck(draft.id)).toBe(false)
    })

    it('updateHunk and updateProposal', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'Hello world', source: 'ai_initial' })

      const proposal = store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'Fix',
        origin: 'user_request',
        hunks: [
          { seq: 1, original_text: 'Hello', proposed_text: 'Hi', status: 'pending' },
        ],
      })

      const fetched = store.getProposal(proposal.id, { withHunks: true })
      store.updateHunk(fetched.hunks[0].id, { status: 'accepted' })
      store.updateProposal(proposal.id, { status: 'resolved', resolved_at: new Date().toISOString() })

      const updated = store.getProposal(proposal.id, { withHunks: true })
      expect(updated.status).toBe('resolved')
      expect(updated.hunks[0].status).toBe('accepted')
    })
  })

  // --- Voices ---

  describe('voices', () => {
    it('createVoice + listVoices + getVoice', () => {
      const voice = store.createVoice({
        name: 'Professional',
        description: 'Formal tone',
        body_md: '# Professional Voice\n\nFormal and clear.',
      })
      expect(voice.id).toBeTruthy()

      const list = store.listVoices({ archived: false })
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe('Professional')

      const fetched = store.getVoice(voice.id)
      expect(fetched.body_md).toContain('Professional Voice')
    })

    it('updateVoice patches name, description, and archived without touching the body', () => {
      const voice = store.createVoice({
        name: 'Professional',
        description: 'Formal tone',
        body_md: 'Body stays.',
      })
      store.updateVoice(voice.id, { name: 'Client mail', description: 'Warm', archived: 1 })
      const updated = store.getVoice(voice.id)
      expect(updated.name).toBe('Client mail')
      expect(updated.description).toBe('Warm')
      expect(updated.archived).toBe(1)
      expect(updated.body_md).toBe('Body stays.')
      expect(updated.current_revision_id).toBe(voice.current_revision_id)
      expect(updated.updated_at >= voice.updated_at).toBe(true)

      // Archived voices leave the default listing and appear under archived.
      expect(store.listVoices({ archived: false })).toHaveLength(0)
      expect(store.listVoices({ archived: true }).map(v => v.id)).toEqual([voice.id])

      // Empty patch is a no-op, not an error.
      store.updateVoice(voice.id, {})
      expect(store.getVoice(voice.id).name).toBe('Client mail')
    })

    it('appendVoiceRevision tracks revisions', () => {
      const voice = store.createVoice({
        name: 'Casual',
        body_md: 'Be chill',
      })

      const vr = store.appendVoiceRevision({
        voiceId: voice.id,
        body: 'Be very chill',
        source: 'human_edit',
      })

      expect(vr.seq).toBe(2) // seed is seq 1
      const updated = store.getVoice(voice.id)
      expect(updated.body_md).toBe('Be very chill')
      expect(updated.current_revision_id).toBe(vr.id)
    })
  })

  // --- Provenance ---

  describe('provenance', () => {
    it('appendProvenance + listProvenance round-trip', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      store.appendProvenance({
        draftId: draft.id,
        kind: 'draft_created',
        payload: { subject: 'Test' },
      })
      store.appendProvenance({
        draftId: draft.id,
        kind: 'ai_drafted',
        payload: { model: 'test-model' },
      })

      const prov = store.listProvenance({ draftId: draft.id })
      expect(prov).toHaveLength(2)
      expect(prov[0].kind).toBe('draft_created')
      expect(prov[1].kind).toBe('ai_drafted')
    })

    it('listProvenance supports sinceId', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      store.appendProvenance({ draftId: draft.id, kind: 'draft_created', payload: {} })
      const prov1 = store.listProvenance({ draftId: draft.id })
      const firstId = prov1[0].id

      store.appendProvenance({ draftId: draft.id, kind: 'ai_drafted', payload: {} })
      const prov2 = store.listProvenance({ draftId: draft.id, sinceId: firstId })
      expect(prov2).toHaveLength(1)
      expect(prov2[0].kind).toBe('ai_drafted')
    })
  })

  // --- Sends ---

  describe('sends', () => {
    it('recordSend + undistilledSends + markDistilled', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test', voice_id: 'v1' })
      store.recordSend({
        draft_id: draft.id,
        gmail_message_id: 'gm-sent-1',
        sent_at: '2024-06-01T12:00:00Z',
        final_text: 'Final text here',
        first_ai_text: 'AI text here',
        survival_rate: 0.85,
        untouched: 0,
        voice_id: 'v1',
      })

      const undistilled = store.undistilledSends()
      expect(undistilled).toHaveLength(1)
      expect(undistilled[0].draft_id).toBe(draft.id)

      store.markDistilled([draft.id])
      const after = store.undistilledSends()
      expect(after).toHaveLength(0)
    })
  })

  // --- recentSentTo ---

  describe('recentSentTo', () => {
    it('returns exact email matches first', () => {
      // Create a sent message to bob@acme.com
      store.upsertMessage('a1', {
        gmail_id: 'gm-sent-1',
        thread_gmail_id: 'gt-sent-1',
        from_name: 'Me',
        from_email: 'me@example.com',
        to_json: JSON.stringify([{ email: 'bob@acme.com', name: 'Bob' }]),
        subject: 'To Bob exactly',
        body_text: 'Hey Bob, exact match',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 1,
        label_ids_json: '["SENT"]',
      })

      // Also a message to alice@acme.com (same domain)
      store.upsertMessage('a1', {
        gmail_id: 'gm-sent-2',
        thread_gmail_id: 'gt-sent-2',
        from_name: 'Me',
        from_email: 'me@example.com',
        to_json: JSON.stringify([{ email: 'alice@acme.com', name: 'Alice' }]),
        subject: 'To Alice same domain',
        body_text: 'Hey Alice, domain match',
        internal_date: 1700000001000,
        is_unread: 0,
        is_from_me: 1,
        label_ids_json: '["SENT"]',
      })

      const exact = store.recentSentTo({ accountId: 'a1', email: 'bob@acme.com', limit: 5 })
      expect(exact).toHaveLength(1)
      expect(exact[0].subject).toBe('To Bob exactly')
    })

    it('falls back to domain when no exact email match', () => {
      store.upsertMessage('a1', {
        gmail_id: 'gm-sent-1',
        thread_gmail_id: 'gt-sent-1',
        from_name: 'Me',
        from_email: 'me@example.com',
        to_json: JSON.stringify([{ email: 'carol@acme.com', name: 'Carol' }]),
        subject: 'To Carol domain',
        body_text: 'Hey Carol',
        internal_date: 1700000000000,
        is_unread: 0,
        is_from_me: 1,
        label_ids_json: '["SENT"]',
      })

      // No exact match for dave@acme.com, but carol@acme.com is same domain
      const results = store.recentSentTo({ accountId: 'a1', email: 'dave@acme.com', domain: 'acme.com', limit: 5 })
      expect(results).toHaveLength(1)
      expect(results[0].subject).toBe('To Carol domain')
    })

    it('returns empty when no matches', () => {
      const results = store.recentSentTo({ accountId: 'a1', email: 'nobody@nowhere.com', limit: 5 })
      expect(results).toHaveLength(0)
    })
  })

  // --- voiceMetrics ---

  describe('voiceMetrics', () => {
    it('computes per-voice metrics with sufficient data', () => {
      const voice = store.createVoice({ name: 'Pro', body_md: 'Professional' })

      // Create 12 drafts+sends with this voice across different weeks
      for (let i = 0; i < 12; i++) {
        const draft = store.createDraft({
          account_id: 'a1',
          subject: `Draft ${i}`,
          voice_id: voice.id,
        })
        // Stagger sent_at across several ISO weeks
        const weekOffset = Math.floor(i / 3)
        const date = new Date(2024, 5, 3 + weekOffset * 7 + (i % 3))
        store.recordSend({
          draft_id: draft.id,
          gmail_message_id: `gm-s-${i}`,
          sent_at: date.toISOString(),
          final_text: 'Some final text here',
          first_ai_text: 'Some final text here with extras',
          survival_rate: 0.7 + i * 0.02,
          untouched: i < 4 ? 1 : 0, // 4 out of 12 untouched
          voice_id: voice.id,
        })
      }

      const metrics = store.voiceMetrics()
      expect(metrics.per_voice).toHaveLength(1)
      const vm = metrics.per_voice[0]
      expect(vm.voice_id).toBe(voice.id)
      expect(vm.scored_sends).toBe(12)
      expect(vm.survival_trend.length).toBeGreaterThan(0)
      // Each trend entry has week + mean
      expect(vm.survival_trend[0]).toHaveProperty('week')
      expect(vm.survival_trend[0]).toHaveProperty('mean')
      // Untouched rate: 4/12
      expect(vm.untouched_rate).toBeCloseTo(4 / 12, 2)

      // Funnel
      expect(metrics.funnel.sent).toBe(12)
      expect(metrics.funnel.sent_untouched).toBe(4)
    })

    it('returns empty metrics when no sends', () => {
      const metrics = store.voiceMetrics()
      expect(metrics.per_voice).toEqual([])
      expect(metrics.funnel).toEqual({ drafts: 0, sent: 0, sent_untouched: 0 })
    })
  })

  // --- close ---

  describe('close', () => {
    it('close is safe to call multiple times', () => {
      store.listLabels('x') // force open
      store.close()
      store.close() // no throw
      store = null
    })
  })
})
