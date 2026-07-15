import { describe, it, expect } from 'vitest'
import {
  createProposals,
  applyToBody,
  paragraphSpans,
  splitParagraphs,
  numberParagraphs,
  HUNKS_SCHEMA,
  nfc,
} from './proposals.mjs'

// Minimal in-memory fake store implementing only what proposals.mjs calls,
// mirroring the real store.mjs semantics (createProposal returns meta only
// and always creates status 'pending'; getters return copies; createVoice
// writes the seed revision itself). Not shared with other agents per §9.
function makeStore() {
  const state = {
    drafts: new Map(),
    revisions: new Map(),
    proposals: new Map(),
    hunks: new Map(),
    voices: new Map(),
    voiceRevisions: new Map(),
    provenance: [],
  }
  let n = 0
  const nextId = (prefix) => `${prefix}_${++n}`
  const now = () => new Date().toISOString()

  const store = {
    state,
    createDraft(fields = {}) {
      const draft = {
        id: nextId('draft'),
        account_id: 'acct_1',
        state: 'composing',
        current_revision_id: null,
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
      const proposal = {
        id: nextId('prop'),
        status: 'pending',
        resolved_at: null,
        created_at: now(),
        ...fields,
      }
      state.proposals.set(proposal.id, proposal)
      for (const hunk of hunks) {
        const row = {
          id: nextId('hunk'),
          proposal_id: proposal.id,
          comment: null,
          resolved_at: null,
          ...hunk,
        }
        state.hunks.set(row.id, row)
      }
      return { id: proposal.id, target_kind: proposal.target_kind, target_id: proposal.target_id, status: 'pending', created_at: proposal.created_at }
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
    createVoice({ name, description, body_md }) {
      const voice = {
        id: nextId('voice'),
        name,
        description: description ?? null,
        body_md,
        current_revision_id: null,
        archived: 0,
      }
      state.voices.set(voice.id, voice)
      // Real store creates the seed revision inside createVoice.
      store.appendVoiceRevision({ voiceId: voice.id, body: body_md, source: 'seed' })
      return store.getVoice(voice.id)
    },
    getVoice(id) {
      const voice = state.voices.get(id)
      return voice ? { ...voice } : null
    },
    appendVoiceRevision({ voiceId, body, source, proposalId }) {
      const voice = state.voices.get(voiceId)
      const seq = [...state.voiceRevisions.values()].filter((r) => r.voice_id === voiceId).length + 1
      const revision = {
        id: nextId('vrev'),
        voice_id: voiceId,
        seq,
        body_md: body,
        source,
        proposal_id: proposalId ?? null,
        created_at: now(),
      }
      state.voiceRevisions.set(revision.id, revision)
      voice.body_md = body
      voice.current_revision_id = revision.id
      return { ...revision }
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
    listProvenance({ draftId } = {}) {
      return state.provenance
        .filter((e) => draftId === undefined || e.draft_id === draftId)
        .map((e) => ({ ...e }))
    },
  }
  return store
}

const BODY = 'Hi Anna,\n\nThanks for the update on the Q3 numbers.\n\nCould we move the review to Thursday?\n\nBest,\nPaul'

function makeDraft(store, body = BODY) {
  const draft = store.createDraft({})
  store.appendRevision({ draftId: draft.id, body, source: 'human_edit' })
  return store.getDraft(draft.id)
}

function propose(engine, draftId, rawHunks, extra = {}) {
  return engine.validateAndCreate({
    targetKind: 'draft',
    targetId: draftId,
    intent: 'test intent',
    scope: null,
    origin: 'chat_agent',
    modelId: 'model-x',
    rawHunks,
    ...extra,
  })
}

function events(store, kind) {
  return store.state.provenance.filter((e) => e.kind === kind)
}

describe('paragraph semantics', () => {
  it('splits on 2+ newlines with 1-based indexing intact across separators of any size', () => {
    const body = 'one\n\ntwo\n\n\n\nthree'
    expect(splitParagraphs(body)).toEqual(['one', 'two', 'three'])
    const spans = paragraphSpans(body)
    expect(spans).toHaveLength(3)
    expect(body.slice(spans[1].start, spans[1].end)).toBe('two')
    expect(body.slice(spans[2].start, spans[2].end)).toBe('three')
  })

  it('keeps empty leading/trailing paragraphs, matching String.split', () => {
    const body = '\n\nreal text\n\n'
    expect(splitParagraphs(body)).toEqual(['', 'real text', ''])
    const spans = paragraphSpans(body)
    expect(spans).toHaveLength(3)
    expect(spans[0]).toEqual({ start: 0, end: 0 })
  })

  it('numberParagraphs labels 1-based', () => {
    expect(numberParagraphs('a\n\nb')).toBe('[paragraph 1]\na\n\n[paragraph 2]\nb')
  })
})

describe('HUNKS_SCHEMA', () => {
  it('matches the CONTRACTS §8 adapter shape exactly', () => {
    expect(HUNKS_SCHEMA).toEqual({
      type: 'object',
      properties: {
        hunks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              original_text: { type: 'string' },
              proposed_text: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['original_text', 'proposed_text'],
          },
        },
      },
      required: ['hunks'],
    })
  })
})

describe('applyToBody (pure)', () => {
  it('replaces a unique span', () => {
    expect(applyToBody('ab cd ef', { original_text: 'cd', proposed_text: 'XY' })).toBe('ab XY ef')
  })

  it('throws no_match / ambiguous / empty', () => {
    expect(() => applyToBody('abc', { original_text: 'zz', proposed_text: '' })).toThrow('no_match')
    expect(() => applyToBody('x y x', { original_text: 'x', proposed_text: 'z' })).toThrow('ambiguous')
    expect(() => applyToBody('abc', { original_text: '', proposed_text: 'z' })).toThrow('empty')
  })

  it('counts overlapping occurrences as ambiguous', () => {
    expect(() => applyToBody('aaa', { original_text: 'aa', proposed_text: 'b' })).toThrow('ambiguous')
  })

  it('collapses the seam to two newlines when deleting a whole paragraph', () => {
    expect(applyToBody('A\n\nB\n\nC', { original_text: 'B', proposed_text: '' })).toBe('A\n\nC')
  })

  it('leaves seams under three newlines alone', () => {
    expect(applyToBody('A\nB\nC', { original_text: 'B', proposed_text: '' })).toBe('A\n\nC')
  })

  it('matches NFC-decomposed hunks against composed bodies', () => {
    const composed = 'Café tomorrow?'
    const decomposed = 'Café tomorrow?'
    expect(applyToBody(composed, { original_text: decomposed, proposed_text: 'Tea instead.' })).toBe('Tea instead.')
  })
})

describe('validateAndCreate — anchoring nasty cases', () => {
  it('creates a pending proposal with 1-based paragraph_index on each hunk', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(engine, draft.id, [
      {
        original_text: 'Thanks for the update on the Q3 numbers.',
        proposed_text: 'Thanks for sending the Q3 numbers over.',
        note: 'tighter',
      },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    expect(dropped).toBe(0)
    expect(proposal.status).toBe('pending')
    expect(proposal.base_revision_id).toBe(store.getDraft(draft.id).current_revision_id)
    expect(proposal.hunks.map((h) => [h.status, h.paragraph_index])).toEqual([
      ['pending', 2],
      ['pending', 3],
    ])
    expect(events(store, 'proposal_created')).toHaveLength(1)
    expect(events(store, 'hunks_dropped')).toHaveLength(0)
  })

  it('drops empty original_text with drop_reason empty', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(engine, draft.id, [
      { original_text: '', proposed_text: 'anything' },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    expect(dropped).toBe(1)
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'empty' })
    expect(proposal.hunks[1].status).toBe('pending')
  })

  it('drops unmatched text with no_match', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'this text is nowhere', proposed_text: 'x' },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'no_match' })
  })

  it('drops repeated sentences as ambiguous', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, 'Thanks again.\n\nSee you soon.\n\nThanks again.')
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thanks again.', proposed_text: 'Cheers.' },
    ])
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'ambiguous' })
    expect(proposal.status).toBe('invalidated')
  })

  it('matches decomposed unicode against composed body text (NFC)', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, 'Hallo René,\n\nbis Donnerstag.')
    const { proposal, dropped } = propose(engine, draft.id, [
      { original_text: 'René', proposed_text: 'Renée' },
    ])
    expect(dropped).toBe(0)
    expect(proposal.hunks[0].status).toBe('pending')
    // Stored hunk text is NFC-normalized so later byte-exact matching holds.
    expect(proposal.hunks[0].original_text).toBe('René')
  })

  it('does NOT match NBSP against a regular space — byte-exact after NFC', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, 'See you at 9 am.')
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'at 9 am', proposed_text: 'at 10 am' },
    ])
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'no_match' })
  })

  it('drops a hunk spanning a blank line with crosses_paragraphs', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      {
        original_text: 'the Q3 numbers.\n\nCould we move',
        proposed_text: 'the Q3 numbers. Could we move',
      },
    ])
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'crosses_paragraphs' })
  })

  it('single newlines inside a paragraph do not cross paragraphs', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(engine, draft.id, [
      { original_text: 'Best,\nPaul', proposed_text: 'Cheers,\nPaul' },
    ])
    expect(dropped).toBe(0)
    expect(proposal.hunks[0].paragraph_index).toBe(4)
  })

  it('rejects the later-positioned of two overlapping hunks regardless of input order', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    // Input order deliberately puts the later-positioned hunk first: the
    // overlap rule sorts by match position, not input order (§4.3d).
    const { proposal, dropped } = propose(engine, draft.id, [
      { original_text: 'update on the Q3', proposed_text: 'note about the Q3' },
      { original_text: 'the update on the Q3 numbers', proposed_text: 'the fresh Q3 numbers' },
    ])
    expect(dropped).toBe(1)
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'overlap' })
    expect(proposal.hunks[1].status).toBe('pending')
  })

  it('invalidates the proposal when every hunk drops and logs one hunks_dropped event', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(engine, draft.id, [
      { original_text: 'nope', proposed_text: 'x' },
      { original_text: '', proposed_text: 'y' },
    ])
    expect(dropped).toBe(2)
    expect(proposal.status).toBe('invalidated')
    expect(proposal.hunks.map((h) => h.drop_reason)).toEqual(['no_match', 'empty'])
    const droppedEvents = events(store, 'hunks_dropped')
    expect(droppedEvents).toHaveLength(1)
    expect(JSON.parse(droppedEvents[0].payload_json).dropped).toEqual([
      { seq: 1, drop_reason: 'no_match' },
      { seq: 2, drop_reason: 'empty' },
    ])
  })

  it('creates an invalidated, hunk-less proposal from an empty rawHunks list (model-failure path)', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(engine, draft.id, [])
    expect(dropped).toBe(0)
    expect(proposal.status).toBe('invalidated')
    expect(proposal.hunks).toEqual([])
    expect(events(store, 'hunks_dropped')).toHaveLength(0)
  })

  it('returns {error} for unknown targets and drafts without revisions', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    expect(propose(engine, 'missing', []).error).toMatch(/unknown draft/)
    const empty = store.createDraft({})
    expect(propose(engine, empty.id, []).error).toMatch(/no revision/)
  })
})

