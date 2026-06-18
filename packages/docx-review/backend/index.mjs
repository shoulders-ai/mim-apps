import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paperBudgetForModel, effectivePaperCharBudget } from './budget.mjs'
import { reconcileReview, nthOccurrenceInText, COMMENT_STYLE } from './reconcile.mjs'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const AGENT_TIMEOUT = 600_000
const AUTHOR = 'Mim Review'
const IMAGE_PAYLOAD_LIMIT = 30_000_000

export const jobs = {
  reviewDocx: {
    label: 'Review paper',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative .docx file path' },
        modelId: { type: 'string', description: 'Review model id (any configured provider with tool support)' },
        reviewNotes: { type: 'string', description: 'Optional user notes passed to review agents' },
      },
      required: ['path'],
    },
    async run(ctx, input) {
      return runReviewPipeline(ctx, requireDocxPath(input.path), {
        requestedModel: readOptionalModelId(input.modelId),
        reviewNotes: readOptionalReviewNotes(input.reviewNotes),
      })
    },
  },
}

export const tools = {
  startReview: {
    label: 'Start review',
    description: 'Start the peer-review workflow for a workspace-relative DOCX file.',
    audience: ['chat'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        modelId: { type: 'string' },
        reviewNotes: { type: 'string' },
      },
      required: ['path'],
    },
    async execute(ctx, input) {
      return ctx.tools.call('package.jobs.start', {
        jobId: 'reviewDocx',
        inputs: {
          path: input.path,
          ...(typeof input.modelId === 'string' && input.modelId ? { modelId: input.modelId } : {}),
          ...(typeof input.reviewNotes === 'string' && input.reviewNotes.trim() ? { reviewNotes: input.reviewNotes.trim() } : {}),
        },
      })
    },
  },
}

export const skills = {
  docxPeerReview: {
    label: 'DOCX peer review',
    instructionsPath: './skills/docx-peer-review/SKILL.md',
    tools: ['startReview'],
  },
}

async function runReviewPipeline(ctx, sourcePath, options = {}) {
  const { model: reviewModel, entry: reviewModelEntry, registry } = await resolveReviewModel(ctx, options.requestedModel)
  const reviewNotes = options.reviewNotes || ''
  const techNotes = { stages: {} }
  techNotes.reviewModel = reviewModel
  techNotes.reviewNotesProvided = !!reviewNotes
  let reviewerBudget = paperBudgetForModel(reviewModelEntry, registry, 'reviewer')
  const referenceBudget = paperBudgetForModel(reviewModelEntry, registry, 'referenceCheck')
  // A model whose context window is too small to seat a stage at all (paperTokens
  // below the floor) would otherwise yield a 0-char paper budget and a misleading
  // "agents failed to produce comments". Fail loudly and early instead.
  if (!reviewerBudget.fits) {
    const result = {
      status: 'failed',
      reason: `Model ${reviewModelEntry.id} has too small a context window (${reviewModelEntry.contextWindow}) for DOCX review. Choose a larger-context model.`,
      techNotes,
    }
    await ctx.data.collection('reviews').put(ctx.job.runId, result)
    return result
  }
  const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const workerStatus = await ctx.documents.docx.workerStatus()
  if (!workerStatus?.available) {
    throw new Error(workerStatus?.error || 'DOCX worker is not available')
  }

  await ctx.progress.step('Extracting document')
  await ctx.progress.progress(0.08, 'Reading DOCX')
  const extraction = await ctx.documents.docx.extract(sourcePath)
  const html = requireStringField(extraction, 'html')
  const markdown = requireStringField(extraction, 'markdown')
  const images = Array.isArray(extraction.images) ? extraction.images : []
  reviewerBudget = paperBudgetForModel(reviewModelEntry, registry, 'reviewer', images.length)
  if (!reviewerBudget.fits) {
    const result = {
      status: 'failed',
      reason: `Model ${reviewModelEntry.id} has too small a context window (${reviewModelEntry.contextWindow}) for DOCX review with ${images.length} figure(s). Choose a larger-context model.`,
      techNotes,
    }
    await ctx.data.collection('reviews').put(ctx.job.runId, result)
    return result
  }

  await ctx.progress.step('Checking document type')
  const gateResult = await runGatekeeper(ctx, markdown, reviewModel, paperBudgetForModel(reviewModelEntry, registry, 'gatekeeper'))
  addUsage(totalUsage, gateResult.usage)
  techNotes.stages.gatekeeper = gateResult
  if (!gateResult.eligible) {
    const result = {
      status: 'failed',
      reason: gateResult.reason,
      domainHint: gateResult.domain_hint,
      techNotes,
    }
    await ctx.data.collection('reviews').put(ctx.job.runId, result)
    return result
  }

  // Truncate-loudly only when the paper genuinely exceeds the selected model's
  // window (realistically only on 200k Claude/GPT; Gemini's budget is ~3M chars).
  const paperCharBudget = effectivePaperCharBudget(reviewModelEntry, registry, images.length)
  const truncated = markdown.length > paperCharBudget
  let reviewMarkdown = markdown
  let anchorMarkdown = markdown
  if (truncated) {
    anchorMarkdown = markdown.slice(0, paperCharBudget)
    reviewMarkdown = anchorMarkdown +
      `\n\n---\n\nNote: This paper was truncated for review (original: ${markdown.length} characters, ` +
      `limit for ${reviewModelEntry.id}: ${paperCharBudget}). The review covers only the content above. ` +
      `Please mention in your comments that later sections were not reviewed. ` +
      `To review the whole document, re-run with a larger-context model (e.g. Gemini, 1M context).`
    techNotes.stages.paperTruncated = {
      original: markdown.length,
      limit: paperCharBudget,
      model: reviewModelEntry.id,
      contextWindow: reviewModelEntry.contextWindow,
      suggestion: 'Select a 1M-context model (Gemini) to review the full document.',
    }
  }

  await ctx.progress.step('Running review agents')
  await ctx.progress.progress(0.25, 'Technical, editorial, and reference reviewers')
  const techShared = { allValid: [], techNotes: [] }
  const editShared = { allValid: [], techNotes: [] }
  const refShared = { allValid: [], techNotes: [] }
  const docProfile = gateResult.profile || defaultProfile()
  // The reference checker must see the bibliography (which lives at the END of the
  // document); a head-truncated reviewMarkdown would drop it. Give it the full text
  // when it fits the referenceCheck budget, otherwise the TAIL (preserving refs).
  const referenceText = markdown.length <= referenceBudget.paperCharBudget
    ? markdown
    : markdown.slice(-referenceBudget.paperCharBudget)
  const [technicalResult, editorialResult, referenceResult] = await Promise.all([
    runAgentWithProgress(ctx, 'Technical reviewer', () => runTechnicalReview(ctx, reviewMarkdown, anchorMarkdown, images, techShared, reviewModel, reviewNotes, reviewerBudget, docProfile), result => result?.comments?.length ?? techShared.allValid.length),
    runAgentWithProgress(ctx, 'Editorial reviewer', () => runEditorialReview(ctx, reviewMarkdown, anchorMarkdown, images, editShared, reviewModel, reviewNotes, reviewerBudget, docProfile), result => result?.comments?.length ?? editShared.allValid.length),
    runAgentWithProgress(ctx, 'Reference checker', () => runReferenceCheck(ctx, referenceText, referenceText, images, refShared, reviewModel, reviewNotes, referenceBudget, docProfile), result => result?.comments?.length ?? refShared.allValid.length),
  ])

  const technicalComments = technicalResult?.comments || techShared.allValid.map(comment => ({ ...comment, reviewer: 'Technical Reviewer' }))
  const editorialComments = editorialResult?.comments || editShared.allValid.map(comment => ({ ...comment, reviewer: 'Editorial Reviewer' }))
  const referenceComments = referenceResult?.comments || refShared.allValid.map(comment => ({ ...comment, reviewer: 'Reference Checker' }))
  addUsage(totalUsage, technicalResult?.usage)
  addUsage(totalUsage, editorialResult?.usage)
  addUsage(totalUsage, referenceResult?.usage)

  const rawComments = [...technicalComments, ...editorialComments, ...referenceComments]
  techNotes.stages.technicalReviewer = { commentCount: technicalComments.length, timedOut: !technicalResult, notes: technicalResult?.techNotes || techShared.techNotes }
  techNotes.stages.editorialReviewer = { commentCount: editorialComments.length, timedOut: !editorialResult, notes: editorialResult?.techNotes || editShared.techNotes }
  techNotes.stages.referenceChecker = { commentCount: referenceComments.length, summary: !!referenceResult?.summary, timedOut: !referenceResult, notes: referenceResult?.techNotes || refShared.techNotes }

  if (rawComments.length === 0) {
    const result = { status: 'failed', reason: 'Review agents failed to produce comments', techNotes }
    await ctx.data.collection('reviews').put(ctx.job.runId, result)
    return result
  }

  await ctx.progress.step('Reconciling review')
  await ctx.progress.progress(0.72, `Reconciling ${rawComments.length} comments`)
  const recon = await reconcileReview(ctx, {
    paperMarkdown: markdown,
    anchorText: anchorMarkdown,
    html,
    rawComments,
    citationSummary: referenceResult?.summary,
    reviewModel,
    reviewNotes,
    docProfile,
    truncated,
    budget: paperBudgetForModel(reviewModelEntry, registry, 'reconciler'),
  })
  if (recon.status === 'failed') {
    addUsage(totalUsage, recon.usage)
    techNotes.stages.reconciliation = recon.techNotes
    const result = { status: 'failed', reason: recon.reason, techNotes, usage: totalUsage }
    await ctx.data.collection('reviews').put(ctx.job.runId, result)
    return result
  }
  addUsage(totalUsage, recon.usage)
  techNotes.stages.reconciliation = recon.techNotes

  const numberedComments = recon.comments
  const report = recon.report
  const anchoredHtml = recon.anchoredHtml
  const stamp = `${timestampSlug()}_${ctx.job.runId.slice(0, 8)}`
  const reportPath = siblingPath(sourcePath, `_peer_review_${stamp}.md`)
  const reviewedDocxPath = siblingPath(sourcePath, `_reviewed_${stamp}.docx`)
  await ctx.tools.call('fs.write', { path: reportPath, content: reviewMarkdownReport(report, numberedComments, recon.dropped) })

  await ctx.progress.step('Writing Word comments')
  await ctx.progress.progress(0.9, 'Creating reviewed DOCX copy')
  const docxAnnotation = await annotateWithRepair(ctx, sourcePath, reviewedDocxPath, numberedComments, markdown, reviewModel)

  const result = {
    status: 'complete',
    sourcePath,
    report,
    reportPath,
    comments: numberedComments,
    commentsJson: JSON.stringify(numberedComments),
    dropped: recon.dropped,
    anchoredHtml,
    domainHint: gateResult.domain_hint,
    reviewedDocxPath: docxAnnotation.outputPath || reviewedDocxPath,
    docxAnnotation,
    techNotes,
    usage: totalUsage,
    completedAt: new Date().toISOString(),
  }
  await ctx.data.collection('reviews').put(ctx.job.runId, result)
  await ctx.progress.done(`Review complete: ${numberedComments.length} comments`)
  return result
}

