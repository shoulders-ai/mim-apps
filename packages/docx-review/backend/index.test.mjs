import { describe, it, expect, vi } from 'vitest'
import {
  jobs,
  tools,
  parseJsonObject,
  normalizeCommentShape,
  normalizeSeverity,
  validateAnchors,
  deduplicateComments,
  anchorCommentsInHtml,
  mapTextPositions,
  decodeEntity,
  normToOrigIndex,
  reviewMarkdownReport,
  siblingPath,
  addUsage,
  imageContent,
  failedAnnotationComments,
  parseCrossrefItem,
} from './index.mjs'
import { charsFromTokens, PER_IMAGE_TOKENS } from './budget.mjs'

// ---------------------------------------------------------------------------
// Shared fixtures: a small fake paper plus a fake package ctx whose ai /
// documents / tools boundaries are scripted per scenario.
// ---------------------------------------------------------------------------

const SNIPPET_HYPOTHESIS = 'We hypothesise that the intervention improves outcomes in adults.'
const SNIPPET_TTEST = 'We used a two-sample t-test with n=12 participants and no power calculation.'
const SNIPPET_PVALUE = 'The effect was significant (p = 0.049) with a large effect size.'
const SNIPPET_REF = 'Journal of Examples. 2020.'

const PAPER_MARKDOWN = [
  '# Effect of the intervention',
  '## Introduction',
  SNIPPET_HYPOTHESIS,
  '## Methods',
  SNIPPET_TTEST,
  '## Results',
  SNIPPET_PVALUE,
  '## References',
  `[1] Smith J, Jones K. A study of things. ${SNIPPET_REF}`,
].join('\n\n')

const PAPER_HTML =
  '<h1>Effect of the intervention</h1>' +
  `<p>${SNIPPET_HYPOTHESIS}</p>` +
  `<p>${SNIPPET_TTEST}</p>` +
  `<p>${SNIPPET_PVALUE}</p>` +
  `<p>[1] Smith J, Jones K. A study of things. ${SNIPPET_REF}</p>`

const DEFAULT_REGISTRY = {
  models: [
    { id: 'anthropic:sonnet', model: 'claude-sonnet-4-6', provider: 'anthropic', contextWindow: 200_000, capabilities: { text: true, tools: true } },
    { id: 'openai:gpt', model: 'gpt-9', provider: 'openai', contextWindow: 200_000, capabilities: { text: true, tools: true } },
  ],
  defaults: { agent: ['anthropic:sonnet'] },
}

const defaultTechnical = async ({ submit }) => {
  await submit.execute({
    comments: [
      { text_snippet: SNIPPET_TTEST, content: 'No power calculation; justify the sample size.', severity: 'major' },
      { text_snippet: SNIPPET_PVALUE, content: 'Borderline p-value; report exact CI.', severity: 'critical' },
    ],
  })
}

const defaultEditorial = async ({ submit }) => {
  await submit.execute({
    comments: [
      { text_snippet: SNIPPET_HYPOTHESIS, content: 'State the hypothesis direction.', severity: 'minor' },
      { text_snippet: SNIPPET_TTEST, content: 'Duplicate angle on the t-test.', severity: 'minor' },
    ],
  })
}

const defaultReference = async ({ submit }) => {
  await submit.execute({
    summary: 'All references verified against Crossref.',
    comments: [{ text_snippet: SNIPPET_REF, content: 'Confirm the journal name.', severity: 'minor' }],
  })
}

