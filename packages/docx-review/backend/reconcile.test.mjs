import { describe, it, expect, vi } from 'vitest'
import {
  findAllOccurrencesWorkerFaithful,
  resolveOccurrence,
  nthOccurrenceInText,
  assignFallbackOccurrenceForCollisions,
  buildNumberedComments,
  preGroupByAnchor,
  synthesizeFallbackReport,
  fallbackReconcile,
  reconcileReview,
} from './reconcile.mjs'

// ---------------------------------------------------------------------------
// Pure: occurrence counting (must mirror the C# worker exactly)
// ---------------------------------------------------------------------------

describe('findAllOccurrencesWorkerFaithful', () => {
  it('C1 counts per-paragraph recurrences in document order', () => {
    const text = 'no power calculation here\n\nand again no power calculation there'
    const occs = findAllOccurrencesWorkerFaithful(text, 'no power calculation')
    expect(occs.map(o => o.index)).toEqual([0, 1])
    expect(occs[0].charStart).toBeLessThan(occs[1].charStart)
  })
  it('C2 counts OVERLAPPING matches (aa in aaaa -> 3)', () => {
    expect(findAllOccurrencesWorkerFaithful('aaaa', 'aa').length).toBe(3)
  })
  it('C3 no whitespace normalization in the exact path', () => {
    // one-space snippet does not match a double-space occurrence
    expect(findAllOccurrencesWorkerFaithful('a  b', 'a b')).toEqual([])
  })
  it('C4 empty needle -> []; needle at end is counted', () => {
    expect(findAllOccurrencesWorkerFaithful('hello', '')).toEqual([])
    expect(findAllOccurrencesWorkerFaithful('the end', 'end').length).toBe(1)
  })
})

describe('resolveOccurrence', () => {
  const paper = 'Alpha the value one\n\nBeta the value two\n\nGamma the value three'
  it('C5 unique snippet -> index 0', () => {
    expect(resolveOccurrence('only one here', 'one here')).toEqual({ index: 0 })
  })
  it('C6 recurring without disambiguator -> error', () => {
    const r = resolveOccurrence(paper, 'the value')
    expect(r.error).toMatch(/occurs 3 times/)
  })
  it('C7 recurring with correct disambiguator -> the right index', () => {
    expect(resolveOccurrence(paper, 'the value', 'Gamma ')).toEqual({ index: 2 })
    expect(resolveOccurrence(paper, 'the value', 'Beta ')).toEqual({ index: 1 })
  })
  it('C8 disambiguator matches none -> error', () => {
    expect(resolveOccurrence(paper, 'the value', 'Zeta ').error).toMatch(/did not match/)
  })
  it('C9 zero exact occurrences -> normalized fallback index 0', () => {
    expect(resolveOccurrence('a  b', 'a b')).toEqual({ index: 0, normalized: true })
  })
})

describe('nthOccurrenceInText', () => {
  it('C10 returns the nth (overlapping) start; out-of-range -> -1', () => {
    expect(nthOccurrenceInText('aaaa', 'aa', 0)).toBe(0)
    expect(nthOccurrenceInText('aaaa', 'aa', 1)).toBe(1)
    expect(nthOccurrenceInText('aaaa', 'aa', 2)).toBe(2)
    expect(nthOccurrenceInText('aaaa', 'aa', 9)).toBe(-1)
    expect(nthOccurrenceInText('abc', 'zz', 0)).toBe(-1)
  })
})

describe('assignFallbackOccurrenceForCollisions', () => {
  const paper = 'x the value 1\n\ny the value 2\n\nz the value 3'
  it('C11 two collisions on a 3x snippet -> distinct indices 0,1', () => {
    const final = [
      { text_snippet: 'the value', occurrenceIndex: 0 },
      { text_snippet: 'the value', occurrenceIndex: 0 },
    ]
    assignFallbackOccurrenceForCollisions(final, paper)
    expect(final.map(c => c.occurrenceIndex).sort()).toEqual([0, 1])
  })
  it('C12 three comments on a 2x snippet -> 0,1,1 (clamped) + conflict logged', () => {
    const twice = 'a the value\n\nb the value'
    const final = [
      { text_snippet: 'the value', occurrenceIndex: 0 },
      { text_snippet: 'the value', occurrenceIndex: 0 },
      { text_snippet: 'the value', occurrenceIndex: 0 },
    ]
    const conflicts = []
    assignFallbackOccurrenceForCollisions(final, twice, conflicts)
    expect(final.map(c => c.occurrenceIndex)).toEqual([0, 1, 1])
    expect(conflicts.length).toBeGreaterThan(0)
  })
  it('preserves already-distinct disambiguated occurrences', () => {
    const final = [
      { text_snippet: 'the value', occurrenceIndex: 0 },
      { text_snippet: 'the value', occurrenceIndex: 2 },
    ]
    assignFallbackOccurrenceForCollisions(final, paper)
    expect(final.map(c => c.occurrenceIndex)).toEqual([0, 2])
  })
})