async function runAgent(fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timeout = null
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Agent timeout')), AGENT_TIMEOUT)
          timeout.unref?.()
        }),
      ])
    } catch (err) {
      if (attempt === 2) return null
      await new Promise(resolve => setTimeout(resolve, 5_000))
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  return null
}

async function runAgentWithProgress(ctx, label, fn, countFromResult) {
  const result = await runAgent(fn)
  if (!result) {
    await emitLog(ctx, `${label} · timed out`)
    return null
  }
  const count = Math.max(0, Number(countFromResult?.(result)) || 0)
  await emitLog(ctx, `${label} · ${count} ${count === 1 ? 'issue' : 'issues'}`)
  return result
}

async function emitLog(ctx, message) {
  if (typeof ctx?.progress?.log !== 'function') return
  await ctx.progress.log(message)
}

function reviewerLogLabel(reviewer) {
  if (/technical/i.test(String(reviewer))) return 'Technical reviewer'
  if (/editorial/i.test(String(reviewer))) return 'Editorial reviewer'
  if (/reference/i.test(String(reviewer))) return 'Reference checker'
  return 'Reviewer'
}

async function runGatekeeper(ctx, plainText, reviewModel = 'claude-sonnet-4-6', budget = null) {
  const sampleChars = budget?.sampleChars ?? 8000
  const maxTokens = budget?.maxOutputTokens ?? 1000
  const system = `You are the intake classifier for a clinical and academic peer-review service whose users are Clinical Research Organisations reviewing clinical study reports, trial protocols, and clinical/scientific manuscripts. Your job is to (1) decide whether the document can be meaningfully peer-reviewed and (2) classify it precisely so the right reviewers and reporting standards are applied. Downstream agents depend on your classification — be accurate.

Return a single JSON object:
{
  "eligible": true,
  "doc_type": "csr | rct_manuscript | protocol | observational | systematic_review | meta_analysis | economic_evaluation | diagnostic_accuracy | preclinical | other_research | ineligible",
  "is_clinical": true,
  "study_design": "parallel_rct | crossover_rct | cluster_rct | single_arm | cohort | case_control | cross_sectional | sr_ma | not_applicable | unclear",
  "applicable_standards": ["ich-e3","consort","consort-extensions","spirit","strobe","prisma","cheers","stard"],
  "registration_id": "NCT/EudraCT/ISRCTN number if present, else null",
  "domain_hint": "short free-text domain, e.g. oncology phase III, health economics",
  "reason": "one sentence"
}

Use ONLY these standard ids (each maps to a guidance chapter): ich-e3, consort, consort-extensions, spirit, strobe, prisma, cheers, stard.

Classification rules:
- csr: an ICH E3-structured clinical study report → tag ich-e3, and consort if randomised.
- rct_manuscript: a journal-style randomised-trial report → consort (add consort-extensions for cluster/crossover/non-inferiority designs).
- protocol or statistical-analysis plan → spirit.
- observational (cohort/case-control/cross-sectional) → strobe.
- systematic_review → prisma; if it pools data quantitatively also set doc_type meta_analysis (still prisma).
- economic_evaluation / cost-effectiveness / HTA → cheers.
- diagnostic_accuracy → stard.
- Statistical-principles and estimand checks (ICH E9 / E9(R1)) are always applied by the technical reviewer from its clinical-methods guidance; you do not need a separate standard id for them.
- Set eligible:false only for genuinely non-reviewable inputs (CV, cover letter, fiction, blank, raw spreadsheet, slide deck, form, correspondence). When unsure, prefer eligible:true with doc_type:"other_research".
- Capture any trial-registration identifier verbatim in registration_id.`
  const { text, usage } = await ctx.ai.callModel({
    modelId: reviewModel,
    system,
    messages: [{ role: 'user', content: `Classify this document:\n\n${plainText.slice(0, sampleChars)}` }],
    maxTokens,
  })
  try {
    const parsed = parseJsonObject(text)
    if (!parsed) throw new Error('Gatekeeper response was not JSON')
    const profile = normalizeProfile(parsed)
    return {
      eligible: parsed.eligible === true,
      domain_hint: profile.domain_hint,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      profile,
      usage,
    }
  } catch {
    return { eligible: true, domain_hint: null, reason: 'Could not parse gatekeeper response', profile: defaultProfile(), usage }
  }
}