// Drives the reconciler tool loop the way a real model would: group raw comments
// by snippet, merge same-snippet groups, and keep singletons in one batched tool
// call. The report is generated later from the reconciled comment list.
const defaultReconcile = async ({ tools, opts, scenario }) => {
  const decide = tools.find(tool => tool.name === 'decide_comments')
  const content = typeof opts.messages[0].content === 'string' ? opts.messages[0].content : ''
  let raw = []
  try { raw = JSON.parse(content.split(/Raw comments[^\n]*\n/)[1] || '[]') } catch { raw = [] }
  const groups = new Map()
  for (const c of raw) {
    const key = (c.text_snippet || '').trim().replace(/\s+/g, ' ')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const decisions = []
  for (const group of groups.values()) {
    const ids = group.map(c => c.rawId)
    decisions.push({
      action: ids.length > 1 ? 'merge' : 'keep',
      source_ids: ids,
      text_snippet: group[0].text_snippet,
      content: group.map(c => c.content).join(' '),
      severity: group[0].severity,
    })
  }
  await decide.execute({ decisions })
}

function makeCtx(scenario = {}) {
  const log = { ai: [], toolCalls: [], annotateCalls: [], writes: [], puts: [], progress: [] }
  const findTool = (opts, name) => (opts.tools || []).find(tool => tool.name === name)
  const ctx = {
    job: { runId: scenario.runId || '0123456789abcdef' },
    ai: {
      // Every stage now runs on the provider-agnostic callModel; route by the
      // tools/system present in the request.
      async callModel(opts) {
        log.ai.push(opts)
        if (findTool(opts, 'submit_review')) {
          const isTechnical = /biostatistician/i.test(opts.system)
          const handler = isTechnical
            ? (scenario.technical ?? defaultTechnical)
            : (scenario.editorial ?? defaultEditorial)
          await handler({ submit: findTool(opts, 'submit_review'), guidance: findTool(opts, 'getGuidance'), opts })
          return { text: '', usage: { input: 100, output: 50 } }
        }
        if (findTool(opts, 'submit_citation_report')) {
          const handler = scenario.reference ?? defaultReference
          await handler({ submit: findTool(opts, 'submit_citation_report'), search: findTool(opts, 'search_references'), opts })
          return { text: '', usage: { input: 30, output: 10 } }
        }
        if (findTool(opts, 'submit_docx_anchor_repairs')) {
          if (scenario.repair) await scenario.repair({ submit: findTool(opts, 'submit_docx_anchor_repairs'), opts })
          return { text: '', usage: { input: 5, output: 5 } }
        }
        if (findTool(opts, 'decide_comments')) {
          const handler = scenario.reconcile ?? defaultReconcile
          await handler({ tools: opts.tools || [], opts, scenario })
          return { text: '', usage: { input: 40, output: 40 } }
        }
        if (/intake classifier/i.test(opts.system)) {
          const text = scenario.gatekeeperText ??
            JSON.stringify({ eligible: true, domain_hint: 'health economics', reason: 'research paper' })
          return { text, usage: { input: 10, output: 5 } }
        }
        if (/peer-review summary/i.test(opts.system)) {
          return {
            text: scenario.reportText ?? '## Peer Review Summary\n\nSolid paper, fix the stats.',
            usage: { input: 15, output: 8 },
          }
        }
        return { text: '', usage: { input: 20, output: 20 } }
      },
    },
    progress: {
      step: async label => { log.progress.push(['step', label]) },
      progress: async (value, label) => { log.progress.push(['progress', value, label]) },
      log: async message => { log.progress.push(['log', message]) },
      done: async label => { log.progress.push(['done', label]) },
    },
    data: {
      collection: name => ({ put: async (key, value) => { log.puts.push({ name, key, value }) } }),
    },
    documents: {
      docx: {
        workerStatus: async () => scenario.workerStatus ?? { available: true },
        extract: async () => scenario.extraction ?? { html: PAPER_HTML, markdown: PAPER_MARKDOWN, images: scenario.images ?? [] },
        annotate: async (sourcePath, operations, opts) => {
          log.annotateCalls.push({ sourcePath, operations, opts })
          if (scenario.annotate) return scenario.annotate({ operations, call: log.annotateCalls.length })
          return { success: true, results: operations.map(() => ({ success: true })) }
        },
      },
    },
    tools: {
      call: async (name, args) => {
        log.toolCalls.push({ name, args })
        if (name === 'ai.registry') return scenario.registry ?? DEFAULT_REGISTRY
        if (name === 'fs.write') { log.writes.push(args); return { ok: true } }
        if (name === 'package.jobs.start') return { runId: 'started', args }
        return {}
      },
    },
  }
  return { ctx, log }
}

const reconcileCall = log => log.ai.find(call => (call.tools || []).some(tool => tool.name === 'decide_comments'))
const summaryCall = log => log.ai.find(call => !call.tools?.length && /peer-review summary/i.test(call.system || ''))
const reviewerCall = (log, marker) => log.ai.find(call => (call.tools || []).some(tool => tool.name === 'submit_review') && marker.test(call.system))
const reviewerPaperText = call => call.messages[0].content.filter(part => part.type === 'text').map(part => part.text).join('\n')

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseJsonObject', () => {
  it('parses a plain JSON object', () => {
    expect(parseJsonObject('{"eligible": true, "reason": "ok"}')).toEqual({ eligible: true, reason: 'ok' })
  })

  it('strips markdown json fences', () => {
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
  })

  it('extracts a JSON object embedded in prose', () => {
    expect(parseJsonObject('Sure! Here is my verdict: {"eligible": false} Hope that helps.')).toEqual({ eligible: false })
  })

  it('returns null for unparseable output', () => {
    expect(parseJsonObject('not json at all')).toBeNull()
    expect(parseJsonObject('')).toBeNull()
    expect(parseJsonObject(null)).toBeNull()
    expect(parseJsonObject('{broken: yes}')).toBeNull()
  })
})

describe('normalizeCommentShape / normalizeSeverity', () => {
  it('accepts a complete comment and trims fields', () => {
    const { comment, reason } = normalizeCommentShape({ text_snippet: '  snippet here  ', content: ' fix it ', severity: 'major' })
    expect(reason).toBeNull()
    expect(comment).toEqual({ text_snippet: 'snippet here', content: 'fix it', severity: 'major' })
  })

  it('rejects non-objects, missing snippet, and missing content', () => {
    expect(normalizeCommentShape(null).reason).toBe('Comment must be an object')
    expect(normalizeCommentShape('text').reason).toBe('Comment must be an object')
    expect(normalizeCommentShape([]).reason).toBe('Comment must be an object')
    expect(normalizeCommentShape({ content: 'x' }).reason).toBe('Missing text_snippet')
    expect(normalizeCommentShape({ text_snippet: 'snippet', severity: 'major' }).reason).toBe('Missing content')
  })

  it('coerces unknown severities to suggestion', () => {
    expect(normalizeSeverity('major')).toBe('major')
    expect(normalizeSeverity('minor')).toBe('minor')
    expect(normalizeSeverity('suggestion')).toBe('suggestion')
    expect(normalizeSeverity('critical')).toBe('suggestion')
    expect(normalizeSeverity(undefined)).toBe('suggestion')
  })
})

