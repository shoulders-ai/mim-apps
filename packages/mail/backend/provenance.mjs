/**
 * createProvenance({ store }) — survival rate + untouched computation + finalizeSend.
 *
 * Implements CONTRACTS §6: survival_rate via LCS, untouched flag,
 * and the finalizeSend workflow.
 */
export function createProvenance({ store }) {

  /**
   * Tokenize: NFC normalize → split on whitespace → drop empties.
   * Case-sensitive, punctuation attached (per §6).
   */
  function tokenize(text) {
    if (!text) return []
    return text.normalize('NFC').split(/\s+/).filter(Boolean)
  }

  /**
   * Classic DP LCS length. O(n*m) time and O(min(n,m)) space.
   */
  function lcsLength(a, b) {
    if (a.length === 0 || b.length === 0) return 0
    // Use the shorter array as columns for space efficiency
    let short = a, long = b
    if (a.length > b.length) { short = b; long = a }

    const m = short.length
    let prev = new Array(m + 1).fill(0)
    let curr = new Array(m + 1).fill(0)

    for (let i = 1; i <= long.length; i++) {
      for (let j = 1; j <= m; j++) {
        if (long[i - 1] === short[j - 1]) {
          curr[j] = prev[j - 1] + 1
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1])
        }
      }
      ;[prev, curr] = [curr, prev]
      curr.fill(0)
    }
    return prev[m]
  }

  /**
   * survivalRate(firstAiText, finalText) → number | null
   *
   * Per §6:
   * - NULL when firstAiText is empty/null/undefined (excluded from aggregates)
   * - NFC normalize, whitespace-tokenize
   * - LCS(tokens(first), tokens(final)).length / max(1, tokens(final).length)
   * - Cost cap: if n*m > 25_000_000, compute on lines instead
   * - Clamp [0, 1]
   */
  function survivalRate(firstAiText, finalText) {
    // NULL semantics: no AI text → null survival
    if (!firstAiText || firstAiText.length === 0) return null

    const firstTokens = tokenize(firstAiText)
    const finalTokens = tokenize(finalText || '')

    if (firstTokens.length === 0) return null

    const n = firstTokens.length
    const m = finalTokens.length
    const denom = Math.max(1, m)

    if (n * m > 25_000_000) {
      // Cost cap: fall back to line-level LCS
      const firstLines = (firstAiText || '').normalize('NFC').split(/\n/)
      const finalLines = (finalText || '').normalize('NFC').split(/\n/)
      const lineLcs = lcsLength(firstLines, finalLines)
      const lineDenom = Math.max(1, finalLines.length)
      return Math.min(1, Math.max(0, lineLcs / lineDenom))
    }

    const lcs = lcsLength(firstTokens, finalTokens)
    return Math.min(1, Math.max(0, lcs / denom))
  }

  /**
   * untouched(draftId) → boolean
   *
   * Per §6: true iff:
   * - Zero human_edit revisions
   * - Zero hunks with status 'rejected' (on draft-targeting proposals)
   * - Zero proposals with status 'dismissed' (on draft-targeting proposals)
   */
  function untouched(draftId) {
    const revisions = store.listRevisions(draftId)
    if (revisions.some(r => r.source === 'human_edit')) return false
    return store._untouchedCheck(draftId)
  }

  /**
   * finalizeSend({ draftId, gmailMessageId, finalText })
   *
   * 1. Read the first ai_initial revision's body (→ first_ai_text; null if none)
   * 2. Compute survival_rate and untouched
   * 3. Write sends row
   * 4. Set draft state to 'sent'
   * 5. Append 'sent' provenance
   */
  function finalizeSend({ draftId, gmailMessageId, finalText }) {
    const draft = store.getDraft(draftId)
    if (!draft) throw new Error(`Draft not found: ${draftId}`)

    // Find first ai_initial revision
    const revisions = store.listRevisions(draftId)
    const aiInitial = revisions.find(r => r.source === 'ai_initial')
    const firstAiText = aiInitial ? aiInitial.body_text : null

    // Compute metrics
    const survival = survivalRate(firstAiText, finalText)
    const isUntouched = untouched(draftId) ? 1 : 0

    // Record send
    store.recordSend({
      draft_id: draftId,
      gmail_message_id: gmailMessageId,
      sent_at: new Date().toISOString(),
      final_text: finalText,
      first_ai_text: firstAiText,
      survival_rate: survival,
      untouched: isUntouched,
      voice_id: draft.voice_id ?? null,
    })

    // Update draft state
    store.updateDraft(draftId, { state: 'sent', gmail_sent_id: gmailMessageId })

    // Append provenance
    store.appendProvenance({
      draftId,
      kind: 'sent',
      payload: { gmail_message_id: gmailMessageId },
    })
  }

  return { survivalRate, untouched, finalizeSend }
}
