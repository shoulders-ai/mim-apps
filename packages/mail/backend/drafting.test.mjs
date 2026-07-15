import { describe, it, expect } from 'vitest'
import { createDrafting, recipientEmails, BODY_SCHEMA, HUNK_RULES } from './drafting.mjs'
import { HUNKS_SCHEMA } from './proposals.mjs'

// Minimal in-memory fake store implementing only what drafting.mjs (and the
// proposal engine it drives) calls. Mirrors real store.mjs semantics.
function makeStore() {
  const state = {
    drafts: new Map(),
    revisions: new Map(),
    proposals: new Map(),
    hunks: new Map(),
    voices: new Map(),
    threads: new Map(), // thread_id -> messages[]
    sent: [], // rows for recentSentTo: {to_json, body_text, internal_date}
    provenance: [],
    recentSentToCalls: [],
  }
  let n = 0
  const nextId = (prefix) => `${prefix}_${++n}`
  const now = () => new Date().toISOString()

  return {
    state,
    createDraft(fields = {}) {
      const draft = {
        id: nextId('draft'),
        account_id: 'acct_1',
        state: 'composing',
        current_revision_id: null,
        thread_id: null,
        voice_id: null,
        subject: null,
        to_json: '[]',
        ...fields,
      }
      state.drafts.set(draft.id, draft)
      return { ...draft }
    },
    getDraft(id) {
      const draft = state.drafts.get(id)
      return draft ? { ...draft } : null
    },
    appendRevision({ draftId, body, source, proposalId, hunkId }) {
      const draft = state.drafts.get(draftId)
      const seq = [...state.revisions.values()].filter((r) => r.draft_id === draftId).length + 1
      const revision = {
        id: nextId('rev'),
        draft_id: draftId,
        seq,
        body_text: body,
        source,
        proposal_id: proposalId ?? null,
        hunk_id: hunkId ?? null,
        created_at: now(),
      }
      state.revisions.set(revision.id, revision)
      draft.current_revision_id = revision.id
      return { ...revision }
    },
    getRevision(id) {
      const revision = state.revisions.get(id)
      return revision ? { ...revision } : null
    },
    createProposal({ hunks = [], ...fields }) {
      const proposal = { id: nextId('prop'), status: 'pending', resolved_at: null, created_at: now(), ...fields }
      state.proposals.set(proposal.id, proposal)
      for (const hunk of hunks) {
        const row = { id: nextId('hunk'), proposal_id: proposal.id, comment: null, resolved_at: null, ...hunk }
        state.hunks.set(row.id, row)
      }
      return { id: proposal.id, status: 'pending', created_at: proposal.created_at }
    },
    getProposal(id, { withHunks = false } = {}) {
      const proposal = state.proposals.get(id)
      if (!proposal) return null
      const out = { ...proposal }
      if (withHunks) {
        out.hunks = [...state.hunks.values()]
          .filter((h) => h.proposal_id === id)
          .sort((a, b) => a.seq - b.seq)
          .map((h) => ({ ...h }))
      }
      return out
    },
    pendingProposal(targetKind, targetId) {
      const matches = [...state.proposals.values()].filter(
        (p) => p.target_kind === targetKind && p.target_id === targetId && p.status === 'pending',
      )
      return matches.length ? { ...matches[matches.length - 1] } : null
    },
    getHunk(id) {
      const hunk = state.hunks.get(id)
      return hunk ? { ...hunk } : null
    },
    updateHunk(id, patch) {
      Object.assign(state.hunks.get(id), patch)
    },
    updateProposal(id, patch) {
      Object.assign(state.proposals.get(id), patch)
    },
    getVoice(id) {
      const voice = state.voices.get(id)
      return voice ? { ...voice } : null
    },
    getThreadMessages(threadId) {
      return (state.threads.get(threadId) ?? []).map((m) => ({ ...m }))
    },
    // Fake implements the contract shape literally: exact email match when
    // email is given, domain match when domain is given — so the module's own
    // email → domain fallback logic is what gets exercised.
    recentSentTo({ accountId, email, domain, limit = 3 }) {
      state.recentSentToCalls.push({ accountId, email, domain, limit })
      const rows = state.sent.filter((m) => {
        if (email) return m.to_json.includes(`"${email}"`)
        if (domain) return m.to_json.includes(`@${domain}`)
        return false
      })
      return rows.slice(0, limit)
    },
    appendProvenance({ draftId, kind, payload }) {
      state.provenance.push({
        id: state.provenance.length + 1,
        draft_id: draftId ?? null,
        ts: now(),
        kind,
        payload_json: JSON.stringify(payload ?? {}),
      })
    },
  }
}

