// Drafting — the only module that asks the model to write email text.
//
// Two operations (CONTRACTS §8.3):
//   initialDraft — direct write, allowed ONLY while the draft body is empty
//                  (ai_initial revision + ai_drafted provenance).
//   propose      — everything after that: the model emits hunks which go
//                  through createProposals validation; it never mutates.
//
// The injected ai adapter is { generateObject({system, prompt, schema}) }
// returning { object } (payload at result.object, CONTRACTS §8).

import { createProposals, numberParagraphs, nfc, HUNKS_SCHEMA } from './proposals.mjs'

export const BODY_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', description: 'The complete plain-text email body.' },
  },
  required: ['body'],
}

// Model-facing hunk contract. Shared with flywheel.mjs — voice documents are
// edited with the same mechanic. Mirrors what validation enforces so the
// model wastes as few hunks as possible on drops.
export const HUNK_RULES = `Rules for hunks (validation drops violations, so follow them exactly):
- original_text must be copied character-for-character from the numbered document: same wording, punctuation, spacing, accents, and line breaks. Never paraphrase, trim, or re-wrap it.
- The "[paragraph N]" markers are labels, not document text — never include them in original_text.
- original_text must occur exactly once within the allowed scope; include enough surrounding text to make it unambiguous.
- A hunk must stay inside ONE paragraph (paragraphs are separated by blank lines). original_text must never span a blank line.
- Propose at most one hunk per paragraph.
- Never restate a paragraph that does not change — unchanged paragraphs get no hunk.
- To delete a whole paragraph, set proposed_text to "".
- To merge two paragraphs, rewrite one with the merged text and delete the other with proposed_text "".
- To insert a new paragraph, replace a span of an adjacent paragraph with itself plus the new text, using a blank line inside proposed_text to create the paragraph break.
- note is one short sentence explaining the change; the reviewer sees it on the hunk card.`

const PROPOSE_SYSTEM = `You are the drafting collaborator inside the user's mail app. You never edit the draft directly — you emit hunks: exact find-and-replace proposals the user reviews and accepts or rejects one at a time.

${HUNK_RULES}

Match the voice document and the recipient exemplars when provided. Keep edits minimal: change only what the request requires.`

const INITIAL_SYSTEM = `You write the first draft of an email body for the user. Output plain text only: no subject line, no markdown, no commentary — just the body the user would send. Separate paragraphs with a single blank line.

Match the voice document when provided. When recent messages the user sent to this recipient are provided, mirror their register, greeting, and sign-off — they are the strongest signal for how the user sounds to this person. Keep it as short as the task allows.`

const TRUNCATION_MARKER = '…[truncated]'

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + TRUNCATION_MARKER : value
}

// to_json entries are strings ("anna@acme.com") from draft tools, or
// {email, name} objects in the message mirror. Accept both.
export function recipientEmails(toJson) {
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
    .filter((email) => typeof email === 'string' && email.includes('@'))
}

