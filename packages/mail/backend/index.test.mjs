// index.test.mjs — Wave 2 integration tests for the wired backend.
//
// Real temp-file SQLite store, fake fetch over Gmail fixtures (testUtils),
// stubbed ctx.ai, in-memory secrets, and a fake ctx modelling the runtime
// surface (data.kv, secrets, http, ai, tools.call, progress, abort).
// No network, no ~/.mim, no electron.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { jobs, tools, agents, _resetForTests, _storeForTests } from './index.mjs'
import {
  fakeFetch,
  fakeSecrets,
  buildGmailMessage,
  buildProfile,
  buildLabelsResponse,
  buildMessageList,
  buildHistoryResponse,
} from './testUtils.mjs'

const USER_EMAIL = 'user@example.com'

// ---------------------------------------------------------------------------
// Fake ctx (models the PackageRuntimeContext surface)

function makeKv() {
  const map = new Map()
  const history = []
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => {
      map.set(k, v)
      history.push({ key: k, value: v })
    },
    delete: (k) => map.delete(k),
    keys: () => [...map.keys()],
    _history: history,
  }
}

// jobMode 'inline' runs kicked jobs synchronously through the real jobs
// export (mirroring package.jobs.start's contract for the package actor —
// packageId resolved from ctx, only jobId passed); 'record' only records.
function makeCtx({ fetchFn, secrets, ai, kv, jobMode = 'inline' } = {}) {
  const kvApi = kv ?? makeKv()
  const store = secrets ?? fakeSecrets()
  const kicked = []
  const ctx = {
    package: { id: 'mail', name: 'Mail', version: '0.1.0', source: 'local' },
    job: null,
    inputs: {},
    data: {
      kv: kvApi,
      collection: () => ({ get: () => null, put: () => {}, delete: () => {}, list: () => [] }),
    },
    files: { readPackageText: async () => '', readWorkspaceText: async () => '' },
    progress: { step: () => {}, log: () => {}, progress: () => {}, done: () => {} },
    audit: { record: async () => {} },
    abort: {
      signal: null,
      get aborted() {
        return false
      },
      throwIfAborted() {},
    },
    tools: {
      async call(name, params = {}) {
        if (name !== 'package.jobs.start') throw new Error(`Unexpected tool call: ${name}`)
        if (typeof params.jobId !== 'string') throw new Error('Missing required parameter: jobId')
        if (params.packageId && params.packageId !== 'mail') {
          throw new Error('App jobs must use the authenticated app identity')
        }
        kicked.push(params.jobId)
        const job = jobs[params.jobId]
        if (!job) throw new Error(`Package job not found: mail.${params.jobId}`)
        if (jobMode === 'inline') {
          const result = await job.run(ctx, params.inputs ?? {})
          return { runId: `run_${kicked.length}`, status: 'completed', result }
        }
        return { runId: `run_${kicked.length}`, status: 'running' }
      },
    },
    http: {
      request: async ({ url, method, headers, body }) => {
        if (!fetchFn) throw new Error('No fake fetch configured for this ctx')
        return fetchFn(url, { method, headers, body })
      },
    },
    secrets: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
      delete: async (k) => store.delete(k),
      has: async (k) => store.get(k) != null,
    },
    ai: {
      generateObject: async (input) => {
        if (!ai) throw new Error('No AI stub configured for this ctx')
        return ai(input)
      },
    },
    _kicked: kicked,
    _secrets: store,
    _kv: kvApi,
  }
  return ctx
}

// Routes generateObject calls by schema shape (body / hunks / voices).
function aiRouter({ body, hunks, voices } = {}) {
  return async (input) => {
    const props = input?.schema?.properties ?? {}
    const pick = (v) => (typeof v === 'function' ? v(input) : v)
    if (props.body) return { object: { body: pick(body) }, modelId: 'stub-model' }
    if (props.hunks) return { object: { hunks: pick(hunks) ?? [] }, modelId: 'stub-model' }
    if (props.voices) return { object: { voices: pick(voices) ?? [] }, modelId: 'stub-model' }
    throw new Error('ai stub: unrecognized schema')
  }
}

const SEED_VOICES = [
  {
    name: 'Direct EN',
    description: 'Everyday English work mail',
    body_md: '# Register\n\nDirect and brief.\n\n# Sign-off\n\nAlways "Best, Paul".',
  },
]

const AI_BODY =
  'Hi Anna,\n\nThanks for the update — the numbers look strong.\n\nCould we move the review to Thursday?\n\nBest,\nPaul'

// ---------------------------------------------------------------------------
// Gmail fixtures

const SENT_BODY_BASE =
  'Quick update from my side: the draft went out this morning and I folded in the feedback from last week without changing the overall structure of the document.'

function mailboxMessages({ sentCount = 6 } = {}) {
  const messages = [
    buildGmailMessage({
      id: 'msg_anna_1',
      threadId: 'thread_anna',
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: '1700000100000',
      subject: 'Q3 numbers',
      from: 'Anna Schmidt <anna@acme.com>',
      to: `Paul <${USER_EMAIL}>`,
      bodyText:
        'Hi Paul,\n\nSharing the Q3 numbers ahead of the review. Revenue is up twelve percent quarter over quarter.\n\nBest,\nAnna',
      messageId: '<anna-1@acme.com>',
    }),
  ]
  for (let i = 1; i <= sentCount; i++) {
    messages.push(
      buildGmailMessage({
        id: `msg_sent_${i}`,
        threadId: `thread_sent_${i}`,
        labelIds: ['SENT'],
        internalDate: String(1699990000000 + i * 60_000),
        subject: `Weekly update ${i}`,
        from: `Paul <${USER_EMAIL}>`,
        to: 'Client <client@corp.example>',
        bodyText: `${SENT_BODY_BASE} Iteration number ${i} of the series.`,
        messageId: `<sent-${i}@example.com>`,
      }),
    )
  }
  return messages
}