describe('validateAnchors', () => {
  const doc = 'The quick brown fox\njumps   over the lazy dog.'

  it('accepts exact substrings and trims them', () => {
    const { valid, invalid } = validateAnchors([{ text_snippet: '  quick brown fox  ', content: 'c', severity: 'minor' }], doc)
    expect(invalid).toEqual([])
    expect(valid).toEqual([{ text_snippet: 'quick brown fox', content: 'c', severity: 'minor' }])
  })

  it('falls back to whitespace-normalized matching and stores the normalized snippet', () => {
    const { valid, invalid } = validateAnchors([{ text_snippet: 'fox jumps over', content: 'c', severity: 'major' }], doc)
    expect(invalid).toEqual([])
    expect(valid[0].text_snippet).toBe('fox jumps over')
  })

  it('rejects snippets shorter than 5 chars', () => {
    const { valid, invalid } = validateAnchors([{ text_snippet: 'fox', content: 'c', severity: 'minor' }], doc)
    expect(valid).toEqual([])
    expect(invalid[0].reason).toBe('Snippet too short (< 5 chars)')
  })

  it('rejects snippets not found in the document', () => {
    const { invalid } = validateAnchors([{ text_snippet: 'purple elephant', content: 'c', severity: 'minor' }], doc)
    expect(invalid[0].reason).toBe('Snippet not found in document')
  })

  it('rejects malformed comments with a reason instead of throwing', () => {
    const { valid, invalid } = validateAnchors([null, 42, { text_snippet: 'quick brown' }], doc)
    expect(valid).toEqual([])
    expect(invalid.map(entry => entry.reason)).toEqual([
      'Comment must be an object',
      'Comment must be an object',
      'Missing content',
    ])
  })
})

describe('deduplicateComments', () => {
  it('drops later comments whose snippet matches after whitespace normalization', () => {
    const deduped = deduplicateComments([
      { text_snippet: 'same  snippet', content: 'first' },
      { text_snippet: 'same snippet', content: 'second' },
      { text_snippet: 'other snippet', content: 'third' },
    ])
    expect(deduped.map(comment => comment.content)).toEqual(['first', 'third'])
  })

  it('keeps comments without a snippet', () => {
    const deduped = deduplicateComments([{ content: 'a' }, { content: 'b' }])
    expect(deduped).toHaveLength(2)
  })
})

describe('anchorCommentsInHtml', () => {
  it('wraps an exact match in a mark with comment id and severity', () => {
    const html = '<p>Alpha beta gamma delta.</p>'
    const out = anchorCommentsInHtml(html, [{ id: 'comment-1', severity: 'major', text_snippet: 'beta gamma' }])
    expect(out).toBe('<p>Alpha <mark data-comment-id="comment-1" data-severity="major">beta gamma</mark> delta.</p>')
  })

  it('matches text across HTML entities', () => {
    const html = '<p>Costs &amp; benefits were assessed.</p>'
    const out = anchorCommentsInHtml(html, [{ id: 'comment-1', severity: 'minor', text_snippet: 'Costs & benefits' }])
    expect(out).toContain('<mark data-comment-id="comment-1" data-severity="minor">Costs &amp; benefits</mark>')
  })

  it('matches snippets across whitespace differences in the HTML', () => {
    const html = '<p>Alpha\n   beta gamma.</p>'
    const out = anchorCommentsInHtml(html, [{ id: 'comment-1', severity: 'suggestion', text_snippet: 'Alpha beta' }])
    expect(out).toContain('<mark data-comment-id="comment-1" data-severity="suggestion">Alpha\n   beta</mark>')
  })

  it('processes comments in order and skips later overlapping ones (occurrence-aware)', () => {
    // Callers pass comments in document order; the overlap guard drops a later
    // comment whose range is already claimed by an earlier one.
    const html = '<p>one two three four</p>'
    const out = anchorCommentsInHtml(html, [
      { id: 'long', severity: 'major', text_snippet: 'one two three' },
      { id: 'short', severity: 'minor', text_snippet: 'two' },
    ])
    expect(out).toContain('data-comment-id="long"')
    expect(out).not.toContain('data-comment-id="short"')
  })

  it('anchors multiple disjoint snippets', () => {
    const html = '<p>first sentence here.</p><p>second sentence there.</p>'
    const out = anchorCommentsInHtml(html, [
      { id: 'c1', severity: 'minor', text_snippet: 'first sentence' },
      { id: 'c2', severity: 'major', text_snippet: 'second sentence' },
    ])
    expect(out).toContain('<mark data-comment-id="c1" data-severity="minor">first sentence</mark>')
    expect(out).toContain('<mark data-comment-id="c2" data-severity="major">second sentence</mark>')
  })

  it('returns the html unchanged for empty input or unfindable snippets', () => {
    const html = '<p>hello world</p>'
    expect(anchorCommentsInHtml(html, [])).toBe(html)
    expect(anchorCommentsInHtml(html, [{ id: 'c1', severity: 'minor', text_snippet: 'absent text' }])).toBe(html)
    expect(anchorCommentsInHtml('', [{ id: 'c1', severity: 'minor', text_snippet: 'hello' }])).toBe('')
  })
})

describe('mapTextPositions / decodeEntity / normToOrigIndex', () => {
  it('strips tags and decodes entities into a positionally mapped text', () => {
    const { text, starts, ends } = mapTextPositions('<p>A &amp; B</p>')
    expect(text).toBe('A & B')
    expect(starts).toHaveLength(text.length)
    expect(ends).toHaveLength(text.length)
    expect(starts[0]).toBe(3) // 'A' after '<p>'
    expect(starts[2]).toBe(5) // '&amp;' starts at index 5
    expect(ends[2]).toBe(10) // and ends after the ';'
  })

  it('decodes named, decimal, and hex entities and passes unknown ones through', () => {
    expect(decodeEntity('&amp;')).toBe('&')
    expect(decodeEntity('&rsquo;')).toBe('’')
    expect(decodeEntity('&#65;')).toBe('A')
    expect(decodeEntity('&#x41;')).toBe('A')
    expect(decodeEntity('&bogus;')).toBe('&bogus;')
  })

  it('maps normalized indices back to original indices across whitespace runs', () => {
    const text = 'a  b\tc'
    // normalized: 'a b c'
    expect(normToOrigIndex(text, 0)).toBe(0)
    expect(normToOrigIndex(text, 2)).toBe(3) // 'b'
    expect(normToOrigIndex(text, 4)).toBe(5) // 'c'
  })
})