// Standard ids are hyphenated to match chapter filenames (ich-e3); the model
// tends to emit underscores (ich_e3). Normalize once here so docProfileBlock and
// guidance loading line up.
function normalizeStandardId(id) {
  return String(id || '').trim().toLowerCase().replace(/_/g, '-')
}

function defaultProfile() {
  return { doc_type: 'other_research', is_clinical: false, study_design: 'unclear', applicable_standards: [], registration_id: null, domain_hint: null }
}

function normalizeProfile(parsed) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    doc_type: str(parsed.doc_type) || 'other_research',
    is_clinical: parsed.is_clinical === true,
    study_design: str(parsed.study_design) || 'unclear',
    applicable_standards: Array.isArray(parsed.applicable_standards)
      ? [...new Set(parsed.applicable_standards.map(normalizeStandardId).filter(Boolean))]
      : [],
    registration_id: str(parsed.registration_id),
    domain_hint: str(parsed.domain_hint),
  }
}

function docProfileBlock(profile) {
  if (!profile) return ''
  const standards = (profile.applicable_standards || []).join(', ') || 'none identified'
  return [
    'DOCUMENT CLASSIFICATION (from intake):',
    `- Type: ${profile.doc_type || 'unknown'}`,
    `- Clinical: ${profile.is_clinical ? 'yes' : 'no'}`,
    `- Study design: ${profile.study_design || 'unclear'}`,
    `- Applicable standards: ${standards}`,
    profile.registration_id ? `- Trial registration: ${profile.registration_id}` : null,
    profile.domain_hint ? `- Domain: ${profile.domain_hint}` : null,
    '',
    '---',
    '',
  ].filter(Boolean).join('\n')
}

async function runTechnicalReview(ctx, text, anchorText, images, shared = { allValid: [], techNotes: [] }, reviewModel = 'claude-sonnet-4-6', reviewNotes = '', budget = null, docProfile = null) {
  return runCommentReviewer(ctx, {
    reviewer: 'Technical Reviewer',
    system: `You are a senior biostatistician and clinical-trial methodologist acting as a peer reviewer for a Clinical Research Organisation. Your reviews are read by sponsors and regulators, so every comment must be specific, evidence-anchored, and defensible. You are thorough, precise, and constructive — but you do not soften material methodological problems.

Use the document classification provided in the user message to decide which checks apply. For a clinical study report or trial manuscript, the checks below are mandatory where the relevant content exists.

Before commenting, consult guidance with the "getGuidance" tool. Load the reporting-standard chapter(s) named in the classification's applicable standards (e.g. ich-e3, consort, strobe) and the clinical-methods chapters relevant to the methods you see (estimands-e9r1, analysis-populations, multiplicity, missing-data, safety-ae, endpoint-definitions, sap-consistency, gcp-integrity) plus any statistics chapters. Ground your comments in these chapters rather than memory.

Mandatory review lenses (apply each where applicable):
- Estimands & analysis populations (ICH E9 R1): is the estimand defined (population, endpoint, intercurrent-event strategy, summary measure)? Is the analysis population (ITT/mITT/per-protocol/safety) explicitly defined, consistent across sections, and matched to the estimand? Flag ITT claimed but per-protocol denominators, or shifting denominators.
- Primary vs secondary endpoints: one pre-specified primary endpoint? Unambiguous definitions/timing/derivation? Flag endpoint switching vs the protocol/registration, or a secondary endpoint promoted to headline.
- Multiplicity: with multiple endpoints, arms, subgroups, or interim looks, is the family-wise error rate controlled and the method named? Flag uncorrected multiple testing and post-hoc subgroup claims presented as confirmatory.
- Sample size / power: calculation stated with all inputs (effect, variance, alpha, power, dropout); achieved N matches? Flag underpowered analyses and post-hoc power.
- Missing data & dropouts: dropout/withdrawal by arm with reasons (CONSORT flow)? Handling (complete-case/LOCF/MI/MMRM) named, justified, consistent with the estimand? Flag silent complete-case analysis.
- Statistical methods: appropriateness, assumptions, model specification, covariate adjustment matching the SAP, correct effect measures/CIs, correct p-value interpretation.
- SAP / protocol consistency: reported analyses match what methods/SAP pre-specify? Flag analyses in results but absent from methods, and vice versa.
- Safety / adverse events: AEs by arm with denominators, severity grading, SAEs, deaths? Safety population defined? Flag selective or aggregated-only AE reporting.
- Numeric integrity: do numbers reconcile across abstract, text, tables, figures? Do percentages match denominators? Flag impossible values, internal contradictions, totals that do not add up.

Each comment must:
1. Quote an EXACT verbatim substring of the document in text_snippet (it is re-validated; non-matching snippets are rejected). Anchor on the most specific phrase — a number, a method name, an endpoint definition.
2. State the problem at that anchor, and the fix in a few words only if it is not obvious.
3. Cite the standard/principle when relevant as a short parenthetical tag (e.g. "(ICH E9(R1))", "(CONSORT 13a)").
4. Set severity: major (threatens validity, interpretability, or regulatory acceptability), minor (should fix, does not change conclusions), suggestion (optional).

Tables appear as pipe tables (the header names each column). To comment on one, set text_snippet to a single cell's exact text — a row label or distinctive cell, never a whole row or a bare number — and name the value/column in the comment.
Figures are provided as images; to comment on a figure, anchor on its caption text in the document.

${COMMENT_STYLE}

Report every material issue you find — do not pad to a target count and do not drop real issues to stay brief. Conciseness is about each note's length, not about finding fewer issues. You MUST call the "submit_review" tool; comments written only as prose are lost.`,
    guidanceCategories: ['statistics', 'clinical-methods', 'reporting-standards'],
    text,
    anchorText,
    images,
    shared,
    reviewModel,
    reviewNotes,
    budget,
    docProfile,
  })
}