function decodeRaw(raw) {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function decodeRawBody(raw) {
  const rfc = decodeRaw(raw)
  const idx = rfc.indexOf('\r\n\r\n')
  const b64 = rfc.slice(idx + 4).replace(/\r\n/g, '')
  return Buffer.from(b64, 'base64').toString('utf-8')
}

// Full Gmail API fixture set. Sent messages register themselves so the
// post-send getMessage(full) mirror fetch works.
function gmailRoutes({ messages = mailboxMessages(), historyId = '1000' } = {}) {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const sent = []
  const modified = []
  const routes = [
    {
      method: 'GET',
      pattern: '/users/me/profile',
      handler: () => ({ status: 200, body: buildProfile({ emailAddress: USER_EMAIL, historyId }) }),
    },
    {
      method: 'GET',
      pattern: '/users/me/labels',
      handler: () => ({ status: 200, body: buildLabelsResponse() }),
    },
    {
      method: 'POST',
      pattern: '/users/me/messages/send',
      handler: (url, options) => {
        const reqBody = JSON.parse(options.body)
        const id = `gmail_sent_${sent.length + 1}`
        sent.push({ id, ...reqBody })
        const threadId = reqBody.threadId ?? `t_${id}`
        byId.set(
          id,
          buildGmailMessage({
            id,
            threadId,
            labelIds: ['SENT'],
            internalDate: String(Date.now()),
            subject: 'Sent message',
            from: `Paul <${USER_EMAIL}>`,
            to: 'Anna Schmidt <anna@acme.com>',
            bodyText: decodeRawBody(reqBody.raw),
            messageId: `<${id}@example.com>`,
          }),
        )
        return { status: 200, body: { id, threadId, labelIds: ['SENT'] } }
      },
    },
    {
      method: 'POST',
      pattern: /\/users\/me\/messages\/[^/?]+\/modify/,
      handler: (url, options) => {
        const id = url.match(/messages\/([^/?]+)\/modify/)[1]
        modified.push({ id, ...JSON.parse(options.body) })
        return { status: 200, body: { id } }
      },
    },
    {
      method: 'GET',
      pattern: /\/users\/me\/messages\/[^/?]+\?format=full/,
      handler: (url) => {
        const id = url.match(/messages\/([^/?]+)\?/)[1]
        const message = byId.get(id)
        return message
          ? { status: 200, body: message }
          : { status: 404, body: { error: { code: 404, message: `no message ${id}` } } }
      },
    },
    {
      method: 'GET',
      pattern: '/users/me/messages?',
      handler: () => ({
        status: 200,
        body: buildMessageList({
          messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })),
          resultSizeEstimate: messages.length,
        }),
      }),
    },
    {
      method: 'GET',
      pattern: '/users/me/history',
      handler: () => ({ status: 200, body: buildHistoryResponse({ history: [], historyId: '2000' }) }),
    },
  ]
  return { routes, sent, modified, byId }
}

function connectedSecrets() {
  return fakeSecrets({
    google_oauth_client: JSON.stringify({
      installed: { client_id: 'test-client', client_secret: 'test-secret' },
    }),
    google_oauth_tokens: JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      expires_at: Date.now() + 3_600_000,
    }),
  })
}

// Minimal fake loopback server (oauth.test.mjs pattern): binds
// asynchronously and address() is null until listening, like node:http.
function fakeCreateServerFactory(capture) {
  return (handler) => {
    let port = 0
    let listening = false
    const server = {
      listen(p, host, cb) {
        queueMicrotask(() => {
          port = p === 0 ? 20000 + Math.floor(Math.random() * 10000) : p
          listening = true
          if (typeof host === 'function') host()
          else if (typeof cb === 'function') cb()
        })
      },
      once() {},
      removeListener() {},
      address: () => (listening ? { port, address: '127.0.0.1' } : null),
      close(cb) {
        listening = false
        if (typeof cb === 'function') cb()
      },
      _simulateRequest(url, method = 'GET') {
        const res = {
          _status: 200,
          writeHead(status) {
            this._status = status
          },
          end() {},
        }
        handler({ url, method }, res)
        return res
      },
    }
    capture.server = server
    return server
  }
}

// ---------------------------------------------------------------------------