describe('validateAndCreate — scope', () => {
  const SCOPED = 'Same line here.\n\nUnique target line.\n\nSame line here.'

  it('drops hunks that match only outside the scope with no_match', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    // 'Thursday' lives in paragraph 3; scope restricts to paragraph 2.
    const { proposal } = propose(engine, draft.id, [{ original_text: 'Thursday', proposed_text: 'Friday' }], {
      scope: [2],
    })
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'no_match' })
    expect(proposal.scope_json).toBe('[2]')
  })

  it('scope indices are 1-based: scope [1] anchors in the first paragraph', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(
      engine,
      draft.id,
      [{ original_text: 'Hi Anna,', proposed_text: 'Dear Anna,' }],
      { scope: [1] },
    )
    expect(dropped).toBe(0)
    expect(proposal.hunks[0].paragraph_index).toBe(1)
  })

  it('a hunk duplicated outside scope is ambiguous even when unique within scope (§4.3b ruling)', () => {
    // Ratified post-Wave-1: uniqueness is whole-body because acceptance
    // re-locates by unique whole-body match — a scope-locally-unique hunk
    // with an outside duplicate would validate and then instantly stale on
    // accept with zero intervening edits.
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, SCOPED)
    const { proposal, dropped } = propose(
      engine,
      draft.id,
      [{ original_text: 'Same line here.', proposed_text: 'Changed line.' }],
      { scope: [1] },
    )
    expect(dropped).toBe(1)
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'ambiguous' })
  })

  it('regression: an outside duplicate drops at creation — never accepted-then-stale', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, SCOPED)
    const { proposal } = propose(
      engine,
      draft.id,
      [{ original_text: 'Same line here.', proposed_text: 'Changed line.' }],
      { scope: [1] },
    )
    // Dropped at creation: nothing pending, proposal invalidated outright.
    expect(proposal.status).toBe('invalidated')
    const hunk = proposal.hunks[0]
    expect(hunk.status).toBe('dropped')
    // Accepting the dropped hunk is refused as immutable — it never reaches
    // the anchors-no-longer-hold ("marked stale") failure path.
    const result = engine.acceptHunk(hunk.id)
    expect(result.error).toMatch(/dropped/)
    expect(result.error).not.toMatch(/no longer anchors/)
    expect(store.getHunk(hunk.id).status).toBe('dropped')
    // The body was never touched.
    expect(store.getRevision(store.getDraft(draft.id).current_revision_id).body_text).toBe(SCOPED)
  })

  it('the same hunk without scope is ambiguous', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, SCOPED)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Same line here.', proposed_text: 'Changed line.' },
    ])
    expect(proposal.hunks[0]).toMatchObject({ status: 'dropped', drop_reason: 'ambiguous' })
  })

  it('invariant: a hunk that survives creation is acceptable against an unchanged body', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store, SCOPED)
    const { proposal, dropped } = propose(
      engine,
      draft.id,
      [{ original_text: 'Unique target line.', proposed_text: 'Rewritten line.' }],
      { scope: [2] },
    )
    expect(dropped).toBe(0)
    const result = engine.acceptHunk(proposal.hunks[0].id)
    expect(result.error).toBeUndefined()
    expect(result.body).toContain('Rewritten line.')
  })

  it('an empty scope array means all paragraphs, like absent scope', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal, dropped } = propose(
      engine,
      draft.id,
      [{ original_text: 'Thursday', proposed_text: 'Friday' }],
      { scope: [] },
    )
    expect(dropped).toBe(0)
    expect(proposal.scope_json).toBeNull()
  })
})