function stubAi(responses) {
  const calls = []
  let index = 0
  return {
    calls,
    async generateObject(request) {
      calls.push(request)
      const list = Array.isArray(responses) ? responses : [responses]
      const next = list[Math.min(index++, list.length - 1)]
      if (next instanceof Error) throw next
      if (typeof next === 'function') return next(request)
      return { object: next }
    },
  }
}

const THREAD_BODY = 'Hi Paul, can you send the Q3 deck before our sync? Thanks, Anna'

function seededStore() {
  const store = makeStore()
  store.state.voices.set('voice_1', {
    id: 'voice_1',
    name: 'Client mail',
    body_md: '# Register\n\nWarm, concise, no filler.',
    current_revision_id: 'vrev_seed',
    archived: 0,
  })
  store.state.threads.set('thread_1', [
    {
      id: 'msg_1',
      from_name: 'Anna Schmidt',
      from_email: 'anna@acme.com',
      body_text: THREAD_BODY,
      internal_date: 100,
    },
  ])
  return store
}

describe('recipientEmails', () => {
  it('parses string arrays, object arrays, and garbage', () => {
    expect(recipientEmails('["anna@acme.com"]')).toEqual(['anna@acme.com'])
    expect(recipientEmails([{ email: 'bob@x.io', name: 'Bob' }, 'carl@y.de'])).toEqual(['bob@x.io', 'carl@y.de'])
    expect(recipientEmails('not json')).toEqual([])
    expect(recipientEmails(null)).toEqual([])
    expect(recipientEmails('["no-at-sign"]')).toEqual([])
  })
})

describe('initialDraft', () => {
  it('writes an ai_initial revision with ai_drafted provenance when the body is empty', async () => {
    const store = seededStore()
    const ai = stubAi({ body: 'Hi Anna,\n\nDeck attached.\n\nBest,\nPaul' })
    const drafting = createDrafting({ store, ai })
    const draft = store.createDraft({ voice_id: 'voice_1', to_json: '["anna@acme.com"]' })

    const result = await drafting.initialDraft({ draftId: draft.id, instruction: 'reply saying the deck is attached' })
    expect(result.error).toBeUndefined()
    expect(result.body).toContain('Deck attached.')

    const revision = store.getRevision(result.revision_id)
    expect(revision.source).toBe('ai_initial')
    expect(store.getDraft(draft.id).current_revision_id).toBe(result.revision_id)

    const drafted = store.state.provenance.filter((e) => e.kind === 'ai_drafted')
    expect(drafted).toHaveLength(1)
    expect(JSON.parse(drafted[0].payload_json)).toMatchObject({
      revision_id: result.revision_id,
      instruction: 'reply saying the deck is attached',
      voice_id: 'voice_1',
    })
    expect(ai.calls[0].schema).toEqual(BODY_SCHEMA)
  })

  it('refuses when the body is non-empty — the AI never overwrites', async () => {
    const store = seededStore()
    const ai = stubAi({ body: 'should never be used' })
    const drafting = createDrafting({ store, ai })
    const draft = store.createDraft({})
    store.appendRevision({ draftId: draft.id, body: 'One human sentence.', source: 'human_edit' })

    const result = await drafting.initialDraft({ draftId: draft.id, instruction: 'rewrite it' })
    expect(result.error).toMatch(/not empty/)
    expect(ai.calls).toHaveLength(0)
    expect(store.getRevision(store.getDraft(draft.id).current_revision_id).body_text).toBe('One human sentence.')
  })

  it('allows an empty-string current revision (still an empty body)', async () => {
    const store = seededStore()
    const ai = stubAi({ body: 'Hello.' })
    const drafting = createDrafting({ store, ai })
    const draft = store.createDraft({})
    store.appendRevision({ draftId: draft.id, body: '', source: 'human_edit' })

    const result = await drafting.initialDraft({ draftId: draft.id, instruction: 'say hello' })
    expect(result.error).toBeUndefined()
    expect(result.body).toBe('Hello.')
  })

  it('returns {error} on model failure or empty body without writing a revision', async () => {
    const store = seededStore()
    const drafting = createDrafting({ store, ai: stubAi(new Error('rate limited')) })
    const draft = store.createDraft({})
    const result = await drafting.initialDraft({ draftId: draft.id, instruction: 'x' })
    expect(result.error).toMatch(/rate limited/)
    expect(store.getDraft(draft.id).current_revision_id).toBeNull()

    const blank = createDrafting({ store, ai: stubAi({ body: '   ' }) })
    const result2 = await blank.initialDraft({ draftId: draft.id, instruction: 'x' })
    expect(result2.error).toMatch(/no draft body/)
    expect(store.getDraft(draft.id).current_revision_id).toBeNull()
  })

  it('errors on unknown drafts', async () => {
    const drafting = createDrafting({ store: seededStore(), ai: stubAi({ body: 'x' }) })
    expect((await drafting.initialDraft({ draftId: 'nope', instruction: 'x' })).error).toMatch(/unknown draft/)
  })
})

