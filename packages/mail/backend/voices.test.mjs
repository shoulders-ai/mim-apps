import { describe, it, expect } from 'vitest'
import { createVoices, isNoise, stripQuoted, VOICES_SCHEMA } from './voices.mjs'

// Minimal fake store: sent corpus via searchThreads('sent') +
// getThreadMessages, and voice creation mirroring the real store (createVoice
// writes the seed revision itself and sets current_revision_id).
function makeStore() {
  const state = {
    threads: [], // {id}
    messages: new Map(), // thread_id -> messages[]
    voices: new Map(),
    voiceRevisions: [],
    searchThreadsCalls: [],
  }
  let n = 0
  const nextId = (prefix) => `${prefix}_${++n}`
  return {
    state,
    searchThreads({ accountId, tab, limit, offset }) {
      state.searchThreadsCalls.push({ accountId, tab, limit, offset })
      return state.threads.slice(0, limit)
    },
    getThreadMessages(threadId) {
      return (state.messages.get(threadId) ?? []).map((m) => ({ ...m }))
    },
    createVoice({ name, description, body_md }) {
      const voice = { id: nextId('voice'), name, description: description ?? null, body_md, archived: 0 }
      const revision = { id: nextId('vrev'), voice_id: voice.id, seq: 1, body_md, source: 'seed' }
      state.voiceRevisions.push(revision)
      voice.current_revision_id = revision.id
      state.voices.set(voice.id, voice)
      return { ...voice }
    },
  }
}

let messageCounter = 0
function sentMessage(body, { to = '[{"email":"anna@acme.com"}]', subject = 'Update', fromMe = 1, date } = {}) {
  messageCounter++
  return {
    id: `msg_${messageCounter}`,
    to_json: to,
    subject,
    body_text: body,
    is_from_me: fromMe,
    internal_date: date ?? 1000 - messageCounter,
  }
}

const GOOD_BODY =
  'Hi Anna, thanks for the update on the numbers. I went through the deck this morning and everything looks solid to me. Best, Paul'

function storeWithSent(messages) {
  const store = makeStore()
  store.state.threads.push({ id: 'thread_1' })
  store.state.messages.set('thread_1', messages)
  return store
}

function stubAi(response) {
  const calls = []
  return {
    calls,
    async generateObject(request) {
      calls.push(request)
      if (response instanceof Error) throw response
      return { object: response }
    },
  }
}

const TWO_VOICES = {
  voices: [
    { name: 'Client mail — warm EN', description: 'Warm client emails', body_md: '# Register\n\nWarm.' },
    { name: 'Intern — knapp DE', description: 'Knappe interne Mails', body_md: '# Register\n\nKnapp.' },
  ],
}

describe('stripQuoted', () => {
  it('drops >-quoted lines and everything after a quote header', () => {
    const body = 'My own reply here.\n\nOn Tue, Jul 1, 2026 Anna wrote:\n> old text\n> more old text'
    expect(stripQuoted(body)).toBe('My own reply here.')
    expect(stripQuoted('mine\n> quoted\nalso mine')).toBe('mine\nalso mine')
    expect(stripQuoted('mine\n-- Original Message --\nold')).toBe('mine')
  })
})

describe('isNoise (plan §7 noise filter)', () => {
  it('drops short bodies under 15 own words', () => {
    expect(isNoise(sentMessage('Thanks, sounds good!'))).toBe(true)
    expect(isNoise(sentMessage(GOOD_BODY))).toBe(false)
  })

  it('drops mail to no-reply/automated recipients', () => {
    expect(isNoise(sentMessage(GOOD_BODY, { to: '[{"email":"no-reply@shop.com"}]' }))).toBe(true)
    expect(isNoise(sentMessage(GOOD_BODY, { to: '["donotreply@x.io"]' }))).toBe(true)
  })

  it('drops receipts / auto subjects', () => {
    expect(isNoise(sentMessage(GOOD_BODY, { subject: 'Accepted: Team sync' }))).toBe(true)
    expect(isNoise(sentMessage(GOOD_BODY, { subject: 'Automatic reply: away' }))).toBe(true)
    expect(isNoise(sentMessage(GOOD_BODY, { subject: 'Out of office' }))).toBe(true)
  })

  it('drops automated body text', () => {
    const auto = `${GOOD_BODY} This is an automated message.`
    expect(isNoise(sentMessage(auto))).toBe(true)
  })

  it('drops mostly-quoted messages whose own text is thin', () => {
    const mostlyQuoted = 'Agreed, see below.\n' + '> quoted line with plenty of words in it\n'.repeat(30)
    expect(isNoise(sentMessage(mostlyQuoted))).toBe(true)
    // A real reply above a long quote survives: own words count, quote doesn't.
    const realReply = `${GOOD_BODY}\n` + '> quoted line\n'.repeat(30)
    expect(isNoise(sentMessage(realReply))).toBe(false)
  })
})