export function createDrafting({ store, ai }) {
  const proposals = createProposals({ store })

  function currentBody(draft) {
    if (!draft.current_revision_id) return ''
    const revision = store.getRevision(draft.current_revision_id)
    return revision?.body_text ?? ''
  }

  function voiceSection(draft) {
    if (!draft.voice_id) return null
    const voice = store.getVoice(draft.voice_id)
    if (!voice) return null
    return `## Voice: ${voice.name}\n\n${voice.body_md}`
  }

  function threadSection(draft) {
    if (!draft.thread_id) return null
    const messages = store.getThreadMessages(draft.thread_id) ?? []
    if (messages.length === 0) return null
    const recent = messages.slice(-3)
    const rendered = recent.map((message) => {
      const from = message.from_name
        ? `${message.from_name} <${message.from_email ?? ''}>`
        : (message.from_email ?? 'unknown')
      return `From ${from}:\n${truncate(message.body_text, 1500)}`
    })
    return `## Thread so far (oldest first)\n\n${rendered.join('\n\n---\n\n')}`
  }

  // Recipient exemplars (CONTRACTS §8.3): the user's 2-3 most recent sent
  // messages to the same recipient; fallback exact email → domain → the
  // voice document's own exemplars.
  function exemplarSection(draft) {
    const emails = recipientEmails(draft.to_json)
    const email = emails[0]
    if (!email) return null
    let rows = store.recentSentTo({ accountId: draft.account_id, email, limit: 3 }) ?? []
    if (rows.length === 0) {
      const domain = email.split('@')[1]
      if (domain) rows = store.recentSentTo({ accountId: draft.account_id, domain, limit: 3 }) ?? []
    }
    if (rows.length === 0) {
      return `## Recipient exemplars\n\nNo prior sent mail to this recipient or their domain — mirror the voice document's exemplars instead.`
    }
    const rendered = rows.slice(0, 3).map((message) => truncate(message.body_text, 600))
    return `## Recent messages the user sent to this recipient (mirror this register)\n\n${rendered.join('\n\n---\n\n')}`
  }

  function metaSection(draft) {
    const parts = []
    const emails = recipientEmails(draft.to_json)
    if (emails.length) parts.push(`To: ${emails.join(', ')}`)
    if (draft.subject) parts.push(`Subject: ${draft.subject}`)
    return parts.length ? `## Draft metadata\n\n${parts.join('\n')}` : null
  }

  function contextSections(draft) {
    return [voiceSection(draft), threadSection(draft), exemplarSection(draft), metaSection(draft)].filter(Boolean)
  }

  // AI writes the body directly ONLY while it is empty (CONTRACTS §3.2
  // invariant). One human-typed character makes every later change a proposal.
  async function initialDraft({ draftId, instruction }) {
    const draft = store.getDraft(draftId)
    if (!draft) return { error: `unknown draft ${draftId}` }
    if (currentBody(draft) !== '') {
      return { error: 'draft body is not empty — AI may only propose changes (mail.draft.propose), never overwrite' }
    }

    const prompt = [...contextSections(draft), `## Task\n\nWrite the email body: ${instruction ?? ''}`].join('\n\n')

    let result
    try {
      result = await ai.generateObject({ system: INITIAL_SYSTEM, prompt, schema: BODY_SCHEMA })
    } catch (err) {
      return { error: `model failed: ${err?.message ?? String(err)}` }
    }
    const bodyText = result?.object?.body
    if (typeof bodyText !== 'string' || bodyText.trim() === '') {
      return { error: 'model returned no draft body' }
    }

    const body = nfc(bodyText)
    const revision = store.appendRevision({ draftId, body, source: 'ai_initial' })
    store.appendProvenance({
      draftId,
      kind: 'ai_drafted',
      payload: {
        revision_id: revision.id,
        ...(instruction ? { instruction } : {}),
        ...(draft.voice_id ? { voice_id: draft.voice_id } : {}),
      },
    })
    return { revision_id: revision.id, body }
  }

  // Generate hunks for a non-empty draft. Whatever the model returns goes
  // through createProposals validation; a model failure still leaves a
  // visible invalidated proposal and never throws (CONTRACTS §8).
  async function propose({ draftId, intent, paragraphs, origin = 'chat_agent' }) {
    const draft = store.getDraft(draftId)
    if (!draft) return { error: `unknown draft ${draftId}` }
    const body = currentBody(draft)
    if (body === '') {
      return { error: 'draft body is empty — use draft creation with an instruction (initial draft) instead of proposing' }
    }

    const scope = Array.isArray(paragraphs) && paragraphs.length > 0 ? paragraphs : null
    const prompt = [
      ...contextSections(draft),
      `## Current draft (numbered paragraphs)\n\n${numberParagraphs(nfc(body))}`,
      `## Requested change\n\n${intent ?? ''}`,
      scope
        ? `## Scope\n\nOnly propose changes inside paragraph(s) ${scope.join(', ')}. Hunks anchored anywhere else will be dropped.`
        : `## Scope\n\nAny paragraph may be edited, but only touch the paragraphs the request requires.`,
    ].join('\n\n')

    let rawHunks
    let modelId = null
    try {
      const result = await ai.generateObject({ system: PROPOSE_SYSTEM, prompt, schema: HUNKS_SCHEMA })
      modelId = result?.modelId ?? result?.response?.modelId ?? null
      rawHunks = result?.object?.hunks
      if (!Array.isArray(rawHunks)) throw new Error('model returned no hunks array')
    } catch (err) {
      // Record the failure as an invalidated proposal so the attempt is
      // visible in the review UI, then surface a recoverable error.
      const failed = proposals.validateAndCreate({
        targetKind: 'draft',
        targetId: draftId,
        intent: intent ?? '',
        scope,
        origin,
        modelId,
        rawHunks: [],
      })
      return {
        error: `model failed: ${err?.message ?? String(err)}`,
        ...(failed.proposal ? { proposal_id: failed.proposal.id } : {}),
      }
    }

    const created = proposals.validateAndCreate({
      targetKind: 'draft',
      targetId: draftId,
      intent: intent ?? '',
      scope,
      origin,
      modelId,
      rawHunks,
    })
    if (created.error) return created

    const { proposal, dropped } = created
    return {
      proposal_id: proposal.id,
      status: proposal.status,
      hunks: (proposal.hunks ?? [])
        .filter((hunk) => hunk.status === 'pending')
        .map((hunk) => ({
          id: hunk.id,
          original_text: hunk.original_text,
          proposed_text: hunk.proposed_text,
          note: hunk.note,
        })),
      dropped,
      ...(proposal.status === 'invalidated'
        ? { error: 'no hunks could be anchored safely — nothing to review' }
        : {}),
    }
  }

  return { initialDraft, propose }
}