const DRAFT_BODY = 'Hi Anna,\n\nThe deck is attached.\n\nBest,\nPaul'

function composedDraft(store, fields = {}) {
  const draft = store.createDraft({
    voice_id: 'voice_1',
    thread_id: 'thread_1',
    to_json: '["anna@acme.com"]',
    subject: 'Q3 deck',
    ...fields,
  })
  store.appendRevision({ draftId: draft.id, body: DRAFT_BODY, source: 'human_edit' })
  return store.getDraft(draft.id)
}

describe('propose — context assembly (CONTRACTS §8.3)', () => {
  it('assembles voice + thread + recipient exemplars + numbered body + intent + scope', async () => {
    const store = seededStore()
    store.state.sent.push({
      to_json: '[{"email":"anna@acme.com","name":"Anna"}]',
      body_text: 'Hi Anna, quick one: numbers look good. Best, Paul',
      internal_date: 90,
    })
    const ai = stubAi({ hunks: [{ original_text: 'The deck is attached.', proposed_text: 'Deck attached — v3.' }] })
    const drafting = createDrafting({ store, ai })
    const draft = composedDraft(store)

    const result = await drafting.propose({
      draftId: draft.id,
      intent: 'mention it is version 3',
      paragraphs: [2],
      origin: 'chat_agent',
    })
    expect(result.error).toBeUndefined()

    expect(ai.calls).toHaveLength(1)
    const { system, prompt, schema } = ai.calls[0]
    // Schema is the exact §8 adapter shape.
    expect(schema).toEqual(HUNKS_SCHEMA)
    // Voice document.
    expect(prompt).toContain('## Voice: Client mail')
    expect(prompt).toContain('Warm, concise, no filler.')
    // Thread context.
    expect(prompt).toContain(THREAD_BODY)
    // Recipient exemplars (exact email match).
    expect(prompt).toContain('numbers look good')
    // Paragraph-numbered draft body.
    expect(prompt).toContain('[paragraph 1]\nHi Anna,')
    expect(prompt).toContain('[paragraph 2]\nThe deck is attached.')
    // Intent and scope instruction.
    expect(prompt).toContain('mention it is version 3')
    expect(prompt).toContain('paragraph(s) 2')
    // The load-bearing prompt rules (§4.7).
    expect(system).toContain('character-for-character')
    expect(system).toContain('never span a blank line')
    expect(system).toContain('at most one hunk per paragraph')
    expect(system).toContain('unchanged paragraphs get no hunk')
    expect(system).toContain('merge two paragraphs')
    expect(system).toContain('proposed_text ""')
    expect(system).toContain('replace a span of an adjacent paragraph')
    expect(system).toContain(HUNK_RULES)
  })

  it('falls back to domain exemplars when the exact recipient has none', async () => {
    const store = seededStore()
    store.state.sent.push({
      to_json: '[{"email":"someone.else@acme.com"}]',
      body_text: 'Hallo team, hier der Bericht. Viele Grüße, Paul',
      internal_date: 80,
    })
    const ai = stubAi({ hunks: [] })
    const drafting = createDrafting({ store, ai })
    const draft = composedDraft(store)

    await drafting.propose({ draftId: draft.id, intent: 'x' })
    expect(store.state.recentSentToCalls).toEqual([
      { accountId: 'acct_1', email: 'anna@acme.com', domain: undefined, limit: 3 },
      { accountId: 'acct_1', email: undefined, domain: 'acme.com', limit: 3 },
    ])
    expect(ai.calls[0].prompt).toContain('hier der Bericht')
  })

  it('points at voice exemplars when neither recipient nor domain has history', async () => {
    const store = seededStore()
    const ai = stubAi({ hunks: [] })
    const drafting = createDrafting({ store, ai })
    const draft = composedDraft(store)

    await drafting.propose({ draftId: draft.id, intent: 'x' })
    expect(ai.calls[0].prompt).toContain("mirror the voice document's exemplars")
  })

  it('omits scope restriction wording when no paragraphs are given', async () => {
    const store = seededStore()
    const ai = stubAi({ hunks: [] })
    const drafting = createDrafting({ store, ai })
    const draft = composedDraft(store)
    await drafting.propose({ draftId: draft.id, intent: 'x' })
    expect(ai.calls[0].prompt).toContain('Any paragraph may be edited')
    expect(ai.calls[0].prompt).not.toContain('Only propose changes inside')
  })
})