describe('seed', () => {
  it('reads the sent tab, filters noise, and creates 2-3 voices with seed revisions', async () => {
    const store = storeWithSent([
      ...Array.from({ length: 10 }, () => sentMessage(GOOD_BODY)),
      sentMessage('Thanks!'), // noise: short
      sentMessage(GOOD_BODY, { fromMe: 0 }), // not from me
    ])
    const ai = stubAi(TWO_VOICES)
    const voices = createVoices({ store, ai })

    const result = await voices.seed({ accountId: 'acct_1' })
    expect(result.error).toBeUndefined()
    expect(result.voices).toHaveLength(2)
    expect(store.state.searchThreadsCalls[0]).toMatchObject({ accountId: 'acct_1', tab: 'sent' })
    expect(store.state.voiceRevisions.map((r) => r.source)).toEqual(['seed', 'seed'])
    expect(result.voices[0].current_revision_id).toBeTruthy()
    expect(result.voices[1].body_md).toBe('# Register\n\nKnapp.')
    expect(ai.calls[0].schema).toEqual(VOICES_SCHEMA)
  })

  it('caps the prompt at 80 samples of at most 500 chars each', async () => {
    const longWord = 'wordy '.repeat(120).trim() // ~700 chars, >15 words
    const store = storeWithSent(Array.from({ length: 100 }, () => sentMessage(longWord)))
    const ai = stubAi(TWO_VOICES)
    await createVoices({ store, ai }).seed({ accountId: 'acct_1' })

    const prompt = ai.calls[0].prompt
    expect(prompt.match(/### Sample /g)).toHaveLength(80)
    expect(prompt).toContain(longWord.slice(0, 500))
    expect(prompt).not.toContain(longWord.slice(0, 501))
  })

  it('instructs language-coherent clustering (bilingual corpora)', async () => {
    const store = storeWithSent(Array.from({ length: 6 }, () => sentMessage(GOOD_BODY)))
    const ai = stubAi(TWO_VOICES)
    await createVoices({ store, ai }).seed({ accountId: 'acct_1' })
    const { system } = ai.calls[0]
    expect(system).toContain('Cluster by LANGUAGE first')
    expect(system).toContain('language-coherent voices')
    expect(system).toContain('never mix languages within one voice')
    expect(system).toMatch(/2.3 named writing voices|2 or 3 voices/)
  })

  it('clamps a chatty model to 3 voices', async () => {
    const store = storeWithSent(Array.from({ length: 6 }, () => sentMessage(GOOD_BODY)))
    const four = {
      voices: Array.from({ length: 4 }, (_, i) => ({
        name: `Voice ${i + 1}`,
        description: 'd',
        body_md: `# V${i + 1}`,
      })),
    }
    const result = await createVoices({ store, ai: stubAi(four) }).seed({ accountId: 'acct_1' })
    expect(result.voices).toHaveLength(3)
    expect(store.state.voices.size).toBe(3)
  })

  it('exits with {error} when fewer than 5 usable messages exist — no model call', async () => {
    const store = storeWithSent([
      sentMessage(GOOD_BODY),
      sentMessage(GOOD_BODY),
      sentMessage('Thanks!'),
      sentMessage(GOOD_BODY, { subject: 'Accepted: sync' }),
    ])
    const ai = stubAi(TWO_VOICES)
    const result = await createVoices({ store, ai }).seed({ accountId: 'acct_1' })
    expect(result.error).toMatch(/not enough sent mail/)
    expect(ai.calls).toHaveLength(0)
    expect(store.state.voices.size).toBe(0)
  })

  it('returns {error} on model failure or empty voices without creating anything', async () => {
    const store = storeWithSent(Array.from({ length: 6 }, () => sentMessage(GOOD_BODY)))
    const failed = await createVoices({ store, ai: stubAi(new Error('overloaded')) }).seed({ accountId: 'acct_1' })
    expect(failed.error).toMatch(/overloaded/)
    const empty = await createVoices({ store, ai: stubAi({ voices: [] }) }).seed({ accountId: 'acct_1' })
    expect(empty.error).toMatch(/no voices/)
    const invalid = await createVoices({ store, ai: stubAi({ voices: [{ name: '', body_md: '' }] }) }).seed({
      accountId: 'acct_1',
    })
    expect(invalid.error).toMatch(/no voices/)
    expect(store.state.voices.size).toBe(0)
  })
})