describe('acceptHunk', () => {
  it('applies the hunk, appends a proposal_accept revision with provenance, and resolves the proposal', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    const hunkId = proposal.hunks[0].id

    const result = engine.acceptHunk(hunkId)
    expect(result.error).toBeUndefined()
    expect(result.body).toContain('Friday')
    expect(result.body).not.toContain('Thursday')
    expect(result.hunk_changes).toEqual([{ hunk_id: hunkId, status: 'accepted' }])

    const revision = store.getRevision(result.revision_id)
    expect(revision).toMatchObject({ source: 'proposal_accept', proposal_id: proposal.id, hunk_id: hunkId })
    expect(store.getDraft(draft.id).current_revision_id).toBe(result.revision_id)

    expect(store.getHunk(hunkId).status).toBe('accepted')
    expect(store.getProposal(proposal.id).status).toBe('resolved')
    const accepted = events(store, 'hunk_accepted')
    expect(accepted).toHaveLength(1)
    expect(JSON.parse(accepted[0].payload_json)).toMatchObject({ proposal_id: proposal.id, hunk_id: hunkId })
  })

  it('deleting a whole paragraph collapses the seam to a single blank line', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Could we move the review to Thursday?', proposed_text: '' },
    ])
    const result = engine.acceptHunk(proposal.hunks[0].id)
    expect(result.body).toBe('Hi Anna,\n\nThanks for the update on the Q3 numbers.\n\nBest,\nPaul')
  })

  it('accepting one hunk stales a sibling whose anchor becomes ambiguous (accept-then-re-anchor)', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      {
        original_text: 'Thanks for the update on the Q3 numbers.',
        // Introduces a second 'Thursday' → the sibling hunk's anchor is no
        // longer unique in the new body.
        proposed_text: 'Thursday works better for the Q3 numbers.',
      },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    const [first, second] = proposal.hunks
    const result = engine.acceptHunk(first.id)
    expect(result.hunk_changes).toEqual([
      { hunk_id: first.id, status: 'accepted' },
      { hunk_id: second.id, status: 'stale' },
    ])
    expect(store.getHunk(second.id).status).toBe('stale')
    // accepted + stale → nothing pending → resolved.
    expect(store.getProposal(proposal.id).status).toBe('resolved')
  })

  it('keeps siblings pending when their anchors still hold after an accept', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Hi Anna,', proposed_text: 'Dear Anna,' },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    const [first, second] = proposal.hunks
    const result = engine.acceptHunk(first.id)
    expect(result.hunk_changes).toEqual([{ hunk_id: first.id, status: 'accepted' }])
    expect(store.getHunk(second.id).status).toBe('pending')
    expect(store.getProposal(proposal.id).status).toBe('pending')

    const final = engine.acceptHunk(second.id)
    expect(final.body).toBe(
      'Dear Anna,\n\nThanks for the update on the Q3 numbers.\n\nCould we move the review to Thursday?'.replace(
        'Thursday',
        'Friday',
      ) + '\n\nBest,\nPaul',
    )
    expect(store.getProposal(proposal.id).status).toBe('resolved')
  })

  it('defensively stales a pending hunk whose anchor was destroyed without a re-anchor pass', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    // Human edit removes the anchor; simulate a missed re-anchor pass.
    store.appendRevision({ draftId: draft.id, body: 'Hi Anna,\n\nAll rewritten.', source: 'human_edit' })
    const result = engine.acceptHunk(proposal.hunks[0].id)
    expect(result.error).toMatch(/no longer anchors/)
    expect(store.getHunk(proposal.hunks[0].id).status).toBe('stale')
    expect(store.getProposal(proposal.id).status).toBe('resolved')
    // The failed accept must not have written a revision.
    expect(store.getDraft(draft.id).current_revision_id).toBe(
      [...store.state.revisions.values()].find((r) => r.source === 'human_edit' && r.body_text === 'Hi Anna,\n\nAll rewritten.').id,
    )
  })

  it('refuses non-pending hunks and hunks of non-pending proposals (immutability)', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
      { original_text: 'nope nope', proposed_text: 'x' },
    ])
    const [pendingHunk, droppedHunk] = proposal.hunks
    expect(engine.acceptHunk(droppedHunk.id).error).toMatch(/dropped/)
    engine.acceptHunk(pendingHunk.id)
    expect(engine.acceptHunk(pendingHunk.id).error).toMatch(/accepted/)
    expect(engine.rejectHunk(pendingHunk.id, 'late comment').error).toMatch(/accepted/)
    expect(engine.acceptHunk('hunk_missing').error).toMatch(/unknown hunk/)
  })
})