describe('propose — proposal creation', () => {
  it('validates model hunks and reports pending hunks plus the dropped count', async () => {
    const store = seededStore()
    const ai = stubAi({
      hunks: [
        { original_text: 'The deck is attached.', proposed_text: 'Deck v3 attached.', note: 'version' },
        { original_text: 'not in the draft at all', proposed_text: 'x' },
      ],
    })
    const drafting = createDrafting({ store, ai })
    const draft = composedDraft(store)

    const result = await drafting.propose({ draftId: draft.id, intent: 'v3', origin: 'user_request' })
    expect(result.status).toBe('pending')
    expect(result.dropped).toBe(1)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]).toMatchObject({
      original_text: 'The deck is attached.',
      proposed_text: 'Deck v3 attached.',
      note: 'version',
    })
    expect(result.hunks[0].id).toBeTruthy()

    const stored = store.getProposal(result.proposal_id, { withHunks: true })
    expect(stored).toMatchObject({ origin: 'user_request', intent_text: 'v3', target_id: draft.id })
    expect(stored.hunks).toHaveLength(2)
  })

  it('passes scope through to validation: out-of-scope hunks are dropped', async () => {
    const store = seededStore()
    const ai = stubAi({
      hunks: [{ original_text: 'Hi Anna,', proposed_text: 'Dear Anna,' }],
    })
    const drafting = createDrafting({ store, ai })
    const draft = composedDraft(store)

    const result = await drafting.propose({ draftId: draft.id, intent: 'x', paragraphs: [2] })
    expect(result.dropped).toBe(1)
    expect(result.status).toBe('invalidated')
    expect(result.error).toMatch(/anchored/)
    expect(store.getProposal(result.proposal_id).scope_json).toBe('[2]')
  })

  it('records an invalidated proposal and returns {error} when the model throws', async () => {
    const store = seededStore()
    const drafting = createDrafting({ store, ai: stubAi(new Error('overloaded')) })
    const draft = composedDraft(store)

    const result = await drafting.propose({ draftId: draft.id, intent: 'x' })
    expect(result.error).toMatch(/overloaded/)
    expect(result.proposal_id).toBeTruthy()
    expect(store.getProposal(result.proposal_id).status).toBe('invalidated')
    // The draft itself is untouched.
    expect(store.getRevision(store.getDraft(draft.id).current_revision_id).body_text).toBe(DRAFT_BODY)
  })

  it('treats a malformed model payload (no hunks array) as a failure, not a throw', async () => {
    const store = seededStore()
    const drafting = createDrafting({ store, ai: stubAi({ nothing: true }) })
    const draft = composedDraft(store)

    const result = await drafting.propose({ draftId: draft.id, intent: 'x' })
    expect(result.error).toMatch(/no hunks array/)
    expect(store.getProposal(result.proposal_id).status).toBe('invalidated')
  })

  it('refuses to propose against an empty draft body', async () => {
    const store = seededStore()
    const ai = stubAi({ hunks: [] })
    const drafting = createDrafting({ store, ai })
    const draft = store.createDraft({})
    const result = await drafting.propose({ draftId: draft.id, intent: 'x' })
    expect(result.error).toMatch(/empty/)
    expect(ai.calls).toHaveLength(0)
  })

  it('errors on unknown drafts', async () => {
    const drafting = createDrafting({ store: seededStore(), ai: stubAi({ hunks: [] }) })
    expect((await drafting.propose({ draftId: 'nope', intent: 'x' })).error).toMatch(/unknown draft/)
  })
})
