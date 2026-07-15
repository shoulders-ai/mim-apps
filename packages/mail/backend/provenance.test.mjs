import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from './store.mjs'
import { createProvenance } from './provenance.mjs'

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-prov-test-'))
  return { dir, dbPath: join(dir, 'mail.sqlite') }
}

describe('createProvenance', () => {
  let tmp, store, prov

  beforeEach(() => {
    tmp = tmpDb()
    store = createStore({ dbPath: tmp.dbPath })
    prov = createProvenance({ store })
  })

  afterEach(() => {
    if (store?.close) store.close()
    rmSync(tmp.dir, { recursive: true, force: true })
  })

  // --- survivalRate ---

  describe('survivalRate', () => {
    it('identical texts → 1.0', () => {
      const text = 'Hello world, this is a test of the survival rate calculation.'
      expect(prov.survivalRate(text, text)).toBe(1.0)
    })

    it('total rewrite → near 0', () => {
      const first = 'The quick brown fox jumps over the lazy dog near the riverbank at sunset.'
      const final = 'Elephants gallop through dense jungles while parrots screech overhead during monsoon season.'
      const rate = prov.survivalRate(first, final)
      expect(rate).toBeLessThan(0.15)
    })

    it('paragraph replaced → proportional survival', () => {
      const shared = 'This is the first paragraph that stays the same in both versions of the document.'
      const first = shared + ' The second paragraph is about cats and dogs and other animals.'
      const final = shared + ' The replacement paragraph discusses something completely different and new.'
      const rate = prov.survivalRate(first, final)
      // shared is ~15 tokens, total final is ~25 tokens, so survival ~ 0.6
      expect(rate).toBeGreaterThan(0.4)
      expect(rate).toBeLessThan(0.9)
    })

    it('empty first_ai_text → survivalRate returns null', () => {
      expect(prov.survivalRate('', 'Some final text')).toBeNull()
      expect(prov.survivalRate(null, 'Some final text')).toBeNull()
      expect(prov.survivalRate(undefined, 'Some final text')).toBeNull()
    })

    it('empty final text → clamped to 0', () => {
      // denominator max(1, 0) = 1, LCS of anything with [] = 0
      expect(prov.survivalRate('Some text', '')).toBe(0)
    })

    it('clamps to [0, 1]', () => {
      const rate = prov.survivalRate('a', 'a')
      expect(rate).toBeGreaterThanOrEqual(0)
      expect(rate).toBeLessThanOrEqual(1)
    })

    it('handles NFC normalization', () => {
      // e + combining acute = NFC é
      const withCombining = 'café'  // cafe + combining acute
      const nfcForm = 'café'              // café as single codepoint
      const rate = prov.survivalRate(withCombining, nfcForm)
      expect(rate).toBe(1.0)
    })

    it('cost cap: falls back to line-level LCS for large inputs', () => {
      // Create inputs where n*m > 25_000_000
      // 5001 tokens each → 5001 * 5001 > 25M
      const words = []
      for (let i = 0; i < 5001; i++) words.push(`word${i}`)
      const big = words.join(' ')
      // Should not throw, and should return a valid rate
      const rate = prov.survivalRate(big, big)
      expect(rate).toBe(1.0)
    })

    it('cost cap: line-level LCS with different content', () => {
      // Build lines that produce n*m > 25M at token level but are tractable at line level
      // Need >5000 tokens each: 350 lines x ~15 tokens each = ~5250
      const lines = []
      for (let i = 0; i < 350; i++) {
        lines.push(`This is line number ${i} with enough words to pad out the token count for cost cap testing purposes here.`)
      }
      const first = lines.join('\n')
      // Replace half the lines
      const modified = lines.map((l, i) => i < 175 ? l : `Completely unique replacement content for line ${i} that shares no words with original text above.`).join('\n')
      const rate = prov.survivalRate(first, modified)
      // Line-level: 175 identical out of 350 = 0.5
      expect(rate).toBeGreaterThan(0.3)
      expect(rate).toBeLessThan(0.7)
    })
  })

  // --- untouched ---

  describe('untouched', () => {
    it('returns true when no human edits, no rejected hunks, no dismissed proposals', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      store.appendRevision({ draftId: draft.id, body: 'AI draft', source: 'ai_initial' })

      expect(prov.untouched(draft.id)).toBe(true)
    })

    it('returns false when draft has human_edit revisions', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      store.appendRevision({ draftId: draft.id, body: 'AI draft', source: 'ai_initial' })
      store.appendRevision({ draftId: draft.id, body: 'Human edited', source: 'human_edit' })

      expect(prov.untouched(draft.id)).toBe(false)
    })

    it('returns false when draft has rejected hunks', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'AI draft', source: 'ai_initial' })

      const proposal = store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'Fix',
        origin: 'user_request',
        hunks: [
          { seq: 1, original_text: 'AI', proposed_text: 'My', status: 'rejected' },
        ],
      })

      expect(prov.untouched(draft.id)).toBe(false)
    })

    it('returns false when draft has dismissed proposals', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'AI draft', source: 'ai_initial' })

      const proposal = store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'Fix',
        origin: 'user_request',
        hunks: [],
      })
      store.updateProposal(proposal.id, { status: 'dismissed' })

      expect(prov.untouched(draft.id)).toBe(false)
    })

    it('returns true when hunks are accepted (not rejected)', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Test' })
      const r1 = store.appendRevision({ draftId: draft.id, body: 'AI draft', source: 'ai_initial' })

      const proposal = store.createProposal({
        target_kind: 'draft',
        target_id: draft.id,
        base_revision_id: r1.id,
        intent_text: 'Fix',
        origin: 'user_request',
        hunks: [
          { seq: 1, original_text: 'AI', proposed_text: 'My', status: 'accepted' },
        ],
      })

      // proposal_accept revision does NOT count as human_edit
      store.appendRevision({
        draftId: draft.id,
        body: 'My draft',
        source: 'proposal_accept',
        proposalId: proposal.id,
      })

      expect(prov.untouched(draft.id)).toBe(true)
    })
  })

  // --- finalizeSend ---

  describe('finalizeSend', () => {
    it('creates sends row with survival and untouched for AI-drafted message', () => {
      const voice = store.createVoice({ name: 'Pro', body_md: 'Be professional' })
      const draft = store.createDraft({
        account_id: 'a1',
        subject: 'Test send',
        voice_id: voice.id,
      })
      store.appendRevision({
        draftId: draft.id,
        body: 'Hello world from AI',
        source: 'ai_initial',
      })

      prov.finalizeSend({
        draftId: draft.id,
        gmailMessageId: 'gm-sent-123',
        finalText: 'Hello world from AI',
      })

      const sends = store.undistilledSends()
      expect(sends).toHaveLength(1)
      expect(sends[0].draft_id).toBe(draft.id)
      expect(sends[0].gmail_message_id).toBe('gm-sent-123')
      expect(sends[0].survival_rate).toBe(1.0) // identical
      expect(sends[0].untouched).toBe(1) // no human edits
      expect(sends[0].voice_id).toBe(voice.id)

      // Draft state should be 'sent'
      const updated = store.getDraft(draft.id)
      expect(updated.state).toBe('sent')

      // Provenance 'sent' should be recorded
      const provList = store.listProvenance({ draftId: draft.id })
      const sentProv = provList.find(p => p.kind === 'sent')
      expect(sentProv).toBeTruthy()
    })

    it('handles no ai_initial revision (NULL survival)', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Manual' })
      // Only human_edit, no ai_initial
      store.appendRevision({
        draftId: draft.id,
        body: 'Typed by human',
        source: 'human_edit',
      })

      prov.finalizeSend({
        draftId: draft.id,
        gmailMessageId: 'gm-sent-456',
        finalText: 'Typed by human',
      })

      const sends = store.undistilledSends()
      expect(sends).toHaveLength(1)
      expect(sends[0].first_ai_text).toBeNull()
      expect(sends[0].survival_rate).toBeNull()
    })

    it('computes survival with edits', () => {
      const draft = store.createDraft({ account_id: 'a1', subject: 'Edited' })
      store.appendRevision({
        draftId: draft.id,
        body: 'The quick brown fox jumps over the lazy dog',
        source: 'ai_initial',
      })
      store.appendRevision({
        draftId: draft.id,
        body: 'The quick red fox jumps over the lazy cat',
        source: 'human_edit',
      })

      prov.finalizeSend({
        draftId: draft.id,
        gmailMessageId: 'gm-sent-789',
        finalText: 'The quick red fox jumps over the lazy cat',
      })

      const sends = store.undistilledSends()
      // "brown" → "red", "dog" → "cat" — 7 out of 9 survived
      expect(sends[0].survival_rate).toBeCloseTo(7 / 9, 2)
      expect(sends[0].untouched).toBe(0) // has human_edit
    })

    it('records voice_id from draft', () => {
      const voice = store.createVoice({ name: 'Casual', body_md: 'Be casual' })
      const draft = store.createDraft({
        account_id: 'a1',
        subject: 'Voiced',
        voice_id: voice.id,
      })
      store.appendRevision({ draftId: draft.id, body: 'Hey', source: 'ai_initial' })

      prov.finalizeSend({
        draftId: draft.id,
        gmailMessageId: 'gm-sent-v1',
        finalText: 'Hey',
      })

      const sends = store.undistilledSends()
      expect(sends[0].voice_id).toBe(voice.id)
    })
  })
})
