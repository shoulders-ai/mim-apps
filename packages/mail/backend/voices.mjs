// Voices — seed 2-3 legible voice documents from the user's real sent mail
// (plan.md §7). The model clusters by LANGUAGE first, then register and
// audience; a bilingual corpus must yield language-coherent voices. Noise
// (short bodies, receipts/automated mail, mostly-quoted messages) is
// filtered before anything reaches the prompt: ≤80 samples × ≤500 chars.

const MIN_USABLE = 5
const MAX_SAMPLES = 80
const MAX_SAMPLE_CHARS = 500
const MAX_VOICES = 3

export const VOICES_SCHEMA = {
  type: 'object',
  properties: {
    voices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'How the user would recognize this voice, e.g. "Client mail — warm EN".' },
          description: { type: 'string', description: 'One line on when this voice applies.' },
          body_md: { type: 'string', description: 'The full voice document in markdown.' },
        },
        required: ['name', 'description', 'body_md'],
      },
    },
  },
  required: ['voices'],
}

const SEED_SYSTEM = `You analyze a corpus of the user's real sent emails and distill 2-3 named writing voices.

Cluster by LANGUAGE first: never mix languages within one voice — a bilingual corpus must yield language-coherent voices (e.g. one German voice and one English voice), each with exemplars in its own language. Within a language, split further by register and audience (e.g. brisk internal notes vs. warm client mail) only where the corpus clearly supports it. Produce 2 or 3 voices total.

Each voice is a markdown document the user will read and edit ("here's my first read — correct me"), with these sections:
- Register: formality, warmth, directness
- Greetings & sign-offs: the exact phrases this writer uses and when
- Rhythm & structure: sentence length, paragraphing, lists, how links/attachments are mentioned
- Dos & don'ts: concrete habits to keep, and things this writer never does
- Exemplars: 2-3 short VERBATIM quotes copied from the samples, in this voice's language

Base everything on the samples. Never invent habits the corpus does not show.`

function parseRecipients(toJson) {
  let list = toJson
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.email))
    .filter((email) => typeof email === 'string')
}

// Strip quoted reply/forward content so filters and samples see only the
// user's own words. Everything from a quote header onward is discarded, as
// are '>'-prefixed lines.
export function stripQuoted(body) {
  const lines = String(body ?? '').split('\n')
  const kept = []
  for (const line of lines) {
    if (/^\s*On .{0,200}wrote:\s*$/.test(line)) break
    if (/^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(line)) break
    if (/^\s*Am .{0,200}schrieb .{0,100}:\s*$/.test(line)) break
    if (/^\s*>/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

const AUTO_RECIPIENT = /(^|[.@+_-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce)@/i
const AUTO_SUBJECT =
  /^(re:\s*)?(accepted|declined|tentative|automatic reply|auto[- ]?reply|out of office|abwesenheit|delivery status|read receipt|receipt|your (order|invoice|receipt))/i
const AUTO_BODY = /(this is an automated (message|email)|do not reply to this (message|email)|unsubscribe from this list)/i

// Noise filter (plan.md §7): short bodies (<15 own words), receipts and
// automated mail, and mostly-quoted messages (which have <15 own words once
// the quote is stripped).
export function isNoise(message) {
  const recipients = parseRecipients(message?.to_json).join(' ')
  if (AUTO_RECIPIENT.test(recipients)) return true
  if (AUTO_SUBJECT.test(message?.subject ?? '')) return true
  const own = stripQuoted(message?.body_text)
  if (AUTO_BODY.test(own)) return true
  const words = own.split(/\s+/).filter(Boolean)
  if (words.length < 15) return true
  return false
}

export function createVoices({ store, ai }) {
  // Gather the sent corpus through the contracted store API: sent-tab
  // threads → thread messages → is_from_me rows, newest first.
  function sentCorpus(accountId) {
    const threads = store.searchThreads({ accountId, tab: 'sent', limit: 300, offset: 0 }) ?? []
    const seen = new Set()
    const corpus = []
    for (const thread of threads) {
      const messages = store.getThreadMessages(thread.id) ?? []
      for (const message of messages) {
        if (!message.is_from_me || seen.has(message.id)) continue
        seen.add(message.id)
        corpus.push(message)
      }
      if (corpus.length >= 400) break
    }
    corpus.sort((a, b) => (b.internal_date ?? 0) - (a.internal_date ?? 0))
    return corpus
  }

  async function seed({ accountId }) {
    const usable = sentCorpus(accountId).filter((message) => !isNoise(message))
    if (usable.length < MIN_USABLE) {
      return {
        error: `not enough sent mail to seed voices (need at least ${MIN_USABLE} usable messages, found ${usable.length})`,
      }
    }

    const samples = usable.slice(0, MAX_SAMPLES).map((message, i) => {
      const to = parseRecipients(message.to_json).join(', ')
      const header = [`### Sample ${i + 1}`, to ? `to: ${to}` : null, message.subject ? `subject: ${message.subject}` : null]
        .filter(Boolean)
        .join(' — ')
      return `${header}\n${stripQuoted(message.body_text).slice(0, MAX_SAMPLE_CHARS)}`
    })
    const prompt = `Sent-mail samples (newest first):\n\n${samples.join('\n\n')}`

    let result
    try {
      result = await ai.generateObject({ system: SEED_SYSTEM, prompt, schema: VOICES_SCHEMA })
    } catch (err) {
      return { error: `model failed: ${err?.message ?? String(err)}` }
    }

    const docs = (Array.isArray(result?.object?.voices) ? result.object.voices : []).filter(
      (v) => typeof v?.name === 'string' && v.name !== '' && typeof v?.body_md === 'string' && v.body_md !== '',
    )
    if (docs.length === 0) return { error: 'model returned no voices' }

    // createVoice writes the initial voice_revisions row with source 'seed'
    // and sets current_revision_id (store contract).
    const voices = docs.slice(0, MAX_VOICES).map((doc) =>
      store.createVoice({
        name: doc.name,
        description: doc.description ?? null,
        body_md: doc.body_md,
      }),
    )
    return { voices }
  }

  return { seed }
}