describe('buildNumberedComments', () => {
  it('C13 sorts by charStart, numbers, ids, joins reviewers', () => {
    const numbered = buildNumberedComments([
      { text_snippet: 'b', charStart: 50, severity: 'minor', content: 'B', sourceReviewers: ['Editorial Reviewer'] },
      { text_snippet: 'a', charStart: 10, severity: 'major', content: 'A', sourceReviewers: ['Technical Reviewer', 'Editorial Reviewer'] },
    ])
    expect(numbered.map(c => c.id)).toEqual(['comment-1', 'comment-2'])
    expect(numbered.map(c => c.number)).toEqual([1, 2])
    expect(numbered[0].text_snippet).toBe('a')
    expect(numbered[0].reviewer).toBe('Technical Reviewer, Editorial Reviewer')
  })
})

describe('preGroupByAnchor', () => {
  it('C14 groups identical + containment, leaves unrelated separate', () => {
    const groups = preGroupByAnchor([
      { rawId: 't0', text_snippet: 'the sample size' },
      { rawId: 'e0', text_snippet: 'The Sample Size' },
      { rawId: 't1', text_snippet: 'the sample size was small' },
      { rawId: 'r0', text_snippet: 'unrelated citation' },
    ])
    const joined = groups.map(g => g.sort().join(','))
    expect(joined).toContain('e0,t0,t1')
    expect(joined.join(';')).not.toContain('r0')
  })
})

describe('synthesizeFallbackReport / fallbackReconcile', () => {
  it('C15 fallback report groups by severity with counts', () => {
    const r = synthesizeFallbackReport([
      { severity: 'major', content: 'Underpowered study' },
      { severity: 'minor', content: 'Typo' },
    ])
    expect(r).toMatch(/1 major/)
    expect(r).toMatch(/Underpowered study/)
  })
  it('C16 fallbackReconcile dedups, assigns occurrence, normalizes severity, reports', () => {
    const paper = 'We used a t-test\n\nThe p was 0.049'
    const { final, report } = fallbackReconcile([
      { rawId: 't0', reviewer: 'Technical Reviewer', text_snippet: 'We used a t-test', content: 'a', severity: 'major' },
      { rawId: 't1', reviewer: 'Technical Reviewer', text_snippet: 'We used a t-test', content: 'dup', severity: 'critical' },
    ], paper)
    expect(final).toHaveLength(1) // deduped by snippet
    expect(final[0].occurrenceIndex).toBe(0)
    expect(final[0].severity).toBe('major')
    expect(report).toMatch(/Peer Review Summary/)
  })
})

// ---------------------------------------------------------------------------
// reconcileReview with a scripted ctx.ai.callModel driving the tools
// ---------------------------------------------------------------------------

const PAPER = [
  '# Study',
  'We used a two-sample t-test with no power calculation.',
  'The effect was significant (p = 0.049).',
  'The estimate was robust across the value one and the value two and the value three.',
].join('\n\n')

const HTML =
  '<h1>Study</h1>' +
  '<p>We used a two-sample t-test with no power calculation.</p>' +
  '<p>The effect was significant (p = 0.049).</p>' +
  '<p>The estimate was robust across the value one and the value two and the value three.</p>'

function makeReconcileCtx(handler) {
  const progress = []
  return {
    ai: {
      callModel: vi.fn(async (opts) => {
        if (!opts.tools?.length) {
          return {
            text: 'Summary.',
            usage: { input: 3, output: 4, cacheRead: 0, cacheCreation: 0 },
          }
        }
        await handler(opts)
        return { usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 } }
      }),
    },
    progress: {
      progress: vi.fn(async (value, label) => { progress.push([value, label]) }),
    },
  }
}