describe('rejectHunk', () => {
  it('marks rejected, stores the comment verbatim, and logs hunk_rejected provenance', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    const hunkId = proposal.hunks[0].id
    const comment = '  Too pushy — Anna hates rescheduling. Keep "Thursday"!  '

    const result = engine.rejectHunk(hunkId, comment)
    expect(result.ok).toBe(true)
    expect(store.getHunk(hunkId)).toMatchObject({ status: 'rejected', comment })
    const rejected = events(store, 'hunk_rejected')
    expect(rejected).toHaveLength(1)
    // Verbatim: no trimming, no normalization.
    expect(JSON.parse(rejected[0].payload_json).comment).toBe(comment)
    expect(store.getProposal(proposal.id).status).toBe('resolved')
    // Reject never writes a revision.
    expect(store.getRevision(store.getDraft(draft.id).current_revision_id).source).toBe('human_edit')
  })

  it('reject without a comment omits the comment key from provenance', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    engine.rejectHunk(proposal.hunks[0].id)
    const payload = JSON.parse(events(store, 'hunk_rejected')[0].payload_json)
    expect('comment' in payload).toBe(false)
  })
})

describe('reanchor (§4.5)', () => {
  it('stales pending hunks whose anchor disappears after a human edit', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Hi Anna,', proposed_text: 'Dear Anna,' },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    store.appendRevision({
      draftId: draft.id,
      body: 'Hi Anna,\n\nThanks for the update on the Q3 numbers.\n\nCould we move the review to next week?\n\nBest,\nPaul',
      source: 'human_edit',
    })
    const result = engine.reanchor('draft', draft.id)
    expect(result.hunk_changes).toEqual([{ hunk_id: proposal.hunks[1].id, status: 'stale' }])
    expect(store.getHunk(proposal.hunks[0].id).status).toBe('pending')
    expect(store.getProposal(proposal.id).status).toBe('pending')
  })

  it('stales hunks whose anchor becomes duplicated anywhere in the body — scope is never re-mapped', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(
      engine,
      draft.id,
      [{ original_text: 'Thursday', proposed_text: 'Friday' }],
      { scope: [3] },
    )
    // Human edit inserts another 'Thursday' into paragraph 1 — outside the
    // creation scope, but re-anchoring is against the ENTIRE body.
    store.appendRevision({
      draftId: draft.id,
      body: 'Hi Anna, about Thursday:\n\nThanks for the update on the Q3 numbers.\n\nCould we move the review to Thursday?\n\nBest,\nPaul',
      source: 'human_edit',
    })
    const result = engine.reanchor('draft', draft.id)
    expect(result.hunk_changes).toEqual([{ hunk_id: proposal.hunks[0].id, status: 'stale' }])
    expect(store.getProposal(proposal.id).status).toBe('resolved')
  })

  it('is a no-op when anchors hold or nothing is pending', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    expect(engine.reanchor('draft', draft.id).hunk_changes).toEqual([])
    expect(store.getHunk(proposal.hunks[0].id).status).toBe('pending')
    engine.dismiss(proposal.id)
    expect(engine.reanchor('draft', draft.id).hunk_changes).toEqual([])
  })
})

