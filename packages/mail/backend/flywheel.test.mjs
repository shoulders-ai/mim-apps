import { describe, it, expect } from 'vitest'
import { createFlywheel } from './flywheel.mjs'
import { HUNKS_SCHEMA } from './proposals.mjs'

// Minimal fake store implementing what flywheel.mjs and the proposal engine
// it drives call. Mirrors real store.mjs semantics.
function makeStore() {
  const state = {
    sends: [], // {draft_id, voice_id, first_ai_text, final_text, distilled}
    voices: new Map(),
    voiceRevisions: new Map(),
    proposals: new Map(),
    hunks: new Map(),
    provenance: [],
    markDistilledCalls: [],
  }
  let n = 0
  const nextId = (prefix) => `${prefix}_${++n}`
  const now = () => new Date().toISOString()

  return {
    state,
    undistilledSends() {
      return state.sends.filter((s) => !s.distilled).map((s) => ({ ...s }))
    },
    markDistilled(draftIds) {
      state.markDistilledCalls.push([...draftIds])
      for (const send of state.sends) {
        if (draftIds.includes(send.draft_id)) send.distilled = 1
      }
    },
    voiceMetrics() {
      return {
        per_voice: [
          {
            voice_id: 'voice_1',
            scored_sends: 12,
            survival_trend: [{ week: '2026-W28', mean: 0.62 }],
            untouched_rate: 0.25,
          },
        ],
        funnel: { drafts: 20, sent: 12, sent_untouched: 3 },
      }
    },
    listProvenance({ draftId } = {}) {
      return state.provenance.filter((e) => draftId === undefined || e.draft_id === draftId).map((e) => ({ ...e }))
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
    createVoice({ name, description, body_md }) {
      const voice = { id: nextId('voice'), name, description: description ?? null, body_md, archived: 0 }
      const revision = { id: nextId('vrev'), voice_id: voice.id, seq: 1, body_md, source: 'seed' }
      state.voiceRevisions.set(revision.id, revision)
      voice.current_revision_id = revision.id
      state.voices.set(voice.id, voice)
      return { ...voice }
    },
    getVoice(id) {
      const voice = state.voices.get(id)
      return voice ? { ...voice } : null
    },
    appendVoiceRevision({ voiceId, body, source, proposalId }) {
      const voice = state.voices.get(voiceId)
      const seq = [...state.voiceRevisions.values()].filter((r) => r.voice_id === voiceId).length + 1
      const revision = { id: nextId('vrev'), voice_id: voiceId, seq, body_md: body, source, proposal_id: proposalId ?? null }
      state.voiceRevisions.set(revision.id, revision)
      voice.body_md = body
      voice.current_revision_id = revision.id
      return { ...revision }
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
  }
}

const VOICE_BODY = '# Register\n\nWarm and concise.\n\n# Sign-off\n\nAlways "Best, Paul".'

function seededVoice(store, overrides = {}) {
  return store.createVoice({ name: 'Client mail', description: 'warm', body_md: VOICE_BODY, ...overrides })
}

function addSend(store, { draftId, voiceId = null, first = null, final = 'final text' } = {}) {
  store.state.sends.push({
    draft_id: draftId,
    gmail_message_id: 'g1',
    sent_at: '2026-07-10T10:00:00.000Z',
    final_text: final,
    first_ai_text: first,
    survival_rate: first ? 0.6 : null,
    untouched: 0,
    voice_id: voiceId,
    distilled: 0,
  })
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

const REJECTION = 'Too formal — I never write "Dear colleagues"!'

describe('distill — thin signal', () => {
  it('exits silently below 5 undistilled sends: no model call, no marking, no provenance', async () => {
    const store = makeStore()
    const voice = seededVoice(store)
    for (let i = 1; i <= 4; i++) addSend(store, { draftId: `d${i}`, voiceId: voice.id })
    const ai = stubAi({ hunks: [] })

    const result = await createFlywheel({ store, ai }).distill()
    expect(result).toEqual({ ran: false, reason: 'thin_signal', undistilled: 4 })
    expect(ai.calls).toHaveLength(0)
    expect(store.state.markDistilledCalls).toHaveLength(0)
    expect(store.state.provenance).toHaveLength(0)
  })
})

describe('distill — signal gathering and proposals', () => {
  function signalStore() {
    const store = makeStore()
    const voice = seededVoice(store)
    for (let i = 1; i <= 5; i++) {
      addSend(store, {
        draftId: `d${i}`,
        voiceId: voice.id,
        first: 'Dear colleagues, attached the numbers.',
        final: 'Hi both — numbers attached.',
      })
    }
    store.appendProvenance({ draftId: 'd1', kind: 'hunk_rejected', payload: { comment: REJECTION } })
    store.appendProvenance({ draftId: 'd2', kind: 'human_edit', payload: {} })
    store.appendProvenance({ draftId: 'd3', kind: 'human_takeover', payload: {} })
    return { store, voice }
  }

  it('creates a pending voice proposal with origin flywheel and marks sends distilled', async () => {
    const { store, voice } = signalStore()
    const ai = stubAi({
      hunks: [
        {
          original_text: 'Warm and concise.',
          proposed_text: 'Warm and concise. Never open with "Dear colleagues".',
          note: 'from rejection comments',
        },
      ],
    })

    const result = await createFlywheel({ store, ai }).distill()
    expect(result.ran).toBe(true)
    expect(result.proposals).toHaveLength(1)
    expect(result.distilled).toBe(5)

    const proposal = store.getProposal(result.proposals[0], { withHunks: true })
    expect(proposal).toMatchObject({
      target_kind: 'voice',
      target_id: voice.id,
      origin: 'flywheel',
      status: 'pending',
      base_revision_id: voice.current_revision_id,
    })
    expect(proposal.hunks[0].status).toBe('pending')
    expect(proposal.intent_text).toContain('5 recent sends')

    expect(store.state.markDistilledCalls).toEqual([['d1', 'd2', 'd3', 'd4', 'd5']])
    const distilledEvents = store.state.provenance.filter((e) => e.kind === 'flywheel_distilled')
    expect(distilledEvents).toHaveLength(1)
    expect(distilledEvents[0].draft_id).toBeNull()
    expect(JSON.parse(distilledEvents[0].payload_json)).toMatchObject({
      sends: 5,
      proposals: [proposal.id],
    })
  })

  it('feeds the model rejection comments verbatim, edit deltas, trends, and the numbered voice doc', async () => {
    const { store } = signalStore()
    const ai = stubAi({ hunks: [] })
    await createFlywheel({ store, ai }).distill()

    const { system, prompt, schema } = ai.calls[0]
    expect(schema).toEqual(HUNKS_SCHEMA)
    // Voice document, paragraph-numbered like a draft body.
    expect(prompt).toContain('[paragraph 1]\n# Register')
    // Rejection comment verbatim (JSON-quoted so whitespace survives).
    expect(prompt).toContain(JSON.stringify(REJECTION))
    // Human-edit delta: first AI text vs final sent text.
    expect(prompt).toContain('Dear colleagues, attached the numbers.')
    expect(prompt).toContain('Hi both — numbers attached.')
    // Survival trend from voiceMetrics.
    expect(prompt).toContain('scored sends: 12')
    // Signal priority is spelled out.
    expect(system).toContain('Rejection comments')
    expect(system).toContain('never a lesson by itself')
    expect(system).toContain('return an empty hunks array')
  })

  it('creates no proposal when the model finds no durable lesson, but still consumes the sends', async () => {
    const { store } = signalStore()
    const result = await createFlywheel({ store, ai: stubAi({ hunks: [] }) }).distill()
    expect(result).toEqual({ ran: true, distilled: 5, proposals: [] })
    expect(store.state.proposals.size).toBe(0)
    expect(store.state.markDistilledCalls).toHaveLength(1)
    expect(store.state.provenance.filter((e) => e.kind === 'flywheel_distilled')).toHaveLength(1)
  })

  it('consumes voiceless sends without a model call', async () => {
    const store = makeStore()
    for (let i = 1; i <= 5; i++) addSend(store, { draftId: `d${i}` })
    const ai = stubAi({ hunks: [] })
    const result = await createFlywheel({ store, ai }).distill()
    expect(result.ran).toBe(true)
    expect(result.distilled).toBe(5)
    expect(ai.calls).toHaveLength(0)
    expect(store.state.markDistilledCalls).toEqual([['d1', 'd2', 'd3', 'd4', 'd5']])
  })

  it('on model failure keeps that voice\'s sends undistilled for the next trigger', async () => {
    const store = makeStore()
    const voiceA = seededVoice(store)
    const voiceB = seededVoice(store, { name: 'Intern' })
    for (let i = 1; i <= 3; i++) addSend(store, { draftId: `a${i}`, voiceId: voiceA.id })
    for (let i = 1; i <= 3; i++) addSend(store, { draftId: `b${i}`, voiceId: voiceB.id })

    const ai = stubAi((request) => {
      if (request.prompt.includes('3 recent sends in this voice') && request.prompt.includes('# Register')) {
        // First voice succeeds, second throws.
        if (ai.calls.length === 1) return { object: { hunks: [] } }
        throw new Error('overloaded')
      }
      return { object: { hunks: [] } }
    })

    const result = await createFlywheel({ store, ai }).distill()
    expect(result.ran).toBe(true)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/overloaded/)
    // Only voice A's sends were consumed.
    expect(store.state.markDistilledCalls).toEqual([['a1', 'a2', 'a3']])
    const remaining = store.undistilledSends().map((s) => s.draft_id)
    expect(remaining).toEqual(['b1', 'b2', 'b3'])
    // Failure is visible in the run's provenance payload.
    const payload = JSON.parse(store.state.provenance.filter((e) => e.kind === 'flywheel_distilled')[0].payload_json)
    expect(payload.errors).toHaveLength(1)
  })

  it('accepting a flywheel hunk updates the voice document through the standard mechanic', async () => {
    const { store, voice } = signalStore()
    const ai = stubAi({
      hunks: [
        {
          original_text: 'Warm and concise.',
          proposed_text: 'Warm and concise. Never open with "Dear colleagues".',
        },
      ],
    })
    const flywheel = createFlywheel({ store, ai })
    const { proposals: [proposalId] } = await flywheel.distill()

    // The UI reviews flywheel proposals with the same hunk engine.
    const { createProposals } = await import('./proposals.mjs')
    const engine = createProposals({ store })
    const proposal = store.getProposal(proposalId, { withHunks: true })
    const accepted = engine.acceptHunk(proposal.hunks[0].id)
    expect(accepted.error).toBeUndefined()
    expect(store.getVoice(voice.id).body_md).toContain('Never open with "Dear colleagues".')
    expect(store.getProposal(proposalId).status).toBe('resolved')
  })
})
