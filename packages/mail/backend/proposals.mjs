// Proposal engine — hunk validation, anchoring, apply, and re-anchoring.
//
// The product contract "the AI never overwrites; every change is a granular,
// reviewable proposal" is enforced here, structurally, not by prompting.
// docs/CONTRACTS.md §4 is the authority for every rule in this file; do not
// relax matching or validation semantics.
//
// Store access is synchronous (node:sqlite DatabaseSync per CONTRACTS §2).

const now = () => new Date().toISOString()

// The §8 generateObject schema for hunk proposals. Single source of truth,
// shared by drafting.mjs and flywheel.mjs.
export const HUNKS_SCHEMA = {
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
}

export function nfc(value) {
  return typeof value === 'string' ? value.normalize('NFC') : value
}

// Paragraphs are the blocks between blank-line separators (/\n{2,}/),
// mirroring String.split semantics: leading/trailing separators yield empty
// paragraphs that still occupy a 1-based index. Spans are [start, end)
// character offsets into the body; separators belong to no paragraph.
export function paragraphSpans(body) {
  const spans = []
  const re = /\n{2,}/g
  let last = 0
  let match
  while ((match = re.exec(body)) !== null) {
    spans.push({ start: last, end: match.index })
    last = match.index + match[0].length
  }
  spans.push({ start: last, end: body.length })
  return spans
}

export function splitParagraphs(body) {
  return String(body ?? '').split(/\n{2,}/)
}

// Paragraph-numbered rendering for prompts. The "[paragraph N]" markers are
// labels around the verbatim text; prompts must tell the model they are not
// part of the document.
export function numberParagraphs(body) {
  return splitParagraphs(body)
    .map((paragraph, i) => `[paragraph ${i + 1}]\n${paragraph}`)
    .join('\n\n')
}

// All match start offsets, overlapping occurrences included: "aa" occurs at
// 0 and 1 in "aaa", and that genuinely is ambiguous for replacement.
function findAll(haystack, needle) {
  const out = []
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    out.push(idx)
    idx = haystack.indexOf(needle, idx + 1)
  }
  return out
}