describe('mail backend index', () => {
  let tmp
  let ctx

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mail-index-test-'))
    _resetForTests({ dbPath: join(tmp, 'mail.sqlite') })
    ctx = null
  })

  afterEach(() => {
    _resetForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  async function backfilled({ fixtures = gmailRoutes(), ai } = {}) {
    ctx = makeCtx({
      fetchFn: fakeFetch(fixtures.routes),
      secrets: connectedSecrets(),
      ai: ai ?? aiRouter({ body: AI_BODY, hunks: [], voices: SEED_VOICES }),
    })
    await jobs.backfill.run(ctx)
    return fixtures
  }

  function annaMessageId() {
    const store = _storeForTests()
    const threads = store.searchThreads({ accountId: 'default', tab: 'all', limit: 50, offset: 0 })
    for (const thread of threads) {
      const match = store.getThreadMessages(thread.id).find((m) => m.gmail_id === 'msg_anna_1')
      if (match) return match.id
    }
    throw new Error('anna message not mirrored')
  }

  // ----- export shape -----

  describe('exports', () => {
    it('jobs: backfill/sync/seed_voices/flywheel, all single-concurrency, sync + flywheel ephemeral', () => {
      expect(Object.keys(jobs).sort()).toEqual(['backfill', 'flywheel', 'seed_voices', 'sync'])
      for (const [id, job] of Object.entries(jobs)) {
        expect(job.concurrency, id).toBe('single')
        expect(typeof job.run, id).toBe('function')
        expect(typeof job.label, id).toBe('string')
      }
      expect(jobs.sync.ephemeral).toBe(true)
      expect(jobs.flywheel.ephemeral).toBe(true)
      expect(jobs.backfill.ephemeral).toBeUndefined()
      expect(jobs.seed_voices.ephemeral).toBeUndefined()
    })

    it('audience split: §3.1 tools are named without audience, §3.2 tools are ui-only, dot-free, unnamed', () => {
      const named = [
        'search', 'thread', 'message', 'labels', 'label', 'sync',
        'drafts', 'draft_get', 'draft_create', 'draft_propose', 'voices_list',
      ]
      const uiOnly = [
        'connect_start', 'connect_status', 'connect_disconnect',
        'ui_inbox', 'ui_thread', 'ui_draft', 'ui_voices',
        'draft_edit', 'hunk_accept', 'hunk_reject', 'hunk_comment', 'proposal_dismiss',
        'draft_approve', 'draft_send', 'draft_discard', 'draft_update_meta',
        'voice_update', 'settings_get', 'settings_set', 'jobs_kick',
        'ui_propose', 'revision_get', 'draft_revert', 'ui_mark',
      ]
      expect(Object.keys(tools).sort()).toEqual([...named, ...uiOnly].sort())
      for (const key of named) {
        expect(tools[key].name, key).toMatch(/^mail\./)
        expect(tools[key].audience, key).toBeUndefined() // default = chat
      }
      for (const key of uiOnly) {
        expect(tools[key].audience, key).toEqual(['ui'])
        expect('name' in tools[key], key).toBe(false)
        expect(key).not.toContain('.')
      }
      for (const [key, tool] of Object.entries(tools)) {
        expect(typeof tool.execute, key).toBe('function')
        expect(tool.description?.length, key).toBeGreaterThan(0)
        expect(tool.inputSchema?.type, key).toBe('object')
      }
    })

    it('every named tool is granted by the manifest, and vice versa', () => {
      const manifest = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
      )
      const granted = manifest.mim.provides.tools.map((t) => t.name).sort()
      const named = Object.values(tools)
        .filter((t) => typeof t.name === 'string')
        .map((t) => t.name)
        .sort()
      expect(named).toEqual(granted)
    })

    it('agents: one Mail agent allowlisted to exactly the named set', () => {
      expect(Object.keys(agents)).toEqual(['mail'])
      // Distinct from the app's own "Mail" sidebar row — same label twice
      // with only an icon differing is indistinguishable.
      expect(agents.mail.name).toBe('Mail Agent')
      expect(agents.mail.tools.sort()).toEqual(
        Object.values(tools)
          .filter((t) => typeof t.name === 'string')
          .map((t) => t.name)
          .sort(),
      )
    })
  })

  // ----- not connected -----

  describe('unconnected state', () => {
    it('data tools return recoverable {error} payloads', async () => {
      ctx = makeCtx({})
      for (const key of ['search', 'thread', 'message', 'labels', 'drafts', 'draft_create']) {
        const result = await tools[key].execute(ctx, { thread_id: 'x', message_id: 'x' })
        expect(result.error, key).toMatch(/connect/i)
      }
      expect((await tools.ui_inbox.execute(ctx, { tab: 'inbox' })).error).toMatch(/connect/i)
      expect((await tools.draft_send.execute(ctx, { draft_id: 'x' })).error).toMatch(/connect/i)
      expect((await tools.sync.execute(ctx, {})).error).toMatch(/connect/i)
    })

    it('connect_status reports disconnected with defaults', async () => {
      ctx = makeCtx({})
      const status = await tools.connect_status.execute(ctx, {})
      expect(status).toMatchObject({
        connected: false,
        email: '',
        backfill_state: 'pending',
        token_ok: false,
        seed_state: 'none',
      })
    })
  })

  // ----- backfill + mirror + snapshot + seeding -----

  describe('backfill job', () => {
    it('mirrors the mailbox, writes the agent kv snapshot, and kicks voice seeding', async () => {
      await backfilled()

      const account = _storeForTests().getAccount('default')
      expect(account.email).toBe(USER_EMAIL)
      expect(account.backfill_state).toBe('done')
      expect(account.history_id).toBe('1000')

      // Threads visible through the named read surface.
      const inbox = await tools.search.execute(ctx, { tab: 'inbox' })
      expect(inbox.threads.map((t) => t.subject)).toContain('Q3 numbers')
      const sentTab = await tools.search.execute(ctx, { tab: 'sent', limit: 50 })
      expect(sentTab.threads.length).toBe(6) // is_from_me via SENT label

      // kv snapshot for the mounted agent.
      const snap = ctx._kv.get('agent_state')
      expect(snap).toMatchObject({
        email: USER_EMAIL,
        backfill_state: 'done',
        thread_count: 7,
      })
      expect(snap.last_sync_at).toBeTruthy()

      // Voice seeding kicked (no voices existed) and completed inline.
      expect(ctx._kicked).toContain('seed_voices')
      const voices = await tools.voices_list.execute(ctx, {})
      expect(voices.voices.map((v) => v.name)).toEqual(['Direct EN'])
    })

    it('seed_state transitions none → running → ready', async () => {
      await backfilled()
      const seedWrites = ctx._kv._history.filter((h) => h.key === 'seed_state').map((h) => h.value)
      expect(seedWrites[0]).toBe('running')
      expect(seedWrites[seedWrites.length - 1]).toBe('ready')
      expect(ctx._kv.get('seed_state')).toBe('ready')
    })

    it('seed_state falls back to none when the sent corpus is too thin', async () => {
      await backfilled({ fixtures: gmailRoutes({ messages: mailboxMessages({ sentCount: 2 }) }) })
      expect(ctx._kicked).toContain('seed_voices')
      expect(ctx._kv.get('seed_state')).toBe('none')
      expect((await tools.voices_list.execute(ctx, {})).voices).toEqual([])
    })
  })

  // ----- read tools -----

  describe('read tools (mirror only)', () => {
    it('mail.thread and mail.message read the mirror; stale flag tracks last_sync_at', async () => {
      await backfilled()
      const messageId = annaMessageId()
      const message = await tools.message.execute(ctx, { message_id: messageId })
      expect(message.message.from.email).toBe('anna@acme.com')
      expect(message.message.body_text).toContain('twelve percent')
      expect(message.stale).toBe(false) // just synced

      const thread = await tools.thread.execute(ctx, {
        thread_id: message.message.thread_id,
      })
      expect(thread.messages).toHaveLength(1)
      expect(thread.thread.subject).toBe('Q3 numbers')

      // Age the mirror → stale flips, but no network call is attempted
      // (fetch would throw on unknown routes if it were).
      _storeForTests().updateAccount('default', {
        last_sync_at: new Date(Date.now() - 60_000).toISOString(),
      })
      expect((await tools.search.execute(ctx, {})).stale).toBe(true)
      expect((await tools.labels.execute(ctx, {})).stale).toBe(true)
    })

    it('mail.sync starts the sync job via package.jobs.start (backfill first when unfinished)', async () => {
      await backfilled()
      const before = ctx._kicked.length
      const result = await tools.sync.execute(ctx, {})
      expect(result.started).toBe(true)
      expect(ctx._kicked.slice(before)).toEqual(['sync'])
      expect(result.backfill_state).toBe('done')

      // Regressed backfill → mail.sync kicks backfill instead.
      _storeForTests().updateAccount('default', { backfill_state: 'pending' })
      const again = await tools.sync.execute(ctx, {})
      expect(ctx._kicked[ctx._kicked.length - 1]).toBe('backfill')
      expect(again.started).toBe(true)
    })

    it('mail.label writes to Gmail and mirrors locally', async () => {
      const fixtures = await backfilled()
      const messageId = annaMessageId()
      const result = await tools.label.execute(ctx, {
        message_id: messageId,
        remove: ['UNREAD'],
        add: ['Label_1'],
      })
      expect(result.ok).toBe(true)
      expect(fixtures.modified).toEqual([
        { id: 'msg_anna_1', addLabelIds: ['Label_1'], removeLabelIds: ['UNREAD'] },
      ])
      const mirrored = _storeForTests().getMessage(messageId)
      expect(mirrored.is_unread).toBe(0)
      expect(JSON.parse(mirrored.label_ids_json)).toContain('Label_1')
    })

    it('ui_mark archives and marks read across a whole thread', async () => {
      const fixtures = await backfilled()
      const store = _storeForTests()
      const threadId = store.getMessage(annaMessageId()).thread_id
      const result = await tools.ui_mark.execute(ctx, {
        thread_id: threadId,
        archive: true,
        read: true,
      })
      expect(result.ok).toBe(true)
      expect(fixtures.modified[0].removeLabelIds.sort()).toEqual(['INBOX', 'UNREAD'])
      const labels = JSON.parse(store.getMessage(annaMessageId()).label_ids_json)
      expect(labels).not.toContain('INBOX')
      expect(labels).not.toContain('UNREAD')
      expect((await tools.ui_mark.execute(ctx, { thread_id: threadId })).error).toBeTruthy()
    })

    it('ui_inbox serves thread rows per tab and local drafts for the drafts tab', async () => {
      await backfilled()
      const inbox = await tools.ui_inbox.execute(ctx, { tab: 'inbox' })
      expect(inbox.threads).toHaveLength(1)
      const sent = await tools.ui_inbox.execute(ctx, { tab: 'sent' })
      expect(sent.threads).toHaveLength(6)
      const searched = await tools.ui_inbox.execute(ctx, { tab: 'all', query: 'twelve percent' })
      expect(searched.threads.map((t) => t.subject)).toEqual(['Q3 numbers'])

      await tools.draft_create.execute(ctx, { to: ['x@y.example'], subject: 'Hello' })
      const drafts = await tools.ui_inbox.execute(ctx, { tab: 'drafts' })
      expect(drafts.drafts).toHaveLength(1)
      expect(drafts.drafts[0].subject).toBe('Hello')
      expect(drafts.threads).toBeUndefined()
    })
  })

  // ----- THE FULL LOOP -----

  describe('full loop', () => {
    it('backfill → reply draft → ai_initial → propose → accept + reject-with-comment → human edit → approve → send → provenance + survival + mirror', async () => {
      const fixtures = await backfilled({
        fixtures: gmailRoutes(),
        ai: aiRouter({
          body: AI_BODY,
          hunks: [
            {
              original_text: 'Could we move the review to Thursday?',
              proposed_text: 'Would Thursday afternoon work for the review?',
              note: 'softer ask',
            },
            { original_text: 'Hi Anna,', proposed_text: 'Hello Anna,', note: 'greeting' },
          ],
          voices: SEED_VOICES,
        }),
      })
      const store = _storeForTests()

      // 1. Reply draft with instruction → ai_initial revision.
      const created = await tools.draft_create.execute(ctx, {
        reply_to_message_id: annaMessageId(),
        instruction: 'Thank her and propose Thursday for the review',
      })
      expect(created.error).toBeUndefined()
      expect(created.body).toBe(AI_BODY)
      expect(created.draft.to).toEqual(['anna@acme.com'])
      expect(created.draft.subject).toBe('Q3 numbers')
      const draftId = created.draft.id

      // 2. ui_propose (Ask-AI) → pending proposal, origin user_request.
      const proposed = await tools.ui_propose.execute(ctx, {
        draft_id: draftId,
        intent: 'make it warmer',
      })
      expect(proposed.error).toBeUndefined()
      expect(proposed.hunks).toHaveLength(2)
      expect(proposed.dropped).toBe(0)
      expect(store.getProposal(proposed.proposal_id).origin).toBe('user_request')

      // 3. Accept one hunk, reject the other with a verbatim comment.
      const [hunkA, hunkB] = proposed.hunks
      const accepted = await tools.hunk_accept.execute(ctx, { hunk_id: hunkA.id })
      expect(accepted.body).toContain('Would Thursday afternoon work for the review?')
      const comment = 'Keep my usual greeting — Anna knows me.'
      const rejected = await tools.hunk_reject.execute(ctx, { hunk_id: hunkB.id, comment })
      expect(rejected.ok).toBe(true)
      expect(store.getProposal(proposed.proposal_id).status).toBe('resolved')

      // 4. Human edit (stale-write protected).
      const conflict = await tools.draft_edit.execute(ctx, {
        draft_id: draftId,
        body: 'whatever',
        base_revision_id: 'not-current',
      })
      expect(conflict.conflict).toBe(true)
      expect(conflict.current.revision_id).toBe(accepted.revision_id)

      const humanBody = accepted.body.replace('Best,', 'Thanks,')
      const edited = await tools.draft_edit.execute(ctx, {
        draft_id: draftId,
        body: humanBody,
        base_revision_id: accepted.revision_id,
      })
      expect(edited.revision_id).toBeTruthy()

      // 5. Approve the exact reviewed revision.
      const approved = await tools.draft_approve.execute(ctx, {
        draft_id: draftId,
        revision_id: edited.revision_id,
      })
      expect(approved.ok).toBe(true)

      // 6. Send: MIME with threading headers + quote, mirror, finalize.
      const sentResult = await tools.draft_send.execute(ctx, { draft_id: draftId })
      expect(sentResult.error).toBeUndefined()
      expect(sentResult.ok).toBe(true)
      expect(sentResult.state).toBe('sent')
      expect(sentResult.gmail_message_id).toBe('gmail_sent_1')

      // The wire payload: reply headers, quote assembly, thread routing.
      expect(fixtures.sent).toHaveLength(1)
      expect(fixtures.sent[0].threadId).toBe('thread_anna')
      const rfc = decodeRaw(fixtures.sent[0].raw)
      expect(rfc).toContain('In-Reply-To: <anna-1@acme.com>')
      expect(rfc).toContain('References: <anna-1@acme.com>')
      expect(rfc).toContain(`From: ${USER_EMAIL}`)
      expect(rfc).toContain('To: anna@acme.com')
      expect(rfc).toContain('Subject: Re: Q3 numbers')
      const wireBody = decodeRawBody(fixtures.sent[0].raw)
      expect(wireBody).toContain(humanBody)
      expect(wireBody).toContain('Anna Schmidt wrote:')
      expect(wireBody).toContain('> Hi Paul,')

      // Draft finalized.
      const draft = store.getDraft(draftId)
      expect(draft.state).toBe('sent')
      expect(draft.gmail_sent_id).toBe('gmail_sent_1')

      // Sends row: survival vs the first AI draft, untouched 0 (edit + reject).
      const sends = store.undistilledSends()
      expect(sends).toHaveLength(1)
      expect(sends[0].draft_id).toBe(draftId)
      expect(sends[0].first_ai_text).toBe(AI_BODY)
      expect(sends[0].final_text).toBe(humanBody) // clean body, never the quoted assembly
      expect(sends[0].survival_rate).toBeGreaterThan(0.5)
      expect(sends[0].survival_rate).toBeLessThan(1)
      expect(sends[0].untouched).toBe(0)

      // Sent message mirrored locally on the same thread, from_me.
      const annaThread = store.getMessage(annaMessageId()).thread_id
      const threadMessages = store.getThreadMessages(annaThread)
      const mirrored = threadMessages.find((m) => m.gmail_id === 'gmail_sent_1')
      expect(mirrored).toBeTruthy()
      expect(mirrored.is_from_me).toBe(1)
      expect(mirrored.body_text).toContain('Would Thursday afternoon work for the review?')

      // The complete provenance chain, in order.
      const kinds = store.listProvenance({ draftId }).map((e) => e.kind)
      const expected = [
        'draft_created',
        'ai_drafted',
        'proposal_created',
        'hunk_accepted',
        'hunk_rejected',
        'human_edit',
        'approved',
        'sent',
      ]
      let cursor = -1
      for (const kind of expected) {
        const at = kinds.indexOf(kind, cursor + 1)
        expect(at, `${kind} in ${kinds.join(',')}`).toBeGreaterThan(cursor)
        cursor = at
      }
      // Rejection comment lands verbatim in the ledger and in ui_voices lessons.
      const rejectedEvent = store
        .listProvenance({ draftId })
        .find((e) => e.kind === 'hunk_rejected')
      expect(JSON.parse(rejectedEvent.payload_json).comment).toBe(comment)
      const voicesView = await tools.ui_voices.execute(ctx, {})
      expect(voicesView.lessons).toContain(comment)
    })

    it('an untouched send scores survival 1 and untouched 1', async () => {
      await backfilled()
      const created = await tools.draft_create.execute(ctx, {
        to: ['client@corp.example'],
        subject: 'Ping',
        instruction: 'Say hello',
      })
      const draft = _storeForTests().getDraft(created.draft.id)
      await tools.draft_approve.execute(ctx, {
        draft_id: draft.id,
        revision_id: draft.current_revision_id,
      })
      const sent = await tools.draft_send.execute(ctx, { draft_id: draft.id })
      expect(sent.ok).toBe(true)
      const row = _storeForTests().undistilledSends()[0]
      expect(row.survival_rate).toBe(1)
      expect(row.untouched).toBe(1)
    })
  })

  // ----- the human gate -----

  describe('send gate', () => {
    async function approvedDraft() {
      await backfilled()
      const created = await tools.draft_create.execute(ctx, {
        to: ['client@corp.example'],
        subject: 'Gate test',
        instruction: 'Write it',
      })
      const draft = _storeForTests().getDraft(created.draft.id)
      await tools.draft_approve.execute(ctx, {
        draft_id: draft.id,
        revision_id: draft.current_revision_id,
      })
      return _storeForTests().getDraft(draft.id)
    }

    it('send without approval → recoverable error, draft untouched', async () => {
      await backfilled()
      const created = await tools.draft_create.execute(ctx, {
        to: ['client@corp.example'],
        instruction: 'Write it',
      })
      const result = await tools.draft_send.execute(ctx, { draft_id: created.draft.id })
      expect(result.error).toMatch(/approve/i)
      expect(_storeForTests().getDraft(created.draft.id).state).toBe('composing')
    })

    it('approve requires the current revision', async () => {
      await backfilled()
      const created = await tools.draft_create.execute(ctx, {
        to: ['client@corp.example'],
        instruction: 'Write it',
      })
      const result = await tools.draft_approve.execute(ctx, {
        draft_id: created.draft.id,
        revision_id: 'stale-revision',
      })
      expect(result.error).toMatch(/changed/i)
      expect(_storeForTests().getDraft(created.draft.id).state).toBe('composing')
    })

    it('edit after approval revokes it; send is refused until re-approved', async () => {
      const draft = await approvedDraft()
      expect(draft.state).toBe('approved')

      const edited = await tools.draft_edit.execute(ctx, {
        draft_id: draft.id,
        body: 'Completely rewritten by the human.',
        base_revision_id: draft.current_revision_id,
      })
      expect(edited.revision_id).toBeTruthy()

      const store = _storeForTests()
      const after = store.getDraft(draft.id)
      expect(after.state).toBe('composing')
      expect(store.listProvenance({ draftId: draft.id }).map((e) => e.kind)).toContain(
        'approval_revoked',
      )

      const result = await tools.draft_send.execute(ctx, { draft_id: draft.id })
      expect(result.error).toMatch(/approve/i)
      expect(store.getDraft(draft.id).state).toBe('composing')
    })

    it('changing recipients or subject on an approved draft revokes approval', async () => {
      const draft = await approvedDraft()
      const result = await tools.draft_update_meta.execute(ctx, {
        draft_id: draft.id,
        to: ['other@corp.example'],
      })
      expect(result.draft.state).toBe('composing')
      expect(result.draft.to).toEqual(['other@corp.example'])
      expect((await tools.draft_send.execute(ctx, { draft_id: draft.id })).error).toMatch(/approve/i)
    })

    it('a failed Gmail send → send_failed + last_send_error + {error}', async () => {
      const fixtures = gmailRoutes()
      fixtures.routes.unshift({
        method: 'POST',
        pattern: '/users/me/messages/send',
        handler: () => ({ status: 500, body: { error: { code: 500, message: 'backend blew up' } } }),
      })
      await backfilled({ fixtures })
      const created = await tools.draft_create.execute(ctx, {
        to: ['client@corp.example'],
        instruction: 'Write it',
      })
      const draft = _storeForTests().getDraft(created.draft.id)
      await tools.draft_approve.execute(ctx, {
        draft_id: draft.id,
        revision_id: draft.current_revision_id,
      })
      const result = await tools.draft_send.execute(ctx, { draft_id: draft.id })
      expect(result.error).toMatch(/backend blew up/)
      const failed = _storeForTests().getDraft(draft.id)
      expect(failed.state).toBe('send_failed')
      expect(failed.last_send_error).toMatch(/backend blew up/)
      expect(
        _storeForTests()
          .listProvenance({ draftId: draft.id })
          .map((e) => e.kind),
      ).toContain('send_failed')
      expect(_storeForTests().undistilledSends()).toHaveLength(0)
    })
  })

  // ----- proposals via tools -----

  describe('proposal surface', () => {
    async function draftWithProposal(hunks) {
      await backfilled({
        fixtures: gmailRoutes(),
        ai: aiRouter({ body: AI_BODY, hunks, voices: SEED_VOICES }),
      })
      const created = await tools.draft_create.execute(ctx, {
        reply_to_message_id: annaMessageId(),
        instruction: 'Reply',
      })
      const proposed = await tools.draft_propose.execute(ctx, {
        draft_id: created.draft.id,
        intent: 'tighten it',
      })
      return { draftId: created.draft.id, proposed }
    }

    it('mail.draft.propose hard-codes origin chat_agent; ui_propose hard-codes user_request', async () => {
      const { draftId, proposed } = await draftWithProposal([
        { original_text: 'Hi Anna,', proposed_text: 'Hello Anna,' },
      ])
      const store = _storeForTests()
      expect(store.getProposal(proposed.proposal_id).origin).toBe('chat_agent')

      const uiProposed = await tools.ui_propose.execute(ctx, {
        draft_id: draftId,
        intent: 'again',
      })
      expect(store.getProposal(uiProposed.proposal_id).origin).toBe('user_request')
      // Single-pending invariant: the chat proposal was superseded.
      expect(store.getProposal(proposed.proposal_id).status).toBe('superseded')
    })

    it('ui_propose on an empty draft routes to initialDraft', async () => {
      await backfilled()
      const created = await tools.draft_create.execute(ctx, { to: ['client@corp.example'] })
      expect(created.body).toBe('')
      const result = await tools.ui_propose.execute(ctx, {
        draft_id: created.draft.id,
        intent: 'Write a short hello',
      })
      expect(result.body).toBe(AI_BODY)
      expect(result.revision_id).toBeTruthy()
      const revision = _storeForTests().getRevision(result.revision_id)
      expect(revision.source).toBe('ai_initial')
    })

    it('hunk_comment records the comment and creates a superseding proposal from comment + parent intent', async () => {
      const { draftId, proposed } = await draftWithProposal([
        { original_text: 'Hi Anna,', proposed_text: 'Hello Anna,' },
      ])
      const store = _storeForTests()
      let capturedPrompt = null
      // Re-route the hunks stub to capture the revision prompt.
      ctx.ai.generateObject = async (input) => {
        capturedPrompt = input.prompt
        return {
          object: {
            hunks: [{ original_text: 'Best,\nPaul', proposed_text: 'Cheers,\nPaul' }],
          },
          modelId: 'stub-model',
        }
      }
      const result = await tools.hunk_comment.execute(ctx, {
        hunk_id: proposed.hunks[0].id,
        comment: 'Too formal, but do change the sign-off.',
      })
      expect(result.error).toBeUndefined()
      expect(result.proposal_id).not.toBe(proposed.proposal_id)
      expect(capturedPrompt).toContain('Too formal, but do change the sign-off.')
      expect(capturedPrompt).toContain('tighten it')

      const parent = store.getProposal(proposed.proposal_id, { withHunks: true })
      expect(parent.status).toBe('superseded')
      expect(parent.hunks[0].comment).toBe('Too formal, but do change the sign-off.')
      const child = store.getProposal(result.proposal_id)
      expect(child.origin).toBe('chat_agent') // inherited
      expect(child.intent_text).toContain('Too formal')
      expect(child.intent_text).toContain('tighten it')
      const kinds = store.listProvenance({ draftId }).map((e) => e.kind)
      expect(kinds).toContain('hunk_commented')
    })

    it('proposal_dismiss: plain logs proposal_dismissed, takeover logs human_takeover', async () => {
      const { draftId, proposed } = await draftWithProposal([
        { original_text: 'Hi Anna,', proposed_text: 'Hello Anna,' },
      ])
      const store = _storeForTests()
      const plain = await tools.proposal_dismiss.execute(ctx, {
        proposal_id: proposed.proposal_id,
      })
      expect(plain.ok).toBe(true)
      let kinds = store.listProvenance({ draftId }).map((e) => e.kind)
      expect(kinds).toContain('proposal_dismissed')
      expect(kinds).not.toContain('human_takeover')

      const second = await tools.draft_propose.execute(ctx, {
        draft_id: draftId,
        intent: 'once more',
      })
      const takeover = await tools.proposal_dismiss.execute(ctx, {
        proposal_id: second.proposal_id,
        takeover: true,
      })
      expect(takeover.ok).toBe(true)
      kinds = store.listProvenance({ draftId }).map((e) => e.kind)
      expect(kinds).toContain('human_takeover')
    })

    it('ui_draft exposes body, pending proposal (intent, origin, dropped) and revision metadata', async () => {
      const { draftId } = await draftWithProposal([
        { original_text: 'Hi Anna,', proposed_text: 'Hello Anna,' },
        { original_text: 'not in the body at all', proposed_text: 'x' },
      ])
      const view = await tools.ui_draft.execute(ctx, { draft_id: draftId })
      expect(view.body).toBe(AI_BODY)
      expect(view.pending_proposal.intent_text).toBe('tighten it')
      expect(view.pending_proposal.origin).toBe('chat_agent')
      expect(view.pending_proposal.dropped).toBe(1)
      expect(view.pending_proposal.hunks).toHaveLength(2) // pending + dropped, both visible
      expect(view.revisions).toHaveLength(1)
      expect(view.revisions[0].source).toBe('ai_initial')
      expect(view.revisions[0].body_text).toBeUndefined() // meta only
    })

    it('draft_revert restores an old body as a revert revision and re-anchors', async () => {
      const { draftId, proposed } = await draftWithProposal([
        { original_text: 'Hi Anna,', proposed_text: 'Hello Anna,' },
      ])
      const store = _storeForTests()
      const firstRevision = store.listRevisions(draftId)[0]
      await tools.hunk_accept.execute(ctx, { hunk_id: proposed.hunks[0].id })

      const reverted = await tools.draft_revert.execute(ctx, {
        draft_id: draftId,
        revision_id: firstRevision.id,
      })
      expect(reverted.body).toBe(AI_BODY)
      const revisions = store.listRevisions(draftId)
      expect(revisions[revisions.length - 1].source).toBe('revert')

      const fetched = await tools.revision_get.execute(ctx, { revision_id: firstRevision.id })
      expect(fetched.revision.body_text).toBe(AI_BODY)
    })
  })

  // ----- voices -----

  describe('voices surface', () => {
    it('voice_update: body edit writes a human_edit voice revision; name/description/archived patch the row', async () => {
      await backfilled()
      const store = _storeForTests()
      const voice = store.listVoices({ archived: false })[0]

      const result = await tools.voice_update.execute(ctx, {
        voice_id: voice.id,
        body_md: voice.body_md + '\n\nNever use exclamation marks.',
        name: 'Direct English',
        description: 'Client + internal',
      })
      expect(result.revision_id).toBeTruthy()
      expect(result.voice.name).toBe('Direct English')
      expect(result.voice.body_md).toContain('Never use exclamation marks.')

      const archived = await tools.voice_update.execute(ctx, {
        voice_id: voice.id,
        archived: true,
      })
      expect(archived.voice.archived).toBe(true)
      expect(store.listVoices({ archived: false })).toHaveLength(0)
      expect((await tools.voices_list.execute(ctx, {})).voices).toHaveLength(0)
    })

    it('ui_voices returns voices, pending flywheel proposals, metrics, and seed_state', async () => {
      await backfilled()
      const store = _storeForTests()
      const voice = store.listVoices({ archived: false })[0]
      // Simulate a flywheel proposal against the voice document.
      const engineHunks = [
        { original_text: 'Direct and brief.', proposed_text: 'Direct, brief, no pleasantries.' },
      ]
      ctx.ai.generateObject = async () => ({ object: { hunks: engineHunks }, modelId: 'stub' })
      // Distill needs >= 5 undistilled sends attributed to the voice.
      for (let i = 0; i < 5; i++) {
        const d = store.createDraft({ account_id: 'default', voice_id: voice.id })
        store.recordSend({
          draft_id: d.id,
          gmail_message_id: `g${i}`,
          sent_at: new Date().toISOString(),
          final_text: 'text',
          first_ai_text: 'text',
          survival_rate: 1,
          untouched: 1,
          voice_id: voice.id,
        })
      }
      const distilled = await jobs.flywheel.run(ctx)
      expect(distilled.ran).toBe(true)
      expect(distilled.proposals).toHaveLength(1)

      const view = await tools.ui_voices.execute(ctx, {})
      expect(view.voices).toHaveLength(1)
      expect(view.seed_state).toBe('ready')
      expect(view.pending_proposals).toHaveLength(1)
      expect(view.pending_proposals[0].voice_id).toBe(voice.id)
      expect(view.pending_proposals[0].origin).toBe('flywheel')
      expect(view.metrics.per_voice[0]).toMatchObject({ voice_id: voice.id, scored_sends: 5 })
      expect(view.metrics.funnel.sent).toBe(5)
    })
  })

  // ----- flywheel trigger -----

  describe('flywheel trigger', () => {
    it('draft_send kicks the flywheel job at 5 undistilled sends', async () => {
      await backfilled()
      const store = _storeForTests()
      for (let i = 1; i <= 5; i++) {
        const created = await tools.draft_create.execute(ctx, {
          to: ['client@corp.example'],
          subject: `Send ${i}`,
          instruction: 'Write it',
        })
        const draft = store.getDraft(created.draft.id)
        await tools.draft_approve.execute(ctx, {
          draft_id: draft.id,
          revision_id: draft.current_revision_id,
        })
        const sent = await tools.draft_send.execute(ctx, { draft_id: draft.id })
        expect(sent.ok).toBe(true)
        if (i < 5) {
          expect(ctx._kicked.filter((j) => j === 'flywheel')).toHaveLength(0)
        }
      }
      expect(ctx._kicked.filter((j) => j === 'flywheel')).toHaveLength(1)
      // The inline flywheel run consumed the sends (no voice attached → eaten silently).
      expect(store.undistilledSends()).toHaveLength(0)
    })
  })

  // ----- sync job -----

  describe('sync job', () => {
    it('runs incremental history sync and refreshes the kv snapshot', async () => {
      await backfilled()
      _storeForTests().updateAccount('default', { last_sync_at: '2020-01-01T00:00:00.000Z' })
      ctx._kv.set('agent_state', null)
      const result = await jobs.sync.run(ctx)
      expect(result.synced).toBe(true)
      const account = _storeForTests().getAccount('default')
      expect(account.history_id).toBe('2000')
      expect(Date.parse(account.last_sync_at)).toBeGreaterThan(Date.now() - 10_000)
      expect(ctx._kv.get('agent_state')).toMatchObject({ email: USER_EMAIL, backfill_state: 'done' })
    })

    it('declines to sync before backfill is done', async () => {
      ctx = makeCtx({ secrets: connectedSecrets() })
      expect(await jobs.sync.run(ctx)).toEqual({ synced: false, reason: 'not_connected' })
      _storeForTests().upsertAccount({ id: 'default', email: USER_EMAIL })
      const result = await jobs.sync.run(ctx)
      expect(result).toMatchObject({ synced: false, reason: 'backfill_not_done' })
    })
  })

  // ----- settings -----

  describe('settings', () => {
    it('settings_get/settings_set round-trip sync_window_days', async () => {
      ctx = makeCtx({})
      expect(await tools.settings_get.execute(ctx, {})).toEqual({ sync_window_days: 180 })
      expect(await tools.settings_set.execute(ctx, { sync_window_days: 30 })).toEqual({
        sync_window_days: 30,
      })
      expect(await tools.settings_get.execute(ctx, {})).toEqual({ sync_window_days: 30 })
    })

    it('jobs_kick validates the job id and reports start failures as {started:false}', async () => {
      ctx = makeCtx({ secrets: connectedSecrets() })
      expect((await tools.jobs_kick.execute(ctx, { job: 'nope' })).error).toMatch(/Unknown job/)
      // Happy path: seed_voices runs (and exits with thin-corpus error inside
      // the run result) — the start itself succeeded.
      const kicked = await tools.jobs_kick.execute(ctx, { job: 'seed_voices' })
      expect(kicked.started).toBe(true)
      // Failure path: backfill needs Gmail; this ctx has no fake fetch, so the
      // inline run throws and jobs_kick reports it as recoverable.
      _storeForTests().upsertAccount({ id: 'default', email: USER_EMAIL })
      const failed = await tools.jobs_kick.execute(ctx, { job: 'backfill' })
      expect(failed.started).toBe(false)
      expect(failed.reason).toBeTruthy()
    })
  })

  // ----- connect flow -----

  describe('connect flow', () => {
    it('runs the loopback + PKCE consent flow end to end with a fake server', async () => {
      const capture = {}
      _resetForTests({
        dbPath: join(tmp, 'mail.sqlite'),
        createServer: fakeCreateServerFactory(capture),
      })
      const secrets = fakeSecrets({
        google_oauth_client: JSON.stringify({
          installed: { client_id: 'test-client', client_secret: 'test-secret' },
        }),
      })
      const tokenBody = {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      }
      ctx = makeCtx({
        fetchFn: fakeFetch([
          {
            method: 'POST',
            pattern: 'oauth2.googleapis.com/token',
            handler: () => ({ status: 200, body: tokenBody }),
          },
        ]),
        secrets,
        jobMode: 'record', // record the auto-kicked backfill, don't run it
      })

      const started = await tools.connect_start.execute(ctx, {})
      expect(started.error).toBeUndefined()
      const url = new URL(started.consent_url)
      expect(url.searchParams.get('client_id')).toBe('test-client')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      const flowState = url.searchParams.get('state')

      // Second start while pending → same consent URL, no second server.
      const again = await tools.connect_start.execute(ctx, {})
      expect(again).toEqual({ consent_url: started.consent_url, already_pending: true })

      // Browser redirect hits the loopback server.
      capture.server._simulateRequest(`/?code=auth-code&state=${flowState}`)
      await vi.waitFor(() => {
        expect(secrets.get('google_oauth_tokens')).toBeTruthy()
      })
      const stored = JSON.parse(secrets.get('google_oauth_tokens'))
      expect(stored.access_token).toBe('fresh-access')

      // Completion created the account row and kicked backfill.
      await vi.waitFor(() => {
        expect(ctx._kicked).toContain('backfill')
      })
      expect(_storeForTests().getAccount('default')).toBeTruthy()

      const status = await tools.connect_status.execute(ctx, {})
      expect(status.connected).toBe(true)
      expect(status.token_ok).toBe(true)
      expect(status.backfill_state).toBe('pending')
      expect(status.seed_state).toBe('none')

      // Disconnect deletes tokens, keeps everything local.
      expect(await tools.connect_disconnect.execute(ctx, {})).toEqual({ ok: true })
      expect(secrets.get('google_oauth_tokens')).toBeNull()
      expect((await tools.connect_status.execute(ctx, {})).connected).toBe(false)
      expect(_storeForTests().getAccount('default')).toBeTruthy() // mirror kept
    })

    it('connect_start surfaces client validation errors as {error}', async () => {
      ctx = makeCtx({
        secrets: fakeSecrets({ google_oauth_client: JSON.stringify({ web: { client_id: 'x' } }) }),
      })
      const result = await tools.connect_start.execute(ctx, {})
      expect(result.error).toMatch(/Desktop app/)
      const missing = await tools.connect_start.execute(
        makeCtx({ secrets: fakeSecrets() }),
        {},
      )
      expect(missing.error).toMatch(/No OAuth client/)
    })
  })

  // ----- mounted agent -----

  describe('mail agent', () => {
    it('instructions read only the kv snapshot and describe the mailbox + gate', async () => {
      ctx = makeCtx({})
      ctx._kv.set('agent_state', {
        email: USER_EMAIL,
        backfill_state: 'done',
        last_sync_at: '2026-07-15T09:00:00.000Z',
        thread_count: 1234,
      })
      const text = agents.mail.instructions(ctx)
      expect(typeof text).toBe('string')
      expect(text).toContain(USER_EMAIL)
      expect(text).toContain('1234')
      expect(text).toContain('mail.sync')
      expect(text).toMatch(/Only the human can .*send/i)
    })

    it('instructions degrade gracefully without a snapshot', () => {
      ctx = makeCtx({})
      const text = agents.mail.instructions(ctx)
      expect(text).toContain('No mailbox snapshot yet')
    })
  })
})