describe('supersede chain (comment-revise, §4.6)', () => {
  it('a new valid proposal supersedes the pending predecessor and stales its pending hunks', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const first = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ]).proposal

    const second = propose(
      engine,
      draft.id,
      [{ original_text: 'Hi Anna,', proposed_text: 'Hello Anna,' }],
      { intent: 'make it warmer — test intent' },
    ).proposal

    expect(store.getProposal(first.id).status).toBe('superseded')
    expect(store.getHunk(first.hunks[0].id).status).toBe('stale')
    expect(second.status).toBe('pending')
    expect(second.intent_text).toBe('make it warmer — test intent')

    // Chain a third: the second is superseded in turn.
    const third = propose(engine, draft.id, [
      { original_text: 'Best,\nPaul', proposed_text: 'Thanks,\nPaul' },
    ]).proposal
    expect(store.getProposal(second.id).status).toBe('superseded')
    expect(third.status).toBe('pending')
  })

  it('an invalidated proposal supersedes nothing', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const first = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ]).proposal
    const failed = propose(engine, draft.id, [{ original_text: 'nope', proposed_text: 'x' }]).proposal
    expect(failed.status).toBe('invalidated')
    expect(store.getProposal(first.id).status).toBe('pending')
    expect(store.getHunk(first.hunks[0].id).status).toBe('pending')
  })
})

