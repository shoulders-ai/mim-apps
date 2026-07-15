// Flywheel — distill the delta between what the AI proposed and what the
// human actually sent into hunk proposals against the voice documents
// (plan.md §7, CONTRACTS §8.3). The AI never silently updates a voice: every
// lesson arrives as a reviewable proposal with origin 'flywheel'.
//
// Signal weights: rejection comments (verbatim, strongest) > human-edit
// deltas on AI text > survival trends. Thin signal (<5 undistilled sends)
// exits silently — never invent lessons from noise.

import { createProposals, numberParagraphs, HUNKS_SCHEMA } from './proposals.mjs'
import { HUNK_RULES } from './drafting.mjs'

const MIN_SENDS = 5

const DISTILL_SYSTEM = `You maintain the user's email voice documents. You receive review signal from recent sends and propose minimal edits to ONE voice document, as hunks.

Signal priority (strongest first):
1. Rejection comments — the user's own words about what was wrong, quoted verbatim. Treat them as authoritative.
2. Human-edit deltas — how the user rewrote AI text before sending.
3. Survival trends — weak statistical signal; context only, never a lesson by itself.

Only distill durable, generalizable writing lessons (e.g. "never open with a pleasantry"), never one-off content (e.g. "mention the Q3 deck"). If the signal contains no durable lesson, return an empty hunks array — proposing nothing is the correct output for thin or noisy signal.

${HUNK_RULES}`

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '…[truncated]' : value
}

function parsePayload(event) {
  if (event.payload && typeof event.payload === 'object') return event.payload
  try {
    return JSON.parse(event.payload_json ?? '{}')
  } catch {
    return {}
  }
}

export function createFlywheel({ store, ai }) {
  const proposals = createProposals({ store })

  // Collect per-send review signal from the provenance ledger.
  function gatherSignal(sends) {
    const rejections = []
    const deltas = []
    let humanEdits = 0
    let takeovers = 0
    for (const send of sends) {
      const events = store.listProvenance({ draftId: send.draft_id }) ?? []
      for (const event of events) {
        const payload = parsePayload(event)
        if (event.kind === 'hunk_rejected' && typeof payload.comment === 'string') {
          rejections.push(payload.comment)
        }
        if (event.kind === 'human_edit') humanEdits++
        if (event.kind === 'human_takeover') takeovers++
      }
      if (
        typeof send.first_ai_text === 'string' &&
        send.first_ai_text !== '' &&
        typeof send.final_text === 'string' &&
        send.first_ai_text !== send.final_text
      ) {
        deltas.push({ first: send.first_ai_text, final: send.final_text })
      }
    }
    return { rejections, deltas, humanEdits, takeovers }
  }

  function buildPrompt(voice, sends, signal, metrics) {
    const sections = [`## Voice document (numbered paragraphs)\n\n${numberParagraphs(voice.body_md ?? '')}`]

    const signalParts = [`## Review signal from ${sends.length} recent sends in this voice`]
    if (signal.rejections.length > 0) {
      signalParts.push(
        `### Rejection comments (verbatim, strongest signal)\n\n${signal.rejections.map((c) => `- ${JSON.stringify(c)}`).join('\n')}`,
      )
    }
    if (signal.deltas.length > 0) {
      signalParts.push(
        `### Human edits to AI text (first AI draft → final sent)\n\n${signal.deltas
          .map((d) => `First AI draft:\n${truncate(d.first, 400)}\n\nFinal sent:\n${truncate(d.final, 400)}`)
          .join('\n\n---\n\n')}`,
      )
    }
    signalParts.push(`### Counts\n\nhuman_edit revisions: ${signal.humanEdits}, takeovers: ${signal.takeovers}`)

    const trend = metrics?.per_voice?.find((v) => v.voice_id === voice.id)
    signalParts.push(
      trend
        ? `### Survival trend (weak signal)\n\nscored sends: ${trend.scored_sends}, untouched rate: ${trend.untouched_rate}, weekly survival means: ${JSON.stringify(trend.survival_trend)}`
        : `### Survival trend (weak signal)\n\nnot enough scored sends`,
    )

    sections.push(signalParts.join('\n\n'))
    return sections.join('\n\n')
  }

  // Distill undistilled sends into voice-document proposals. Exits silently
  // below MIN_SENDS. Sends whose voice failed to distill (model error) stay
  // undistilled so their signal is retried on the next trigger.
  async function distill() {
    const sends = store.undistilledSends() ?? []
    if (sends.length < MIN_SENDS) {
      return { ran: false, reason: 'thin_signal', undistilled: sends.length }
    }

    const byVoice = new Map()
    const processedDraftIds = []
    for (const send of sends) {
      const voice = send.voice_id ? store.getVoice(send.voice_id) : null
      if (!voice || voice.archived) {
        // No (live) voice to learn into — consume the send.
        processedDraftIds.push(send.draft_id)
        continue
      }
      if (!byVoice.has(voice.id)) byVoice.set(voice.id, { voice, sends: [] })
      byVoice.get(voice.id).sends.push(send)
    }

    let metrics = null
    try {
      metrics = store.voiceMetrics()
    } catch {
      metrics = null
    }

    const proposalIds = []
    const errors = []
    for (const { voice, sends: voiceSends } of byVoice.values()) {
      const signal = gatherSignal(voiceSends)
      const prompt = buildPrompt(voice, voiceSends, signal, metrics)
      try {
        const result = await ai.generateObject({ system: DISTILL_SYSTEM, prompt, schema: HUNKS_SCHEMA })
        const rawHunks = result?.object?.hunks
        if (!Array.isArray(rawHunks)) throw new Error('model returned no hunks array')
        if (rawHunks.length > 0) {
          const created = proposals.validateAndCreate({
            targetKind: 'voice',
            targetId: voice.id,
            intent: `Lessons distilled from ${voiceSends.length} recent sends in "${voice.name}"`,
            scope: null,
            origin: 'flywheel',
            modelId: result?.modelId ?? null,
            rawHunks,
          })
          if (created.proposal) proposalIds.push(created.proposal.id)
        }
        processedDraftIds.push(...voiceSends.map((send) => send.draft_id))
      } catch (err) {
        errors.push(`voice ${voice.id}: ${err?.message ?? String(err)}`)
      }
    }

    if (processedDraftIds.length > 0) {
      store.markDistilled(processedDraftIds)
      store.appendProvenance({
        draftId: null,
        kind: 'flywheel_distilled',
        payload: {
          sends: processedDraftIds.length,
          proposals: proposalIds,
          ...(errors.length > 0 ? { errors } : {}),
        },
      })
    }

    return {
      ran: true,
      distilled: processedDraftIds.length,
      proposals: proposalIds,
      ...(errors.length > 0 ? { errors } : {}),
    }
  }

  return { distill }
}