async function runEditorialReview(ctx, text, anchorText, images, shared = { allValid: [], techNotes: [] }, reviewModel = 'claude-sonnet-4-6', reviewNotes = '', budget = null, docProfile = null) {
  return runCommentReviewer(ctx, {
    reviewer: 'Editorial Reviewer',
    system: `You are a senior editorial peer reviewer for clinical and scientific manuscripts, expert in reporting-standard compliance, argumentation, and clarity. Your readers are CRO clients and journal editors. You are thorough, precise, and constructive.

Use the document classification provided in the user message. Load the reporting standard(s) named in the classification's applicable standards and the argumentation guidance via the "getGuidance" tool. Unlike a journal paper, a clinical study report may invoke SEVERAL standards at once (e.g. ICH E3 structure + CONSORT + SPIRIT for the protocol section) — apply every standard the classification lists; do not pick only one.

Review lenses:
- Reporting-standard completeness: walk the relevant checklist(s) (ICH E3 section structure for CSRs; CONSORT/SPIRIT/STROBE/PRISMA/CHEERS as classified) and flag missing or inadequately reported items, anchored to the text nearest each gap.
- Abstract/synopsis fidelity: does it accurately and completely summarise objectives, design, primary results, and conclusions? Flag spin — conclusions more favourable than the results support.
- Argumentation: claims supported by the data presented, no overgeneralisation beyond the studied population, conclusions proportionate to evidence, limitations honestly stated.
- Consistency of narrative vs results: introduction objectives match endpoints analysed and conclusions drawn.
- Structure & clarity: logical section flow, defined abbreviations/endpoints on first use, unambiguous phrasing where ambiguity changes meaning.
- Citation support: claims that require a reference but lack one.

Do not duplicate the statistical reviewer: comment on reporting completeness, coherence, and clarity, not on the correctness of the statistical methods themselves.

Each comment must (1) quote an EXACT verbatim substring in text_snippet, (2) state the problem and a fix only if non-obvious, (3) cite the standard item as a short parenthetical tag when relevant, (4) set severity major/minor/suggestion.

Tables appear as pipe tables (the header names each column). To comment on one, set text_snippet to a single cell's exact text — a row label or distinctive cell, never a whole row or a bare number — and name the value/column in the comment.
Figures are provided as images; to comment on a figure, anchor on its caption text in the document.

${COMMENT_STYLE}

Report every material issue; do not pad or trim to a count. Conciseness governs each note's length, not how many issues you raise. You MUST call the "submit_review" tool.`,
    guidanceCategories: ['reporting-standards', 'general'],
    text,
    anchorText,
    images,
    shared,
    reviewModel,
    reviewNotes,
    budget,
    docProfile,
  })
}

async function runCommentReviewer(ctx, { reviewer, system, guidanceCategories, text, anchorText, images, shared, reviewModel, reviewNotes = '', budget = null, docProfile = null }) {
  const { content: userContent, omittedImages, omittedImageIds, imageBytes } = imageContent(images)
  let paperNote = `${reviewNotesBlock(reviewNotes)}${docProfileBlock(docProfile)}Please review the following document:\n\n${text}`
  if (omittedImages > 0) {
    paperNote += `\n\nNote: ${omittedImages} figure(s) were omitted from this review because the total image size exceeded the limit. Please acknowledge this in your review so the author knows these figures were not assessed.`
    shared.techNotes.push({ omittedImages, imageBytes, omittedImageIds })
  }
  userContent.push({ type: 'text', text: paperNote })
  const allValid = shared.allValid
  const techNotes = shared.techNotes
  const guidanceTool = createGuidanceTool(ctx, reviewer, guidanceCategories, budget?.guidanceCharBudget)
  const submitReviewTool = {
    name: 'submit_review',
    description: 'Submit your review comments. Each text_snippet must be an exact verbatim quote from the paper. You MUST call this tool to complete your review.',
    input_schema: commentsInputSchema(),
    execute: async ({ comments } = {}) => {
      const { valid, invalid } = validateAnchors(Array.isArray(comments) ? comments : [], anchorText)
      const existingSnippets = new Set(allValid.map(comment => comment.text_snippet))
      const existingContents = new Set(allValid.map(comment => comment.content?.trim()))
      allValid.push(...valid.filter(comment =>
        !existingSnippets.has(comment.text_snippet) && !existingContents.has(comment.content?.trim()),
      ))
      if (invalid.length === 0) return { success: true, accepted: valid.length }
      techNotes.push({ invalidCount: invalid.length, snippets: invalid.map(comment => comment.text_snippet?.slice(0, 80)) })
      return {
        success: false,
        accepted: valid.length,
        totalStored: allValid.length,
        failed: invalid.map(comment => ({
          text_snippet: comment.text_snippet,
          reason: comment.reason,
          content: comment.content,
          severity: comment.severity,
        })),
        instruction: `${valid.length} comments accepted and stored. ${invalid.length} failed — snippets not found in paper. Fix each text_snippet to be an exact verbatim quote, or drop the comment. Call submit_review again with ONLY the corrected/remaining failed comments.`,
      }
    },
  }
  const { usage } = await ctx.ai.callModel({
    modelId: reviewModel,
    system,
    messages: [{ role: 'user', content: userContent }],
    tools: [guidanceTool, submitReviewTool],
    maxTokens: budget?.maxOutputTokens ?? 8000,
    maxSteps: budget?.maxSteps ?? 10,
  })
  return {
    comments: allValid.map(comment => ({ ...comment, reviewer })),
    techNotes,
    usage,
  }
}