function spansIntersect(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

// Deleting a whole paragraph leaves its separator behind; collapse a seam of
// 3+ newlines to exactly two so no empty paragraph survives the deletion.
function collapseSeam(body, seamIndex) {
  let start = seamIndex
  let end = seamIndex
  while (start > 0 && body[start - 1] === '\n') start--
  while (end < body.length && body[end] === '\n') end++
  if (end - start >= 3) return body.slice(0, start) + '\n\n' + body.slice(end)
  return body
}

// Pure: apply one hunk to a body. Matching is exact substring equality on the
// NFC-normalized text (CONTRACTS §4.2); the returned body is the normalized
// body with the unique match replaced. Throws 'empty' / 'no_match' /
// 'ambiguous' when the anchor does not hold — callers decide how to surface it.
export function applyToBody(body, hunk) {
  const base = nfc(String(body ?? ''))
  const original = typeof hunk?.original_text === 'string' ? nfc(hunk.original_text) : ''
  if (original === '') throw new Error('empty')
  const proposed = typeof hunk?.proposed_text === 'string' ? nfc(hunk.proposed_text) : ''
  const matches = findAll(base, original)
  if (matches.length === 0) throw new Error('no_match')
  if (matches.length > 1) throw new Error('ambiguous')
  const start = matches[0]
  const next = base.slice(0, start) + proposed + base.slice(start + original.length)
  if (proposed === '') return collapseSeam(next, start)
  return next
}

// Validate raw hunks against a body per CONTRACTS §4.3, in order:
// empty → in-scope unique match → single-paragraph containment → overlap.
// Returns storable hunk rows (seq in input order) with match spans attached.
function validateHunks(bodyRaw, scope, rawHunks) {
  const body = nfc(String(bodyRaw ?? ''))
  const spans = paragraphSpans(body)
  const scopeIndices =
    Array.isArray(scope) && scope.length > 0
      ? scope.filter((n) => Number.isInteger(n) && n >= 1 && n <= spans.length)
      : spans.map((_, i) => i + 1)
  const scopeSpans = scopeIndices.map((n) => spans[n - 1])

  const rows = rawHunks.map((raw, i) => ({
    seq: i + 1,
    original_text: typeof raw?.original_text === 'string' ? nfc(raw.original_text) : '',
    proposed_text: typeof raw?.proposed_text === 'string' ? nfc(raw.proposed_text) : '',
    note: typeof raw?.note === 'string' ? raw.note : null,
    paragraph_index: null,
    status: 'pending',
    drop_reason: null,
    _start: -1,
    _end: -1,
  }))

  const drop = (row, reason) => {
    row.status = 'dropped'
    row.drop_reason = reason
  }

  for (const row of rows) {
    if (row.original_text === '') {
      drop(row, 'empty')
      continue
    }
    // §4.3b (ratified post-Wave-1): uniqueness is judged against the ENTIRE
    // body, because acceptance and re-anchoring re-locate by unique
    // whole-body match (§4.4-4.5) — a hunk that survives creation must always
    // be acceptable against an unchanged body. A duplicate outside the scope
    // is therefore 'ambiguous', never ignorable. Scope only decides WHERE the
    // unique match must land: a unique match that touches no scoped
    // paragraph drops as 'no_match'. Scope absent = all paragraphs.
    const matches = findAll(body, row.original_text)
    if (matches.length === 0) {
      drop(row, 'no_match')
      continue
    }
    if (matches.length > 1) {
      drop(row, 'ambiguous')
      continue
    }
    const start = matches[0]
    const end = start + row.original_text.length
    if (!scopeSpans.some((s) => spansIntersect(start, end, s.start, s.end))) {
      drop(row, 'no_match')
      continue
    }
    const container = spans.findIndex((s) => s.start <= start && end <= s.end)
    if (container === -1) {
      drop(row, 'crosses_paragraphs')
      continue
    }
    row.paragraph_index = container + 1
    row._start = start
    row._end = end
  }

  // Overlap: position order decides — a hunk intersecting any earlier-placed
  // surviving hunk's span is dropped (§4.3d).
  const survivors = rows
    .filter((row) => row.status === 'pending')
    .sort((a, b) => a._start - b._start || a.seq - b.seq)
  const kept = []
  for (const row of survivors) {
    if (kept.some((k) => spansIntersect(row._start, row._end, k._start, k._end))) drop(row, 'overlap')
    else kept.push(row)
  }

  return rows
}

export function createProposals({ store }) {
  // Resolve a proposal target to its current body + base revision. Voice
  // bodies use the same paragraph semantics as draft bodies.
  function currentTarget(targetKind, targetId) {
    if (targetKind === 'draft') {
      const draft = store.getDraft(targetId)
      if (!draft) return { error: `unknown draft ${targetId}` }
      if (!draft.current_revision_id) return { error: 'draft has no revision to target' }
      const revision = store.getRevision(draft.current_revision_id)
      if (!revision) return { error: `missing revision ${draft.current_revision_id}` }
      return { body: revision.body_text ?? '', baseRevisionId: revision.id, draftId: targetId }
    }
    if (targetKind === 'voice') {
      const voice = store.getVoice(targetId)
      if (!voice) return { error: `unknown voice ${targetId}` }
      if (!voice.current_revision_id) return { error: 'voice has no revision to target' }
      return { body: voice.body_md ?? '', baseRevisionId: voice.current_revision_id, draftId: null }
    }
    return { error: `unknown target kind ${targetKind}` }
  }

  function proposalDraftId(proposal) {
    return proposal.target_kind === 'draft' ? proposal.target_id : null
  }

  // A pending proposal with no pending hunks left is resolved (§4.6).
  function resolveIfDone(proposalId) {
    const proposal = store.getProposal(proposalId, { withHunks: true })
    if (!proposal || proposal.status !== 'pending') return
    const stillPending = (proposal.hunks ?? []).some((h) => h.status === 'pending')
    if (!stillPending) store.updateProposal(proposalId, { status: 'resolved', resolved_at: now() })
  }

  // §4.6: a superseded proposal's pending hunks resolve as superseded-implicit
  // (marked stale — stale is terminal; re-propose creates a new proposal).
  function supersede(proposalId) {
    const proposal = store.getProposal(proposalId, { withHunks: true })
    if (!proposal || proposal.status !== 'pending') return
    for (const hunk of proposal.hunks ?? []) {
      if (hunk.status === 'pending') store.updateHunk(hunk.id, { status: 'stale', resolved_at: now() })
    }
    store.updateProposal(proposalId, { status: 'superseded', resolved_at: now() })
  }

  // CONTRACTS §4.1-4.3. Every hunk is validated before anything is visible;
  // dropped hunks are stored (status 'dropped' + drop_reason) so the UI can
  // say "N changes proposed · M couldn't be anchored safely".
  function validateAndCreate({ targetKind, targetId, intent, scope, origin, modelId, rawHunks }) {
    const target = currentTarget(targetKind, targetId)
    if (target.error) return target

    const rows = validateHunks(target.body, scope, Array.isArray(rawHunks) ? rawHunks : [])
    const droppedRows = rows.filter((row) => row.status === 'dropped')
    const invalidated = rows.length === 0 || droppedRows.length === rows.length

    // The store exposes a single pendingProposal() per target and the UI
    // renders one pending proposal at a time, so a surviving new proposal
    // supersedes any pending predecessor. This is also the §4.6 comment-
    // revise mechanic (new proposal → parent superseded). A proposal that
    // failed validation outright supersedes nothing.
    if (!invalidated) {
      const prior = store.pendingProposal(targetKind, targetId)
      if (prior) supersede(prior.id)
    }

    const meta = store.createProposal({
      target_kind: targetKind,
      target_id: targetId,
      base_revision_id: target.baseRevisionId,
      intent_text: intent ?? '',
      scope_json: Array.isArray(scope) && scope.length > 0 ? JSON.stringify(scope) : null,
      origin,
      model_id: modelId ?? null,
      hunks: rows.map(({ _start, _end, ...row }) => ({
        ...row,
        resolved_at: row.status === 'dropped' ? now() : null,
      })),
    })
    if (invalidated) store.updateProposal(meta.id, { status: 'invalidated', resolved_at: now() })

    const proposal = store.getProposal(meta.id, { withHunks: true })
    store.appendProvenance({
      draftId: target.draftId,
      kind: 'proposal_created',
      payload: {
        proposal_id: proposal.id,
        target_kind: targetKind,
        target_id: targetId,
        origin,
        status: proposal.status,
        hunks: rows.length,
        dropped: droppedRows.length,
      },
    })
    if (droppedRows.length > 0) {
      store.appendProvenance({
        draftId: target.draftId,
        kind: 'hunks_dropped',
        payload: {
          proposal_id: proposal.id,
          dropped: droppedRows.map((row) => ({ seq: row.seq, drop_reason: row.drop_reason })),
        },
      })
    }

    return { proposal, dropped: droppedRows.length }
  }

  function loadPendingHunk(hunkId) {
    const hunk = store.getHunk(hunkId)
    if (!hunk) return { error: `unknown hunk ${hunkId}` }
    if (hunk.status !== 'pending') return { error: `hunk is ${hunk.status}, not pending` }
    const proposal = store.getProposal(hunk.proposal_id)
    if (!proposal) return { error: `missing proposal ${hunk.proposal_id}` }
    if (proposal.status !== 'pending') {
      return { error: `proposal is ${proposal.status}; its hunks are immutable` }
    }
    return { hunk, proposal }
  }

  // §4.5: after every new revision, from any source. Each pending hunk must
  // match exactly once in the ENTIRE new body or it goes stale (terminal).
  // Scope was enforced at creation and is never re-mapped.
  function reanchor(targetKind, targetId) {
    const target = currentTarget(targetKind, targetId)
    if (target.error) return { ...target, hunk_changes: [] }
    const body = nfc(String(target.body ?? ''))

    const pending = store.pendingProposal(targetKind, targetId)
    if (!pending) return { hunk_changes: [] }
    const proposal = store.getProposal(pending.id, { withHunks: true })

    const changes = []
    for (const hunk of proposal.hunks ?? []) {
      if (hunk.status !== 'pending') continue
      const matches = findAll(body, nfc(hunk.original_text))
      if (matches.length !== 1) {
        store.updateHunk(hunk.id, { status: 'stale', resolved_at: now() })
        changes.push({ hunk_id: hunk.id, status: 'stale' })
      }
    }
    resolveIfDone(proposal.id)
    return { hunk_changes: changes }
  }

  // §4.4: re-locate by unique match in the CURRENT body, replace, collapse
  // the seam for whole-span deletions, append a proposal_accept revision,
  // then run the re-anchor pass over the remaining pending hunks.
  function acceptHunk(hunkId) {
    const loaded = loadPendingHunk(hunkId)
    if (loaded.error) return loaded
    const { hunk, proposal } = loaded

    const target = currentTarget(proposal.target_kind, proposal.target_id)
    if (target.error) return target

    let body
    try {
      body = applyToBody(target.body, hunk)
    } catch (err) {
      // A pending hunk whose anchor no longer holds means a re-anchor pass
      // was missed or raced. Stale it instead of corrupting the body.
      store.updateHunk(hunkId, { status: 'stale', resolved_at: now() })
      resolveIfDone(proposal.id)
      return { error: `hunk no longer anchors (${err.message}); marked stale` }
    }

    const revision =
      proposal.target_kind === 'draft'
        ? store.appendRevision({
            draftId: proposal.target_id,
            body,
            source: 'proposal_accept',
            proposalId: proposal.id,
            hunkId,
          })
        : store.appendVoiceRevision({
            voiceId: proposal.target_id,
            body,
            source: 'proposal_accept',
            proposalId: proposal.id,
          })

    store.updateHunk(hunkId, { status: 'accepted', resolved_at: now() })
    store.appendProvenance({
      draftId: proposalDraftId(proposal),
      kind: 'hunk_accepted',
      payload: { proposal_id: proposal.id, hunk_id: hunkId, revision_id: revision.id },
    })

    const pass = reanchor(proposal.target_kind, proposal.target_id)
    resolveIfDone(proposal.id)

    return {
      revision_id: revision.id,
      body,
      hunk_changes: [{ hunk_id: hunkId, status: 'accepted' }, ...pass.hunk_changes],
    }
  }

  // Reject never touches the body: mark the hunk, keep the comment verbatim
  // on the row and in provenance — it is the flywheel's strongest signal.
  function rejectHunk(hunkId, comment) {
    const loaded = loadPendingHunk(hunkId)
    if (loaded.error) return loaded
    const { proposal } = loaded

    const verbatim = typeof comment === 'string' && comment !== '' ? comment : null
    store.updateHunk(hunkId, { status: 'rejected', comment: verbatim, resolved_at: now() })
    store.appendProvenance({
      draftId: proposalDraftId(proposal),
      kind: 'hunk_rejected',
      payload: {
        proposal_id: proposal.id,
        hunk_id: hunkId,
        ...(verbatim !== null ? { comment: verbatim } : {}),
      },
    })
    resolveIfDone(proposal.id)
    return { ok: true, hunk_changes: [{ hunk_id: hunkId, status: 'rejected' }] }
  }

  // §4.6: dismissal resolves all pending hunks as stale. A plain dismiss
  // logs proposal_dismissed; takeover ("I'll write it myself") logs
  // human_takeover instead — the strongest rejection signal the flywheel
  // gets (supervisor ruling: the two kinds are mutually exclusive).
  function dismiss(proposalId, { takeover = false } = {}) {
    const proposal = store.getProposal(proposalId, { withHunks: true })
    if (!proposal) return { error: `unknown proposal ${proposalId}` }
    if (proposal.status !== 'pending') return { error: `proposal is ${proposal.status}, not pending` }

    let dismissed = 0
    for (const hunk of proposal.hunks ?? []) {
      if (hunk.status !== 'pending') continue
      store.updateHunk(hunk.id, { status: 'stale', resolved_at: now() })
      dismissed++
    }
    store.updateProposal(proposalId, { status: 'dismissed', resolved_at: now() })
    store.appendProvenance({
      draftId: proposalDraftId(proposal),
      kind: takeover ? 'human_takeover' : 'proposal_dismissed',
      payload: { proposal_id: proposalId, hunks_dismissed: dismissed },
    })
    return { ok: true, dismissed }
  }

  return { validateAndCreate, acceptHunk, rejectHunk, reanchor, dismiss }
}