describe('reviewMarkdownReport', () => {
  it('renders the summary and numbered comment sections', () => {
    const markdown = reviewMarkdownReport('SUMMARY TEXT', [
      { number: 1, severity: 'major', reviewer: 'Technical Reviewer', text_snippet: 'snip one', content: 'Fix this.' },
      { number: 2, severity: 'minor', reviewer: 'Editorial Reviewer', text_snippet: 'snip two', content: 'Clarify.' },
    ])
    expect(markdown).toContain('# Peer Review Report')
    expect(markdown).toContain('SUMMARY TEXT')
    expect(markdown).toContain('## Comments')
    expect(markdown).toContain('### 1. [major] - Technical Reviewer')
    expect(markdown).toContain('> "snip one"')
    expect(markdown).toContain('Fix this.')
    expect(markdown).toContain('### 2. [minor] - Editorial Reviewer')
  })

  it('omits empty sections', () => {
    const markdown = reviewMarkdownReport('', [])
    expect(markdown).toBe('# Peer Review Report\n\n')
  })
})

describe('siblingPath', () => {
  it('places the suffixed file next to the source', () => {
    expect(siblingPath('inputs/paper.docx', '_reviewed.docx')).toBe('inputs/paper_reviewed.docx')
    expect(siblingPath('a/b/paper.v1.docx', '_x.md')).toBe('a/b/paper.v1_x.md')
  })

  it('handles bare filenames without a directory prefix', () => {
    expect(siblingPath('paper.docx', '_peer_review.md')).toBe('paper_peer_review.md')
  })
})

describe('addUsage', () => {
  it('sums both input/output and inputTokens/outputTokens shapes', () => {
    const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    addUsage(total, { input: 10, output: 5, cacheRead: 3, cacheCreation: 2 })
    addUsage(total, { inputTokens: 7, outputTokens: 4 })
    addUsage(total, undefined)
    expect(total).toEqual({ input: 17, output: 9, cacheRead: 3, cacheCreation: 2 })
  })
})

describe('imageContent', () => {
  it('keeps ordinary multi-MB image payloads', () => {
    const images = [
      { base64: 'a'.repeat(3_000_000), contentType: 'image/png' },
      { base64: 'b'.repeat(2_500_000), contentType: 'image/jpeg' },
      { base64: 'c'.repeat(100), contentType: 'image/png' },
    ]
    const { content, omittedImages, imageBytes } = imageContent(images)
    expect(content).toHaveLength(3)
    expect(omittedImages).toBe(0)
    expect(imageBytes).toBe(5_500_100)
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: images[0].base64 } })
  })

  it('omits overflow above the high safety cap and records ids', () => {
    const images = [
      { id: 'first', base64: 'a'.repeat(20_000_000), contentType: 'image/png' },
      { id: 'second', base64: 'b'.repeat(11_000_000), contentType: 'image/jpeg' },
      { id: 'third', base64: 'c'.repeat(100), contentType: 'image/png' },
    ]
    const { content, omittedImages, omittedImageIds, imageBytes } = imageContent(images)
    expect(content).toHaveLength(2)
    expect(omittedImages).toBe(1)
    expect(omittedImageIds).toEqual(['second'])
    expect(imageBytes).toBe(20_000_100)
  })

  it('handles missing image lists', () => {
    expect(imageContent(undefined)).toEqual({ content: [], imageBytes: 0, omittedImages: 0, omittedImageIds: [] })
  })
})

describe('failedAnnotationComments', () => {
  it('maps failed result indices back to their comments with an error', () => {
    const comments = [{ number: 1 }, { number: 2 }, { number: 3 }]
    const failed = failedAnnotationComments({
      results: [
        { index: 0, success: true },
        { index: 1, success: false, error: 'no anchor' },
        { success: false }, // no index -> ignored
        { index: 2, success: false },
      ],
    }, comments)
    expect(failed).toEqual([
      { number: 2, error: 'no anchor' },
      { number: 3, error: 'DOCX anchor failed' },
    ])
  })

  it('returns empty for missing or malformed annotation results', () => {
    expect(failedAnnotationComments(null, [])).toEqual([])
    expect(failedAnnotationComments({ results: 'nope' }, [])).toEqual([])
  })
})

describe('parseCrossrefItem', () => {
  it('extracts title, year, authors, journal and doi', () => {
    expect(parseCrossrefItem({
      title: ['A Study'],
      published: { 'date-parts': [[2020, 1]] },
      author: [{ given: 'Ada', family: 'Lovelace' }, { family: 'Turing' }],
      'container-title': ['Journal of Examples'],
      DOI: '10.1/x',
    })).toEqual({
      source: 'crossref',
      title: 'A Study',
      year: 2020,
      authors: 'Ada Lovelace, Turing',
      journal: 'Journal of Examples',
      doi: '10.1/x',
    })
  })

  it('falls back to published-print and tolerates empty items', () => {
    expect(parseCrossrefItem({ 'published-print': { 'date-parts': [[2018]] } }).year).toBe(2018)
    expect(parseCrossrefItem({})).toEqual({ source: 'crossref', title: '', year: null, authors: '', journal: '', doi: '' })
  })
})

// ---------------------------------------------------------------------------
// Job input validation and chat tool
// ---------------------------------------------------------------------------