async function runReferenceCheck(ctx, text, anchorText, _images, shared = { allValid: [], techNotes: [] }, reviewModel = 'claude-sonnet-4-6', reviewNotes = '', budget = null, docProfile = null) {
  const hasBibliography = /\b(references|bibliography|works cited|literature cited)\b/i.test(text)
  const registrationId = docProfile?.registration_id || null
  // Run the registration lens even without a bibliography when a trial id is present.
  if (!hasBibliography && !registrationId) {
    return { comments: [], summary: 'No bibliography section found.', techNotes: [], usage: { input: 0, output: 0 } }
  }
  const allValid = shared.allValid
  const techNotes = shared.techNotes
  let summary = null
  const searchTool = {
    name: 'search_references',
    description: 'Search Crossref and OpenAlex for bibliography entries. Returns raw database results for each reference — you compare and judge. Include the full raw text of each entry for best results.',
    input_schema: {
      type: 'object',
      properties: {
        references: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              raw: { type: 'string' },
              doi: { type: 'string' },
              title: { type: 'string' },
              authors: { type: 'string' },
              year: { type: 'string' },
            },
            required: ['key', 'raw'],
          },
          maxItems: 30,
        },
      },
      required: ['references'],
    },
    execute: async ({ references } = {}) => {
      await emitLog(ctx, 'Reference checker · verifying references')
      return searchReferences(Array.isArray(references) ? references : [])
    },
  }
  const registryTool = {
    name: 'search_registry',
    description: 'Look up a clinical trial in ClinicalTrials.gov by registration id (NCT number) or by title. Returns the registered primary/secondary outcomes, conditions, enrollment, and dates so you can compare them against what the document reports (outcome switching, population mismatch, retrospective registration).',
    input_schema: {
      type: 'object',
      properties: {
        registration_id: { type: 'string', description: 'NCT id if known' },
        title: { type: 'string', description: 'Trial title to search if no id' },
      },
    },
    execute: async ({ registration_id, title } = {}) => {
      const target = registration_id || title || 'trial registry'
      await emitLog(ctx, `Reference checker · checking ClinicalTrials.gov ${target}`)
      return searchRegistry({ registrationId: registration_id, title })
    },
  }
  const submitTool = {
    name: 'submit_citation_report',
    description: 'Submit your citation and reference check report. Summary is required (1-3 sentences). Comments are optional — only include them for genuine issues.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        comments: commentsInputSchema().properties.comments,
      },
      required: ['summary'],
    },
    execute: async ({ summary: nextSummary, comments: rawComments } = {}) => {
      summary = nextSummary
      if (!rawComments?.length) return { success: true, accepted: 0 }
      const { valid, invalid } = validateAnchors(rawComments, anchorText)
      const existingSnippets = new Set(allValid.map(comment => comment.text_snippet))
      allValid.push(...valid.filter(comment => !existingSnippets.has(comment.text_snippet)))
      if (invalid.length === 0) return { success: true, accepted: valid.length }
      techNotes.push({ invalidCount: invalid.length, snippets: invalid.map(comment => comment.text_snippet?.slice(0, 80)) })
      return {
        success: false,
        accepted: valid.length,
        totalStored: allValid.length,
        failed: invalid.map(comment => ({ text_snippet: comment.text_snippet, reason: comment.reason, content: comment.content, severity: comment.severity })),
        instruction: `${valid.length} comments accepted and stored. ${invalid.length} failed — snippets not found in paper. Fix each text_snippet to be an exact verbatim quote, or drop the comment. Call submit_citation_report again with ONLY the corrected/remaining failed comments.`,
      }
    },
  }
  const { usage } = await ctx.ai.callModel({
    modelId: reviewModel,
    system: `You are a meticulous reference, citation, and trial-registration auditor for clinical and scientific documents.

OBJECTIVE: (1) Verify every bibliography entry against external databases, (2) audit citation coverage, and (3) for clinical trials, verify trial-registration consistency.

TOOLS:
- search_references: looks up bibliography entries in Crossref and OpenAlex. Returns raw results; you judge whether each is the same work (title, authors, year, journal — not just keyword overlap). Books/reports/non-indexed sources may legitimately return nothing.
- search_registry (use when a registration id is present or the document is a trial): looks up the trial in ClinicalTrials.gov. Compare the registered primary outcome, population, and key dates against what the document reports.
- submit_citation_report: deliver findings. Summary required; comments optional and only for genuine issues.

What to flag:
- Bibliography: wrong journal, wrong year (>1 off), wrong/altered title, fabricated-looking or unverifiable journal articles, phantom in-text citations with no entry, uncited entries.
- Registration (clinical): missing registration identifier in a trial report; registered primary outcome != reported primary outcome (outcome switching — a major integrity finding); prospective-registration date after enrolment start; population/eligibility mismatch.
- Do NOT flag: year ±1 (preprint vs published), minor author-name spelling variants, legitimately non-indexed sources.

Comments must quote EXACT verbatim substrings in text_snippet. Outcome switching and missing registration are major. You MUST call submit_citation_report to finish.`,
    messages: [{ role: 'user', content: `${reviewNotesBlock(reviewNotes)}${docProfileBlock(docProfile)}Check the references, citations, and (if a clinical trial) the trial-registration consistency in this document:\n\n${text}` }],
    tools: [searchTool, registryTool, submitTool],
    maxTokens: budget?.maxOutputTokens ?? 8000,
    maxSteps: budget?.maxSteps ?? 10,
  })
  return {
    comments: allValid.map(comment => ({ ...comment, reviewer: 'Reference Checker' })),
    summary: summary || 'Reference check completed.',
    techNotes,
    usage,
  }
}

async function annotateWithRepair(ctx, sourcePath, outputPath, comments, documentText, reviewModel = 'claude-sonnet-4-6') {
  let current = [...comments]
  let annotation = await annotateComments(ctx, sourcePath, outputPath, current)
  if (annotation?.success) return annotation

  // First, deterministically clamp any "occurrence index out of range" failures
  // (markdown paragraph split over-counting vs DOCX <w:p>) before spending an LLM call.
  const clamped = clampOutOfRangeOccurrences(annotation, current)
  if (clamped.changed) {
    current = clamped.comments
    annotation = await annotateComments(ctx, sourcePath, outputPath, current)
    if (annotation?.success) return { ...annotation, occurrenceClamped: clamped.clamps }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const failed = failedAnnotationComments(annotation, current)
    if (!failed.length) break
    const repairs = await requestDocxAnchorRepairs(ctx, documentText, failed, reviewModel)
    if (!repairs.length) break
    current = current.map(comment => {
      const repair = repairs.find(candidate => Number(candidate.number) === comment.number)
      if (!repair?.anchorText) return comment
      // A rewritten anchor must get a freshly resolved occurrence (usually unique → 0).
      const occ = resolveOccurrenceFor(documentText, repair.anchorText)
      return { ...comment, text_snippet: repair.anchorText, occurrenceIndex: occ }
    })
    annotation = await annotateComments(ctx, sourcePath, outputPath, current)
    if (annotation?.success) return { ...annotation, repairedAnchors: repairs }
  }

  return { ...(annotation || {}), warning: 'Some comments could not be written into the DOCX. The HTML review and markdown report remain complete.' }
}

// Resolve a freshly-rewritten anchor's occurrence index (delegates to the
// reconcile module's worker-faithful resolver; unique anchors → 0).
function resolveOccurrenceFor(documentText, anchorText) {
  const occs = findAllOccurrences(documentText, anchorText)
  return occs.length > 1 ? 0 : 0
}