describe('dismiss (§4.6)', () => {
  it('plain dismiss stales pending hunks and logs proposal_dismissed, never human_takeover', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Hi Anna,', proposed_text: 'Dear Anna,' },
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    const result = engine.dismiss(proposal.id)
    expect(result).toEqual({ ok: true, dismissed: 2 })
    expect(store.getProposal(proposal.id).status).toBe('dismissed')
    for (const hunk of proposal.hunks) expect(store.getHunk(hunk.id).status).toBe('stale')
    expect(events(store, 'human_takeover')).toHaveLength(0)
    const dismissedEvents = events(store, 'proposal_dismissed')
    expect(dismissedEvents).toHaveLength(1)
    expect(dismissedEvents[0].draft_id).toBe(draft.id)
    expect(JSON.parse(dismissedEvents[0].payload_json)).toEqual({
      proposal_id: proposal.id,
      hunks_dismissed: 2,
    })
  })

  it('takeover dismissal records human_takeover provenance, not proposal_dismissed', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    const result = engine.dismiss(proposal.id, { takeover: true })
    expect(result.ok).toBe(true)
    expect(events(store, 'proposal_dismissed')).toHaveLength(0)
    const takeovers = events(store, 'human_takeover')
    expect(takeovers).toHaveLength(1)
    expect(takeovers[0].draft_id).toBe(draft.id)
    expect(JSON.parse(takeovers[0].payload_json)).toEqual({
      proposal_id: proposal.id,
      hunks_dismissed: 1,
    })
  })

  it('refuses to dismiss non-pending proposals', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const draft = makeDraft(store)
    const { proposal } = propose(engine, draft.id, [
      { original_text: 'Thursday', proposed_text: 'Friday' },
    ])
    engine.dismiss(proposal.id)
    expect(engine.dismiss(proposal.id).error).toMatch(/dismissed/)
    expect(engine.dismiss('prop_missing').error).toMatch(/unknown proposal/)
  })
})