const tool = (opts, name) => opts.tools.find(t => t.name === name)
const batchDecide = async (opts, decisions) => tool(opts, 'decide_comments').execute({ decisions })
const baseOpts = (rawComments, extra = {}) => ({
  paperMarkdown: PAPER, anchorText: PAPER, html: HTML, rawComments,
  citationSummary: null, reviewModel: 'claude-sonnet-4-6', reviewNotes: '',
  budget: { paperCharBudget: Infinity, maxOutputTokens: 48000 }, ...extra,
})

describe('reconcileReview (agent loop)', () => {
  it('C24 merge preserves perspectives + origin + clamped severity', async () => {
    const raw = [
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'underpowered' },
      { reviewer: 'Editorial Reviewer', severity: 'minor', text_snippet: 'no power calculation', content: 'also overstated' },
    ]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'merge', source_ids: ['t0', 'e0'], text_snippet: 'no power calculation', content: 'Technical: underpowered. Editorial: overstated.', severity: 'major' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(res.comments).toHaveLength(1)
    expect(res.comments[0].sourceReviewers).toEqual(['Technical Reviewer', 'Editorial Reviewer'])
    expect(res.comments[0].origin.sort()).toEqual(['e0', 't0'])
    expect(res.comments[0].severity).toBe('major')
    expect(res.report).toBe('Summary.')
  })

  it('C25 drop is logged, never silent', async () => {
    const raw = [
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'keep me' },
      { reviewer: 'Editorial Reviewer', severity: 'minor', text_snippet: 'p = 0.049', content: 'drop me' },
    ]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'keep me', severity: 'major' },
        { action: 'drop', source_ids: ['e0'], reason: 'not actionable' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(res.comments).toHaveLength(1)
    expect(res.dropped).toEqual([{ rawId: 'e0', snippet: 'p = 0.049', reviewer: 'Editorial Reviewer', reason: 'not actionable' }])
  })

  it('C26 rejects empty batches before full coverage', async () => {
    const raw = [
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' },
      { reviewer: 'Editorial Reviewer', severity: 'minor', text_snippet: 'p = 0.049', content: 'b' },
    ]
    let emptyBatch
    const ctx = makeReconcileCtx(async (opts) => {
      emptyBatch = await tool(opts, 'decide_comments').execute({ decisions: [] })
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'major' },
        { action: 'keep', source_ids: ['e0'], text_snippet: 'p = 0.049', content: 'b', severity: 'minor' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(emptyBatch.success).toBe(false)
    expect(emptyBatch.error).toMatch(/decisions/)
    expect(res.report).toBe('Summary.')
  })

  it('C27 unaccounted-at-finish are auto-kept (recall guarantee)', async () => {
    const raw = [
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' },
      { reviewer: 'Editorial Reviewer', severity: 'minor', text_snippet: 'p = 0.049', content: 'never decided' },
    ]
    const ctx = makeReconcileCtx(async (opts) => {
      // only decide t0, then stop (e0 left unaccounted)
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'major' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(res.comments).toHaveLength(2)
    expect(res.techNotes.autoKept).toContain('e0')
    expect(res.comments.some(c => c.content === 'never decided')).toBe(true)
  })

  it('C28 invalid anchor rejected in-loop; valid retry accepted; logged', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }]
    let rej
    const ctx = makeReconcileCtx(async (opts) => {
      rej = await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'TEXT NOT IN PAPER', content: 'a', severity: 'major' },
      ])
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'major' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(rej.success).toBe(false)
    expect(rej.failed[0].error).toBe('text_snippet is not a verbatim substring of the paper')
    expect(res.comments).toHaveLength(1)
    expect(res.techNotes.rejectedAnchors.length).toBeGreaterThan(0)
  })

  it('C29 ambiguous anchor forces a disambiguator', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'minor', text_snippet: 'the value', content: 'which one?' }]
    let ambiguous
    const ctx = makeReconcileCtx(async (opts) => {
      ambiguous = await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'the value', content: 'which one?', severity: 'minor' },
      ])
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'the value', content: 'the third', severity: 'minor', disambiguator_before: 'two and ' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(ambiguous.success).toBe(false)
    expect(ambiguous.failed[0].error).toMatch(/occurs 3 times/)
    expect(res.comments[0].occurrenceIndex).toBe(2)
  })

  it('C31 severity is clamped to the enum', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'critical' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    expect(res.comments[0].severity).toBe('suggestion')
  })

  it('C23 DOCX/HTML agreement: occurrence 2 with disambiguator lands on the 3rd mark', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'minor', text_snippet: 'the value', content: 'third occurrence' }]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'the value', content: 'third occurrence', severity: 'minor', disambiguator_before: 'two and ' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    // DOCX side: the op's occurrenceIndex (== comment.occurrenceIndex) is 2
    expect(res.comments[0].occurrenceIndex).toBe(2)
    // HTML side: the mark wraps the 3rd "the value" (the one after "two and ")
    expect(res.anchoredHtml).toContain('two and <mark data-comment-id="comment-1" data-severity="minor">the value</mark>')
  })

  it('C33 degraded mode: callModel fails twice -> fallbackReconcile, still anchored', async () => {
    vi.useFakeTimers()
    try {
      const raw = [{ reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }]
      const ctx = { ai: { callModel: vi.fn(async () => { throw new Error('provider down') }) } }
      const p = reconcileReview(ctx, baseOpts(raw))
      await vi.advanceTimersByTimeAsync(15_000)
      const res = await p
      expect(res.techNotes.degraded).toBe('reconciler_unavailable')
      expect(res.comments).toHaveLength(1)
      expect(res.anchoredHtml).toContain('<mark')
    } finally {
      vi.useRealTimers()
    }
  })

  it('C34 multi-provider: runs on a google model id the same way', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }]
    const ctx = makeReconcileCtx(async (opts) => {
      expect(opts.modelId).toBe('gemini-3.1-pro-preview')
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'major' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw, { reviewModel: 'gemini-3.1-pro-preview' }))
    expect(res.comments).toHaveLength(1)
  })

  it('C35 drop-audit completeness: origin ∪ dropped covers all rawIds', async () => {
    const raw = [
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' },
      { reviewer: 'Editorial Reviewer', severity: 'minor', text_snippet: 'p = 0.049', content: 'b' },
      { reviewer: 'Reference Checker', severity: 'minor', text_snippet: 'the value one', content: 'c' },
    ]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'merge', source_ids: ['t0', 'e0'], text_snippet: 'no power calculation', content: 'merged', severity: 'major' },
        { action: 'drop', source_ids: ['r0'], reason: 'redundant' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    const originIds = res.comments.flatMap(c => c.origin)
    const droppedCount = res.dropped.length
    expect(new Set(originIds).size + droppedCount).toBe(3)
  })

  it('emits one determinate progress update per successful reconciliation batch', async () => {
    const raw = [
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' },
      { reviewer: 'Editorial Reviewer', severity: 'minor', text_snippet: 'p = 0.049', content: 'b' },
    ]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'major' },
        { action: 'drop', source_ids: ['e0'], reason: 'not actionable' },
      ])
    })
    await reconcileReview(ctx, baseOpts(raw))
    expect(ctx.progress.progress).toHaveBeenCalledWith(0.88, 'Reconciling 2/2')
    expect(ctx.progress.progress).toHaveBeenCalledTimes(2)
  })

  it('uses the reconciler budget step cap instead of scaling steps with comment count', async () => {
    const raw = Array.from({ length: 47 }, () => (
      { reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }
    ))
    const ctx = makeReconcileCtx(async (opts) => {
      expect(opts.maxSteps).toBe(8)
    })
    await reconcileReview(ctx, baseOpts(raw, { budget: { paperCharBudget: Infinity, maxOutputTokens: 48000, maxSteps: 8 } }))
  })

  it('generates the summary from reconciled comments in a compact no-tool call', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }]
    const ctx = makeReconcileCtx(async (opts) => {
      await batchDecide(opts, [
        { action: 'keep', source_ids: ['t0'], text_snippet: 'no power calculation', content: 'a', severity: 'major' },
      ])
    })
    const res = await reconcileReview(ctx, baseOpts(raw))
    const summaryCall = ctx.ai.callModel.mock.calls.map(call => call[0]).find(call => !call.tools?.length)
    expect(summaryCall).toBeTruthy()
    expect(summaryCall.messages[0].content).toContain('"number":1')
    expect(summaryCall.messages[0].content).not.toContain(PAPER)
    expect(res.report).toBe('Summary.')
  })

  it('budget overflow -> loud failure (decision #1)', async () => {
    const raw = [{ reviewer: 'Technical Reviewer', severity: 'major', text_snippet: 'no power calculation', content: 'a' }]
    const ctx = makeReconcileCtx(async () => {})
    const res = await reconcileReview(ctx, baseOpts(raw, { budget: { paperCharBudget: 10, maxOutputTokens: 48000 } }))
    expect(res.status).toBe('failed')
    expect(res.reason).toMatch(/exceeds the selected model context window/)
  })
})