function findAllOccurrences(text, snippet) {
  const out = []
  if (!snippet) return out
  let from = 0
  while (true) {
    const idx = text.indexOf(snippet, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + 1
  }
  return out
}

function clampOutOfRangeOccurrences(annotation, comments) {
  const results = Array.isArray(annotation?.results) ? annotation.results : []
  const clamps = []
  const next = [...comments]
  for (const result of results) {
    if (!result || result.success !== false || typeof result.index !== 'number') continue
    const match = /out of range \(only (\d+)/.exec(String(result.error || ''))
    if (!match) continue
    const m = Number(match[1])
    const comment = next[result.index]
    if (!comment) continue
    const clampTo = Math.max(0, m - 1)
    if (comment.occurrenceIndex !== clampTo) {
      next[result.index] = { ...comment, occurrenceIndex: clampTo }
      clamps.push({ number: comment.number, from: comment.occurrenceIndex ?? 0, to: clampTo })
    }
  }
  return { changed: clamps.length > 0, comments: next, clamps }
}

async function annotateComments(ctx, sourcePath, outputPath, comments) {
  const operations = comments.map(comment => ({
    type: 'add_comment',
    anchorText: comment.text_snippet,
    occurrenceIndex: comment.occurrenceIndex ?? 0,
    commentText: `[${comment.severity}] ${comment.content}`,
    author: AUTHOR,
  }))
  return ctx.documents.docx.annotate(sourcePath, operations, { output_path: outputPath })
}

function failedAnnotationComments(annotation, comments) {
  const results = Array.isArray(annotation?.results) ? annotation.results : []
  return results
    .filter(result => result && result.success === false && typeof result.index === 'number')
    .map(result => ({ ...comments[result.index], error: result.error || 'DOCX anchor failed' }))
    .filter(Boolean)
}

async function requestDocxAnchorRepairs(ctx, documentText, failedComments, reviewModel = 'claude-sonnet-4-6') {
  const accepted = []
  const tool = {
    name: 'submit_docx_anchor_repairs',
    description: 'Submit replacement exact anchor snippets for DOCX comments that failed to write. Each anchorText must be a verbatim substring from the document.',
    input_schema: {
      type: 'object',
      properties: {
        repairs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: { type: 'number' },
              anchorText: { type: 'string' },
            },
            required: ['number', 'anchorText'],
          },
        },
      },
      required: ['repairs'],
    },
    execute: async ({ repairs } = {}) => {
      const valid = []
      const invalid = []
      for (const repair of Array.isArray(repairs) ? repairs : []) {
        const anchorText = typeof repair.anchorText === 'string' ? repair.anchorText.trim() : ''
        if (anchorText.length >= 5 && documentText.includes(anchorText)) valid.push({ number: repair.number, anchorText })
        else invalid.push({ number: repair.number, anchorText, reason: 'Anchor not found as exact document substring' })
      }
      accepted.push(...valid)
      if (!invalid.length) return { success: true, accepted: valid.length }
      return { success: false, accepted: valid.length, failed: invalid, instruction: 'Repair only the failed anchors and call submit_docx_anchor_repairs again.' }
    },
  }
  await ctx.ai.callModel({
    modelId: reviewModel,
    system: 'You repair Word DOCX comment anchors. Choose nearby short exact substrings from the manuscript for comments that failed to write. You must call submit_docx_anchor_repairs.',
    messages: [{
      role: 'user',
      content: `These comments failed DOCX anchoring:\n\n${JSON.stringify(failedComments, null, 2)}\n\nManuscript:\n\n${documentText}`,
    }],
    tools: [tool],
    maxTokens: 4000,
    maxSteps: 4,
  })
  return accepted
}

function createGuidanceTool(ctx, reviewer, categories, guidanceCharBudget = 300_000) {
  let loadedChars = 0
  const maxGuidanceChars = guidanceCharBudget > 0 ? guidanceCharBudget : 300_000
  return {
    name: 'getGuidance',
    description: `Load guidance documents for the review. Available categories: ${categories.join(', ')}. First call with action "list" to see available chapters, then "load" to read specific ones.`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'load'] },
        category: { type: 'string', enum: categories },
        chapterId: { type: 'string' },
      },
      required: ['action', 'category'],
    },
    execute: async ({ action, category, chapterId } = {}) => {
      if (action === 'list') return { chapters: listGuidanceCategory(category) }
      if (action === 'load' && chapterId) {
        const content = loadGuidanceChapter(category, chapterId)
        if (!content) return { error: `Chapter "${chapterId}" not found in ${category}` }
        if (loadedChars + content.length > maxGuidanceChars) {
          return { error: `Guidance budget exceeded (${loadedChars} of ${maxGuidanceChars} chars used). Work with guidance already loaded.` }
        }
        loadedChars += content.length
        await emitLog(ctx, `${reviewerLogLabel(reviewer)} · consulting ${chapterId}`)
        return { content }
      }
      return { error: 'Invalid action or missing chapterId' }
    },
  }
}

function listGuidanceCategory(category) {
  const dir = join(PACKAGE_DIR, 'guidance', category)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(file => file.endsWith('.md'))
    .map(file => {
      const content = readFileSync(join(dir, file), 'utf-8')
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
      // Only frontmatter-tagged files are real guidance. Skipping un-tagged
      // files keeps stray prompts/notes out of the menu and makes the
      // applicable_standards-id <-> chapter-id contract reliable.
      if (!frontmatterMatch) return null
      const fm = frontmatterMatch[1]
      const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || file.replace('.md', '')
      const id = fm.match(/^id:\s*(.+)$/m)?.[1]?.trim() || file.replace('.md', '')
      const applies_to = fm.match(/^applies_to:\s*"?(.+?)"?\s*$/m)?.[1]?.trim() || ''
      return { id, name, filename: file, applies_to }
    })
    .filter(Boolean)
}

function loadGuidanceChapter(category, chapterId) {
  const dir = join(PACKAGE_DIR, 'guidance', category)
  if (!existsSync(dir)) return null
  const wanted = normalizeStandardId(chapterId)
  const files = readdirSync(dir).filter(file => file.endsWith('.md'))
  // Prefer an exact id/stem match so "consort" never resolves to "consort-extensions";
  // only fall back to substring when nothing matches exactly.
  const exact = files.find(file => {
    const stem = normalizeStandardId(file.replace(/\.md$/, ''))
    if (stem === wanted) return true
    const fm = readFileSync(join(dir, file), 'utf-8').match(/^---\n([\s\S]*?)\n---/)
    const id = fm ? normalizeStandardId(fm[1].match(/^id:\s*(.+)$/m)?.[1] || '') : ''
    return id === wanted
  })
  const match = exact || files.find(file => normalizeStandardId(file).includes(wanted))
  return match ? readFileSync(join(dir, match), 'utf-8') : null
}

function validateAnchors(comments, plainText) {
  const valid = []
  const invalid = []
  for (const rawComment of comments) {
    const { comment, reason } = normalizeCommentShape(rawComment)
    if (reason) {
      invalid.push({ ...(rawComment || {}), reason })
      continue
    }
    const snippet = comment.text_snippet.trim()
    if (snippet.length < 5) {
      invalid.push({ ...comment, reason: 'Snippet too short (< 5 chars)' })
      continue
    }
    if (plainText.includes(snippet)) {
      valid.push({ ...comment, text_snippet: snippet })
      continue
    }
    const normalizedText = plainText.replace(/\s+/g, ' ')
    const normalizedSnippet = snippet.replace(/\s+/g, ' ')
    if (normalizedText.includes(normalizedSnippet)) valid.push({ ...comment, text_snippet: normalizedSnippet })
    else invalid.push({ ...comment, reason: 'Snippet not found in document' })
  }
  return { valid, invalid }
}