describe('reviewDocx job input validation', () => {
  it('rejects paths that are not .docx', async () => {
    await expect(jobs.reviewDocx.run({}, { path: 'paper.pdf' })).rejects.toThrow('A workspace-relative .docx path is required')
    await expect(jobs.reviewDocx.run({}, { path: 42 })).rejects.toThrow('A workspace-relative .docx path is required')
    await expect(jobs.reviewDocx.run({}, {})).rejects.toThrow('A workspace-relative .docx path is required')
  })

  it('accepts case-insensitive .docx extension', async () => {
    const { ctx } = makeCtx()
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/PAPER.DOCX' })
    expect(result.status).toBe('complete')
  })

  it('rejects non-string modelId and reviewNotes', async () => {
    await expect(jobs.reviewDocx.run({}, { path: 'a.docx', modelId: 42 })).rejects.toThrow('modelId must be a string')
    await expect(jobs.reviewDocx.run({}, { path: 'a.docx', reviewNotes: ['x'] })).rejects.toThrow('reviewNotes must be a string')
  })
})

describe('startReview chat tool', () => {
  it('forwards path and trimmed optional inputs to package.jobs.start', async () => {
    const { ctx, log } = makeCtx()
    await tools.startReview.execute(ctx, { path: 'inputs/paper.docx', modelId: 'anthropic:sonnet', reviewNotes: '  check stats  ' })
    expect(log.toolCalls[0]).toEqual({
      name: 'package.jobs.start',
      args: { jobId: 'reviewDocx', inputs: { path: 'inputs/paper.docx', modelId: 'anthropic:sonnet', reviewNotes: 'check stats' } },
    })
  })

  it('omits empty optional inputs', async () => {
    const { ctx, log } = makeCtx()
    await tools.startReview.execute(ctx, { path: 'inputs/paper.docx', modelId: '', reviewNotes: '   ' })
    expect(log.toolCalls[0].args.inputs).toEqual({ path: 'inputs/paper.docx' })
  })
})

// ---------------------------------------------------------------------------
// Full pipeline behavior through jobs.reviewDocx.run with faked boundaries
// ---------------------------------------------------------------------------