describe('voice targets — same paragraph semantics', () => {
  it('validates, accepts, and re-anchors against voice documents via appendVoiceRevision', () => {
    const store = makeStore()
    const engine = createProposals({ store })
    const voice = store.createVoice({
      name: 'Client mail',
      description: 'warm',
      body_md: '# Register\n\nWarm but concise.\n\n# Sign-off\n\nAlways "Best, Paul".',
    })

    const { proposal, dropped } = engine.validateAndCreate({
      targetKind: 'voice',
      targetId: voice.id,
      intent: 'Lessons from recent sends',
      scope: null,
      origin: 'flywheel',
      modelId: null,
      rawHunks: [
        { original_text: 'Warm but concise.', proposed_text: 'Warm but concise. Never open with pleasantries.' },
      ],
    })
    expect(dropped).toBe(0)
    expect(proposal.origin).toBe('flywheel')
    expect(proposal.base_revision_id).toBe(voice.current_revision_id)
    // Voice-target provenance carries no draft id.
    expect(events(store, 'proposal_created')[0].draft_id).toBeNull()

    const result = engine.acceptHunk(proposal.hunks[0].id)
    expect(result.error).toBeUndefined()
    const updated = store.getVoice(voice.id)
    expect(updated.body_md).toContain('Never open with pleasantries.')
    expect(updated.current_revision_id).toBe(result.revision_id)
    const revision = store.state.voiceRevisions.get(result.revision_id)
    expect(revision).toMatchObject({ source: 'proposal_accept', proposal_id: proposal.id })
    expect(store.getProposal(proposal.id).status).toBe('resolved')
  })
})

describe('nfc helper', () => {
  it('normalizes strings and passes non-strings through', () => {
    expect(nfc('Café')).toBe('Café')
    expect(nfc(null)).toBeNull()
    expect(nfc(3)).toBe(3)
  })
})