function anchorCommentsInHtml(html, comments) {
  if (!html || !comments?.length) return html
  const withSnippets = comments.filter(comment => comment.id && comment.text_snippet?.trim())
  const { text, starts, ends } = mapTextPositions(html)
  const anchors = []
  const used = new Set()
  for (const comment of withSnippets) {
    const snippet = comment.text_snippet.trim()
    const want = Number.isInteger(comment.occurrenceIndex) ? comment.occurrenceIndex : 0
    let idx = nthOccurrenceInText(text, snippet, want)
    let matchLen = snippet.length
    if (idx === -1) {
      // normalized-whitespace fallback, selecting the want-th normalized occurrence
      const normalizedText = text.replace(/\s+/g, ' ')
      const normalizedSnippet = snippet.replace(/\s+/g, ' ')
      const nIdx = nthOccurrenceInText(normalizedText, normalizedSnippet, want)
      if (nIdx === -1) continue
      idx = normToOrigIndex(text, nIdx)
      matchLen = normToOrigIndex(text, nIdx + normalizedSnippet.length) - idx
    }
    const end = idx + matchLen
    if ([...Array(end - idx).keys()].some(offset => used.has(idx + offset))) continue
    for (let i = idx; i < end; i++) used.add(i)
    anchors.push({ commentId: comment.id, severity: normalizeSeverity(comment.severity), textStart: idx, textEnd: end })
  }
  return anchors.sort((a, b) => b.textStart - a.textStart).reduce((result, anchor) => {
    const htmlStart = starts[anchor.textStart]
    const htmlEnd = ends[anchor.textEnd - 1]
    return result.slice(0, htmlStart) +
      `<mark data-comment-id="${anchor.commentId}" data-severity="${anchor.severity}">` +
      result.slice(htmlStart, htmlEnd) +
      '</mark>' +
      result.slice(htmlEnd)
  }, html)
}

function mapTextPositions(html) {
  let text = ''
  const starts = []
  const ends = []
  let inTag = false
  for (let i = 0; i < html.length;) {
    if (html[i] === '<') { inTag = true; i++; continue }
    if (html[i] === '>') { inTag = false; i++; continue }
    if (inTag) { i++; continue }
    if (html[i] === '&') {
      const semi = html.indexOf(';', i)
      if (semi !== -1 && semi - i < 10) {
        const decoded = decodeEntity(html.slice(i, semi + 1))
        if (decoded.length === 1) {
          starts.push(i); ends.push(semi + 1); text += decoded; i = semi + 1; continue
        }
      }
    }
    starts.push(i); ends.push(i + 1); text += html[i]; i++
  }
  return { text, starts, ends }
}

async function searchReferences(refs) {
  const capped = refs.slice(0, 30)
  const results = []
  for (let i = 0; i < capped.length; i += 5) {
    results.push(...await Promise.all(capped.slice(i, i + 5).map(searchSingleRef)))
  }
  if (refs.length > 30) results.push({ key: '_skipped', results: [], note: `${refs.length - 30} references skipped (cap: 30)` })
  return results
}

async function searchSingleRef(ref) {
  const results = []
  if (ref.doi) results.push(...await crossrefLookupDoi(ref.doi))
  if (ref.title && results.length === 0) {
    results.push(...await crossrefSearch(ref.title, ref.authors))
    if (results.length === 0) results.push(...await openalexSearch(ref.title))
  }
  if (ref.raw && results.length === 0) results.push(...await crossrefSearch(ref.raw))
  return { key: ref.key, results: results.slice(0, 3) }
}

// ClinicalTrials.gov v2 API lookup for trial-registration consistency checks.
async function searchRegistry({ registrationId, title } = {}) {
  const nct = String(registrationId || '').match(/NCT\d{8}(?!\d)/i)?.[0]?.toUpperCase()
  let study = null
  if (nct) {
    const data = await fetchJson(`https://clinicaltrials.gov/api/v2/studies/${nct}`)
    study = data && !Array.isArray(data) ? data : null
  }
  if (!study && title) {
    const data = await fetchJson(`https://clinicaltrials.gov/api/v2/studies?query.titles=${encodeURIComponent(String(title).slice(0, 200))}&pageSize=1`)
    study = data?.studies?.[0] || null
  }
  if (!study) return { found: false, note: nct ? `No ClinicalTrials.gov record for ${nct}` : 'No matching trial registry record found.' }
  return { found: true, ...summarizeRegistryStudy(study) }
}

function summarizeRegistryStudy(study) {
  const ps = study.protocolSection || {}
  const outcomes = ps.outcomesModule || {}
  const map = (list) => (Array.isArray(list) ? list : []).map(o => o.measure).filter(Boolean)
  return {
    nctId: ps.identificationModule?.nctId || null,
    officialTitle: ps.identificationModule?.officialTitle || ps.identificationModule?.briefTitle || null,
    overallStatus: ps.statusModule?.overallStatus || null,
    studyFirstPosted: ps.statusModule?.studyFirstPostDateStruct?.date || null,
    startDate: ps.statusModule?.startDateStruct?.date || null,
    conditions: ps.conditionsModule?.conditions || [],
    enrollment: ps.designModule?.enrollmentInfo?.count ?? null,
    primaryOutcomes: map(outcomes.primaryOutcomes),
    secondaryOutcomes: map(outcomes.secondaryOutcomes),
    eligibility: ps.eligibilityModule?.eligibilityCriteria?.slice(0, 1000) || null,
  }
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mim/0.3', ...headers } })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function crossrefLookupDoi(doi) {
  const cleaned = doi.replace(/^https?:\/\/doi\.org\//i, '')
  const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(cleaned)}`)
  return data?.message ? [parseCrossrefItem(data.message)] : []
}

async function crossrefSearch(query, author) {
  const q = encodeURIComponent(String(query).slice(0, 250))
  const url = author
    ? `https://api.crossref.org/works?query.bibliographic=${q}&query.author=${encodeURIComponent(String(author).split(/[,&]/)[0].trim())}&rows=3`
    : `https://api.crossref.org/works?query.bibliographic=${q}&rows=3`
  const data = await fetchJson(url)
  return (data?.message?.items || []).map(parseCrossrefItem)
}

async function openalexSearch(title) {
  const data = await fetchJson(`https://api.openalex.org/works?filter=title.search:${encodeURIComponent(String(title).slice(0, 200))}&per_page=3`)
  return (data?.results || []).map(result => ({
    source: 'openalex',
    title: result.display_name || '',
    year: result.publication_year || null,
    authors: (result.authorships || []).map(authorship => authorship.author?.display_name).filter(Boolean).join(', '),
    journal: result.primary_location?.source?.display_name || '',
    doi: result.doi?.replace(/^https?:\/\/doi\.org\//i, '') || '',
  }))
}

function parseCrossrefItem(item) {
  return {
    source: 'crossref',
    title: item.title?.[0] || '',
    year: item.published?.['date-parts']?.[0]?.[0] || item['published-print']?.['date-parts']?.[0]?.[0] || null,
    authors: (item.author || []).map(author => [author.given, author.family].filter(Boolean).join(' ')).join(', '),
    journal: item['container-title']?.[0] || '',
    doi: item.DOI || '',
  }
}

function commentsInputSchema() {
  return {
    type: 'object',
    properties: {
      comments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text_snippet: { type: 'string', description: 'Exact verbatim quote from the paper' },
            content: { type: 'string', description: 'One concise margin note (~30 words, max 45): the specific problem at this anchor, plus the fix in a few words only if non-obvious. No preamble, no restating the quote, no reviewer name/severity word/number; standards as short parenthetical tags like "(STROBE 1b)".' },
            severity: { type: 'string', enum: ['major', 'minor', 'suggestion'] },
          },
          required: ['text_snippet', 'content', 'severity'],
        },
      },
    },
    required: ['comments'],
  }
}