describe('reviewDocx pipeline', () => {
  it('reconciles (merges duplicates, numbers, anchors), reports, and annotates comments', async () => {
    const { ctx, log } = makeCtx()
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })

    expect(result.status).toBe('complete')
    // raw: tech{TTEST,PVALUE} + edit{HYPOTHESIS,TTEST} + ref{REF}. The reconciler
    // MERGES the two TTEST comments into one, leaving 4 final comments in document order.
    expect(result.comments).toHaveLength(4)
    expect(result.comments.map(comment => comment.id)).toEqual(['comment-1', 'comment-2', 'comment-3', 'comment-4'])
    expect(result.comments.map(comment => comment.number)).toEqual([1, 2, 3, 4])
    // Document order: HYPOTHESIS (intro), TTEST (methods, merged), PVALUE (results), REF (refs).
    expect(result.comments.map(comment => comment.text_snippet)).toEqual([
      SNIPPET_HYPOTHESIS, SNIPPET_TTEST, SNIPPET_PVALUE, SNIPPET_REF,
    ])
    expect(result.comments.map(comment => comment.reviewer)).toEqual([
      'Editorial Reviewer', 'Technical Reviewer, Editorial Reviewer', 'Technical Reviewer', 'Reference Checker',
    ])
    // the merged t-test comment preserves both perspectives
    const merged = result.comments[1]
    expect(merged.sourceReviewers).toEqual(['Technical Reviewer', 'Editorial Reviewer'])
    expect(merged.content).toContain('No power calculation')
    expect(merged.content).toContain('Duplicate angle')
    expect(merged.occurrenceIndex).toBe(0)
    // unknown severity 'critical' (on the PVALUE comment) normalized to suggestion
    expect(result.comments.map(comment => comment.severity)).toEqual(['minor', 'major', 'suggestion', 'minor'])
    expect(JSON.parse(result.commentsJson)).toEqual(result.comments)

    // anchored HTML marks each comment; the merged t-test comment is comment-2 (major)
    expect(result.anchoredHtml).toContain(`<mark data-comment-id="comment-2" data-severity="major">${SNIPPET_TTEST}</mark>`)
    expect(result.anchoredHtml).toContain('data-comment-id="comment-1"')

    // markdown report written next to the source
    expect(result.reportPath).toMatch(/^inputs\/paper_peer_review_[0-9TZ-]+_01234567\.md$/)
    expect(log.writes[0].path).toBe(result.reportPath)
    expect(log.writes[0].content).toContain('# Peer Review Report')
    expect(log.writes[0].content).toContain('## Peer Review Summary')
    expect(log.writes[0].content).toContain('### 2. [major] - Technical Reviewer, Editorial Reviewer')

    // DOCX annotation operations now carry occurrenceIndex
    expect(result.reviewedDocxPath).toMatch(/^inputs\/paper_reviewed_[0-9TZ-]+_01234567\.docx$/)
    const ops = log.annotateCalls[0].operations
    expect(ops).toHaveLength(4)
    expect(ops[0]).toEqual({
      type: 'add_comment',
      anchorText: SNIPPET_HYPOTHESIS,
      occurrenceIndex: 0,
      commentText: '[minor] State the hypothesis direction.',
      author: 'Mim Review',
    })

    // the reconciler and compact summary writer saw the citation summary
    expect(reconcileCall(log).messages[0].content).toContain('Reference/citation check summary:\nAll references verified against Crossref.')
    expect(summaryCall(log).messages[0].content).toContain('Reference/citation check summary:\nAll references verified against Crossref.')

    // result persisted under the run id and usage summed across all calls
    expect(log.puts).toEqual([{ name: 'reviews', key: '0123456789abcdef', value: result }])
    // gatekeeper 10/5 + tech 100/50 + edit 100/50 + ref 30/10 + reconcile 40/40 + summary 15/8
    expect(result.usage).toEqual({ input: 295, output: 163, cacheRead: 0, cacheCreation: 0 })
    expect(result.domainHint).toBe('health economics')
    expect(log.progress.at(-1)).toEqual(['done', 'Review complete: 4 comments'])
    // resolved model id used for every AI call (callAnthropic uses .model, callModel uses .modelId)
    expect(log.ai.every(call => (call.model ?? call.modelId) === 'claude-sonnet-4-6')).toBe(true)
  })

  it('prompts reviewers and reconciler to anchor tables and figures correctly', async () => {
    const { ctx, log } = makeCtx()
    await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })

    const technical = reviewerCall(log, /biostatistician/i)
    const editorial = reviewerCall(log, /editorial peer reviewer/i)
    for (const call of [technical, editorial]) {
      expect(call.system).toContain("Tables appear as pipe tables")
      expect(call.system).toContain("set text_snippet to a single cell's exact text")
      expect(call.system).toContain('Figures are provided as images')
      expect(call.system).toContain('anchor on its caption text')
    }
    expect(reconcileCall(log).system).toContain('For table data, anchor on a single cell')
  })

  it('logs real reviewer completion and reconcile progress', async () => {
    const { ctx, log } = makeCtx()
    await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })

    expect(log.progress).toContainEqual(['log', 'Technical reviewer · 2 issues'])
    expect(log.progress).toContainEqual(['log', 'Editorial reviewer · 2 issues'])
    expect(log.progress).toContainEqual(['log', 'Reference checker · 1 issue'])
    expect(log.progress).toContainEqual(['progress', 0.88, 'Reconciling 5/5'])
    expect(log.progress).toContainEqual(['progress', 0.89, 'Writing review summary'])
    expect(log.progress).toContainEqual(['progress', 0.9, 'Creating reviewed DOCX copy'])
  })

  it('fails early with the gatekeeper reason for non-reviewable documents', async () => {
    const { ctx, log } = makeCtx({
      gatekeeperText: JSON.stringify({ eligible: false, domain_hint: null, reason: 'This is a CV, not a paper.' }),
    })
    const result = await jobs.reviewDocx.run(ctx, { path: 'cv.docx' })
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('This is a CV, not a paper.')
    expect(log.ai).toHaveLength(1) // no reviewer or report calls
    expect(log.puts[0].value).toBe(result)
  })

  it('fails open when the gatekeeper returns unparseable output', async () => {
    const { ctx } = makeCtx({ gatekeeperText: 'I refuse to answer in JSON.' })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('complete')
    expect(result.techNotes.stages.gatekeeper.eligible).toBe(true)
    expect(result.techNotes.stages.gatekeeper.reason).toBe('Could not parse gatekeeper response')
  })

  it('throws before any model call when the DOCX worker is unavailable', async () => {
    const { ctx, log } = makeCtx({ workerStatus: { available: false, error: 'worker binary missing' } })
    await expect(jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })).rejects.toThrow('worker binary missing')
    expect(log.ai).toHaveLength(0)
  })

  it('throws when extraction lacks html or markdown', async () => {
    const { ctx } = makeCtx({ extraction: { markdown: 'only markdown' } })
    await expect(jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })).rejects.toThrow('DOCX extraction missing html')
    const { ctx: ctx2 } = makeCtx({ extraction: { html: '<p>only html</p>' } })
    await expect(jobs.reviewDocx.run(ctx2, { path: 'inputs/paper.docx' })).rejects.toThrow('DOCX extraction missing markdown')
  })

  it('fails when no reviewer produces any comments', async () => {
    const { ctx } = makeCtx({
      technical: async () => {},
      editorial: async () => {},
      reference: async ({ submit }) => { await submit.execute({ summary: 'Nothing to report.' }) },
    })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('Review agents failed to produce comments')
  })

  it('submit_review rejects bad anchors with retry instructions and deduplicates across calls', async () => {
    let firstResult
    let secondResult
    const { ctx } = makeCtx({
      technical: async ({ submit }) => {
        firstResult = await submit.execute({
          comments: [
            { text_snippet: SNIPPET_TTEST, content: 'Valid one', severity: 'major' },
            { text_snippet: 'this text exists nowhere in the paper', content: 'Invalid anchor', severity: 'major' },
            { text_snippet: 'abc', content: 'Too short', severity: 'minor' },
            { content: 'Missing snippet', severity: 'minor' },
            'not-an-object',
          ],
        })
        secondResult = await submit.execute({
          comments: [
            { text_snippet: SNIPPET_TTEST, content: 'Different content, same snippet', severity: 'minor' },
            { text_snippet: SNIPPET_PVALUE, content: 'Valid one', severity: 'minor' },
            { text_snippet: SNIPPET_PVALUE, content: 'Fresh content', severity: 'minor' },
          ],
        })
      },
      editorial: async () => {},
      reference: async ({ submit }) => { await submit.execute({ summary: 'ok' }) },
    })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })

    expect(firstResult.success).toBe(false)
    expect(firstResult.accepted).toBe(1)
    expect(firstResult.totalStored).toBe(1)
    expect(firstResult.failed).toHaveLength(4)
    expect(firstResult.failed.map(entry => entry.reason)).toEqual([
      'Snippet not found in document',
      'Snippet too short (< 5 chars)',
      'Missing text_snippet',
      'Comment must be an object',
    ])
    expect(firstResult.instruction).toContain('Call submit_review again')

    // second call: all anchors valid -> success, but duplicates (same snippet
    // or same content as stored comments) are not stored twice
    expect(secondResult.success).toBe(true)
    expect(result.comments.map(comment => comment.content)).toEqual(['Valid one', 'Fresh content'])
  })

  it('skips the reference agent when the paper has no bibliography section', async () => {
    const markdown = `# Note\n\n${SNIPPET_HYPOTHESIS}\n\n${SNIPPET_TTEST}`
    const referenceSpy = vi.fn()
    const { ctx, log } = makeCtx({
      extraction: { html: PAPER_HTML, markdown, images: [] },
      reference: referenceSpy,
      editorial: async () => {},
    })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('complete')
    expect(referenceSpy).not.toHaveBeenCalled()
    expect(reconcileCall(log).messages[0].content).toContain('No bibliography section found.')
  })

  it('truncates only above the selected model window, names the model, and points at Gemini', async () => {
    // 200k-window model -> effectivePaperCharBudget = 264250; exceed it.
    const longMarkdown = PAPER_MARKDOWN + '\n\n' + 'filler '.repeat(40_000) // ~280k chars
    const { ctx, log } = makeCtx({ extraction: { html: PAPER_HTML, markdown: longMarkdown, images: [] } })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('complete')
    expect(result.techNotes.stages.paperTruncated).toMatchObject({
      original: longMarkdown.length,
      limit: 264_250,
      model: 'anthropic:sonnet',
      contextWindow: 200_000,
    })
    const technical = reviewerCall(log, /biostatistician/i)
    expect(reviewerPaperText(technical)).toContain('truncated for review')
    expect(reviewerPaperText(technical)).toMatch(/Gemini/)
  })

  it('accounts for image tokens before truncating reviewer text', async () => {
    const images = [
      { base64: 'a'.repeat(100), contentType: 'image/png' },
      { base64: 'b'.repeat(100), contentType: 'image/png' },
    ]
    const limitWithImages = 264_250 - charsFromTokens(images.length * PER_IMAGE_TOKENS)
    const longMarkdown = PAPER_MARKDOWN + '\n\n' + 'filler '.repeat(Math.ceil((limitWithImages - PAPER_MARKDOWN.length + 1000) / 7))
    const { ctx } = makeCtx({ extraction: { html: PAPER_HTML, markdown: longMarkdown, images } })

    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('complete')
    expect(result.techNotes.stages.paperTruncated).toMatchObject({
      original: longMarkdown.length,
      limit: limitWithImages,
      model: 'anthropic:sonnet',
    })
  })

  it('does NOT truncate a large paper that still fits the model window', async () => {
    // ~196k chars: over the old 150k cap but under the 264250 budget -> no truncation.
    const bigButFits = PAPER_MARKDOWN + '\n\n' + 'filler '.repeat(28_000)
    const { ctx } = makeCtx({ extraction: { html: PAPER_HTML, markdown: bigButFits, images: [] } })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('complete')
    expect(result.techNotes.stages.paperTruncated).toBeUndefined()
  })

  it('passes review notes (capped at 6000 chars) to reviewer and report prompts', async () => {
    const notes = '  Focus on the statistical model. ' + 'x'.repeat(6000) + 'OVERFLOW'
    const { ctx, log } = makeCtx()
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx', reviewNotes: notes })
    expect(result.techNotes.reviewNotesProvided).toBe(true)
    const technicalText = reviewerPaperText(reviewerCall(log, /biostatistician/i))
    expect(technicalText).toContain('User notes to review agents:\nFocus on the statistical model.')
    expect(technicalText).not.toContain('OVERFLOW')
    expect(reviewerPaperText(reviewerCall(log, /editorial peer reviewer/i))).toContain('User notes to review agents:')
    expect(summaryCall(log).messages[0].content).toContain('User notes to review agents:')
  })

  it('sends all images under the high safety cap to reviewers', async () => {
    const images = [
      { base64: 'a'.repeat(3_000_000), contentType: 'image/png' },
      { base64: 'b'.repeat(2_500_000), contentType: 'image/png' },
    ]
    const { ctx, log } = makeCtx({ images })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    const technical = reviewerCall(log, /biostatistician/i)
    expect(technical.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: images[0].base64 },
    })
    expect(technical.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: images[1].base64 },
    })
    expect(reviewerPaperText(technical)).not.toContain('figure(s) were omitted')
    expect(result.techNotes.stages.technicalReviewer.notes).not.toContainEqual(expect.objectContaining({ omittedImages: expect.any(Number) }))
  })

  it('flags omitted figures only when the high safety cap is exceeded', async () => {
    const images = [
      { id: 'figure-1', base64: 'a'.repeat(20_000_000), contentType: 'image/png' },
      { id: 'figure-2', base64: 'b'.repeat(11_000_000), contentType: 'image/png' },
      { id: 'figure-3', base64: 'c'.repeat(100), contentType: 'image/png' },
    ]
    const { ctx, log } = makeCtx({ images })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    const technical = reviewerCall(log, /biostatistician/i)
    expect(technical.messages[0].content.filter(part => part.type === 'image')).toHaveLength(2)
    expect(reviewerPaperText(technical)).toContain('1 figure(s) were omitted')
    expect(result.techNotes.stages.technicalReviewer.notes).toContainEqual({
      omittedImages: 1,
      imageBytes: 20_000_100,
      omittedImageIds: ['figure-2'],
    })
  })

  it('exposes working guidance list/load tools to reviewers', async () => {
    let listResult
    let loadResult
    let badLoad
    let badAction
    const { ctx, log } = makeCtx({
      technical: async ({ submit, guidance }) => {
        listResult = await guidance.execute({ action: 'list', category: 'statistics' })
        loadResult = await guidance.execute({ action: 'load', category: 'statistics', chapterId: listResult.chapters[0].id })
        badLoad = await guidance.execute({ action: 'load', category: 'statistics', chapterId: 'does-not-exist' })
        badAction = await guidance.execute({ action: 'load', category: 'statistics' })
        await defaultTechnical({ submit })
      },
    })
    await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(listResult.chapters.length).toBeGreaterThan(0)
    expect(listResult.chapters[0]).toHaveProperty('id')
    expect(listResult.chapters[0]).toHaveProperty('filename')
    expect(typeof loadResult.content).toBe('string')
    expect(loadResult.content.length).toBeGreaterThan(0)
    expect(badLoad.error).toContain('not found')
    expect(badAction.error).toBe('Invalid action or missing chapterId')
    expect(log.progress).toContainEqual(['log', `Technical reviewer · consulting ${listResult.chapters[0].id}`])
  })

  it('repairs failed DOCX anchors via the repair agent and re-annotates', async () => {
    let repairReject
    let repairAccept
    const { ctx, log } = makeCtx({
      editorial: async () => {},
      reference: async ({ submit }) => { await submit.execute({ summary: 'ok' }) },
      annotate: ({ call }) => {
        if (call === 1) {
          return { success: false, results: [{ index: 0, success: true }, { index: 1, success: false, error: 'anchor not found' }] }
        }
        return { success: true, results: [{ success: true }, { success: true }] }
      },
      repair: async ({ submit }) => {
        repairReject = await submit.execute({
          repairs: [
            { number: 2, anchorText: 'zz' },
            { number: 2, anchorText: 'this anchor is not in the document' },
          ],
        })
        repairAccept = await submit.execute({ repairs: [{ number: 2, anchorText: 'large effect size' }] })
      },
    })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })

    expect(repairReject.success).toBe(false)
    expect(repairReject.failed).toHaveLength(2)
    expect(repairReject.failed[0].reason).toBe('Anchor not found as exact document substring')
    expect(repairAccept).toEqual({ success: true, accepted: 1 })

    expect(log.annotateCalls).toHaveLength(2)
    expect(log.annotateCalls[1].operations[1].anchorText).toBe('large effect size')
    expect(result.docxAnnotation.success).toBe(true)
    expect(result.docxAnnotation.repairedAnchors).toEqual([{ number: 2, anchorText: 'large effect size' }])
  })

  it('degrades with a warning when DOCX anchors cannot be repaired', async () => {
    const { ctx } = makeCtx({
      annotate: () => ({ success: false, results: [{ index: 0, success: false, error: 'no match' }] }),
      repair: async () => {}, // repair agent never submits anything usable
    })
    const result = await jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
    expect(result.status).toBe('complete')
    expect(result.docxAnnotation.warning).toContain('Some comments could not be written into the DOCX')
    expect(result.reviewedDocxPath).toMatch(/_reviewed_/)
  })

  it('recovers partial comments from a reviewer whose call fails after submitting', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = makeCtx({
        technical: async ({ submit }) => {
          await submit.execute({
            comments: [{ text_snippet: SNIPPET_TTEST, content: 'Stored before the crash.', severity: 'major' }],
          })
          throw new Error('stream disconnected')
        },
        reference: async ({ submit }) => { await submit.execute({ summary: 'ok' }) },
      })
      const run = jobs.reviewDocx.run(ctx, { path: 'inputs/paper.docx' })
      run.catch(() => {}) // avoid unhandled rejection noise if it fails
      await vi.advanceTimersByTimeAsync(20_000) // cover the 5s retry backoff
      const result = await run
      expect(result.status).toBe('complete')
      expect(result.techNotes.stages.technicalReviewer.timedOut).toBe(true)
      expect(result.techNotes.stages.editorialReviewer.timedOut).toBe(false)
      const technicalComments = result.comments.filter(comment => comment.sourceReviewers?.includes('Technical Reviewer'))
      expect(technicalComments).toHaveLength(1)
      expect(technicalComments[0].content).toContain('Stored before the crash.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects unknown and tool-incapable models, but accepts any tool-capable provider', async () => {
    const { ctx: unknownCtx } = makeCtx()
    await expect(jobs.reviewDocx.run(unknownCtx, { path: 'a.docx', modelId: 'nope' }))
      .rejects.toThrow('Unknown DOCX review model: nope')

    // Multi-provider: a non-Anthropic (OpenAI) tool-capable model is now accepted.
    const { ctx: openaiCtx } = makeCtx()
    const openaiResult = await jobs.reviewDocx.run(openaiCtx, { path: 'a.docx', modelId: 'openai:gpt' })
    expect(openaiResult.status).toBe('complete')
    expect(openaiResult.techNotes.reviewModel).toBe('gpt-9')

    const { ctx: noToolsCtx } = makeCtx({
      registry: {
        models: [{ id: 'anthropic:legacy', model: 'claude-legacy', provider: 'anthropic', contextWindow: 200_000, capabilities: { text: true, tools: false } }],
        defaults: { agent: [] },
      },
    })
    await expect(jobs.reviewDocx.run(noToolsCtx, { path: 'a.docx', modelId: 'anthropic:legacy' }))
      .rejects.toThrow('not compatible with tool-loop review agents')
  })

  it('throws when the registry offers no usable model at all', async () => {
    const { ctx } = makeCtx({ registry: { models: [], defaults: {} } })
    await expect(jobs.reviewDocx.run(ctx, { path: 'a.docx' }))
      .rejects.toThrow('Unknown DOCX review model: claude-sonnet-4-6')
  })
})