function imageContent(images) {
  const content = []
  let imageBytes = 0
  let omittedImages = 0
  const omittedImageIds = []
  for (const [index, image] of (images || []).entries()) {
    const base64 = typeof image?.base64 === 'string' ? image.base64 : ''
    if (!base64) continue
    const id = image?.id || `image-${index + 1}`
    if (imageBytes + base64.length > IMAGE_PAYLOAD_LIMIT) {
      omittedImages++
      omittedImageIds.push(id)
      continue
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: image.contentType, data: base64 } })
    imageBytes += base64.length
  }
  return { content, imageBytes, omittedImages, omittedImageIds }
}

function reviewMarkdownReport(report, comments, dropped = []) {
  let markdown = '# Peer Review Report\n\n'
  if (report) markdown += `${report}\n\n---\n\n`
  if (comments.length) {
    markdown += '## Comments\n\n'
    for (const comment of comments) {
      markdown += `### ${comment.number}. [${comment.severity}] - ${comment.reviewer}\n`
      markdown += `> "${comment.text_snippet}"\n\n${comment.content}\n\n`
    }
  }
  if (dropped.length) {
    markdown += '---\n\n## Comments not carried forward\n\n'
    for (const d of dropped) markdown += `- (${d.reviewer}) "${(d.snippet || '').slice(0, 80)}" — ${d.reason}\n`
  }
  return markdown
}

function deduplicateComments(comments) {
  const seen = new Set()
  return comments.filter(comment => {
    const key = comment.text_snippet?.trim()?.replace(/\s+/g, ' ')
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function addUsage(total, usage) {
  if (!usage) return
  total.input += usage.input || usage.inputTokens || 0
  total.output += usage.output || usage.outputTokens || 0
  total.cacheRead += usage.cacheRead || 0
  total.cacheCreation += usage.cacheCreation || 0
}

function requireDocxPath(value) {
  if (typeof value !== 'string' || !value.toLowerCase().endsWith('.docx')) throw new Error('A workspace-relative .docx path is required')
  return value
}

function readOptionalModelId(value) {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('modelId must be a string')
  return value
}

function readOptionalReviewNotes(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw new Error('reviewNotes must be a string')
  return value.trim().slice(0, 6000)
}

function reviewNotesBlock(reviewNotes) {
  if (!reviewNotes) return ''
  return `User notes to review agents:\n${reviewNotes}\n\nFollow these notes where relevant, while preserving the required exact-anchor comment format and your assigned reviewer role.\n\n---\n\n`
}

async function resolveReviewModel(ctx, requestedModel) {
  const registry = await ctx.tools.call('ai.registry')
  const models = Array.isArray(registry?.models) ? registry.models : []
  const defaultIds = Array.isArray(registry?.defaults?.agent)
    ? registry.defaults.agent
    : Array.isArray(registry?.defaults?.chat)
      ? registry.defaults.chat
      : []
  // Any provider whose models support a text tool-loop is eligible — the review
  // agents now run on the provider-agnostic ctx.ai.callModel (decision #2).
  const compatibleModels = models.filter(model =>
    model.capabilities?.tools !== false &&
    model.capabilities?.text !== false,
  )
  const defaultModel = compatibleModels.find(model => defaultIds.includes(model.id) || defaultIds.includes(model.model))
  const requestedId = requestedModel || defaultModel?.id || compatibleModels[0]?.id || 'claude-sonnet-4-6'
  const found = models.find(model => model.id === requestedId || model.model === requestedId)
  if (!found) throw new Error(`Unknown DOCX review model: ${requestedId}`)
  if (found.capabilities?.tools === false || found.capabilities?.text === false) {
    throw new Error(`DOCX review model is not compatible with tool-loop review agents: ${requestedId}`)
  }
  return { model: found.model || found.id, entry: found, registry }
}

function normalizeCommentShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { comment: null, reason: 'Comment must be an object' }
  }
  const textSnippet = typeof value.text_snippet === 'string' ? value.text_snippet.trim() : ''
  if (!textSnippet) return { comment: null, reason: 'Missing text_snippet' }
  const content = typeof value.content === 'string' ? value.content.trim() : ''
  if (!content) return { comment: null, reason: 'Missing content' }
  return {
    comment: {
      text_snippet: textSnippet,
      content,
      severity: normalizeSeverity(value.severity),
    },
    reason: null,
  }
}

function normalizeSeverity(value) {
  return value === 'major' || value === 'minor' || value === 'suggestion' ? value : 'suggestion'
}

function parseJsonObject(text) {
  const cleaned = String(text || '').replace(/```json\n?|\n?```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function requireStringField(value, key) {
  if (!value || typeof value !== 'object' || typeof value[key] !== 'string') throw new Error(`DOCX extraction missing ${key}`)
  return value[key]
}

function siblingPath(sourcePath, suffix) {
  const ext = extname(sourcePath) || '.docx'
  const dir = dirname(sourcePath)
  const base = basename(sourcePath, ext)
  const file = `${base}${suffix}`
  return dir === '.' ? file : join(dir, file).replace(/\\/g, '/')
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function normToOrigIndex(text, normIdx) {
  let ni = 0
  let oi = 0
  while (ni < normIdx && oi < text.length) {
    if (/\s/.test(text[oi])) {
      while (oi < text.length && /\s/.test(text[oi])) oi++
      ni++
    } else {
      oi++
      ni++
    }
  }
  return oi
}

// Named exports: pure internal functions for unit tests, plus the helpers
// reconcile.mjs imports (validateAnchors, normalizeSeverity, reviewNotesBlock,
// deduplicateComments, anchorCommentsInHtml, addUsage, runAgent).
export {
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
  reviewNotesBlock,
  docProfileBlock,
  normalizeProfile,
  normalizeStandardId,
  runGatekeeper,
  listGuidanceCategory,
  loadGuidanceChapter,
  runAgent,
  siblingPath,
  addUsage,
  imageContent,
  failedAnnotationComments,
  parseCrossrefItem,
  clampOutOfRangeOccurrences,
}

function decodeEntity(entity) {
  const map = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    '&mdash;': '\u2014', '&ndash;': '\u2013',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    '&hellip;': '\u2026', '&bull;': '\u2022',
    '&copy;': '\u00A9', '&reg;': '\u00AE', '&trade;': '\u2122',
    '&deg;': '\u00B0', '&plusmn;': '\u00B1', '&times;': '\u00D7', '&divide;': '\u00F7',
    '&frac12;': '\u00BD', '&frac14;': '\u00BC', '&frac34;': '\u00BE',
    '&pound;': '\u00A3', '&euro;': '\u20AC', '&yen;': '\u00A5', '&cent;': '\u00A2',
    '&sect;': '\u00A7', '&para;': '\u00B6', '&micro;': '\u00B5',
    '&laquo;': '\u00AB', '&raquo;': '\u00BB',
  }
  if (map[entity]) return map[entity]
  if (entity.startsWith('&#')) {
    const code = entity[2] === 'x' || entity[2] === 'X' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10)
    if (!Number.isNaN(code)) return String.fromCodePoint(code)
  }
  return entity
}
