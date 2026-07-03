// Activity summaries over the local cache. The summarizer never calls GitHub:
// sync first, then read collections, map-reduce through ctx.ai.generateObject,
// and write a markdown report into the workspace.

const BUCKET_THRESHOLD = 120
const MAX_PER_BUCKET = 200

export function gatherActivity({ items, events }, { from, to, user, users, repos }) {
  const inRange = (iso) => iso && iso >= from && iso <= to
  const people = users?.length ? users : user ? [user] : null
  const matchedItems = items.filter((item) => {
    if (!inRange(item.updatedAt)) return false
    if (people && !people.includes(item.author) && !(item.assignees || []).some((a) => people.includes(a))) return false
    if (repos?.length && !repos.includes(item.repo)) return false
    return true
  })
  const matchedEvents = events.filter((event) => {
    if (!inRange(event.createdAt)) return false
    if (people && !people.includes(event.actor)) return false
    if (repos?.length && !repos.includes(event.repo)) return false
    return true
  })
  return { items: matchedItems, events: matchedEvents }
}

export function bucketByRepo(activity) {
  const buckets = new Map()
  const ensure = (repo) => {
    if (!buckets.has(repo)) buckets.set(repo, { repo, items: [], events: [] })
    return buckets.get(repo)
  }
  for (const item of activity.items) ensure(item.repo).items.push(item)
  for (const event of activity.events) ensure(event.repo).events.push(event)
  return [...buckets.values()].sort((a, b) => b.items.length + b.events.length - (a.items.length + a.events.length))
}

function itemLine(item) {
  const status = item.mergedAt ? 'merged' : item.state.toLowerCase()
  const people = [item.author, ...(item.assignees || [])].filter(Boolean).join(', ')
  return `[${item.type} ${item.key} ${status}] ${item.title} (${people}; comments: ${item.commentCount}; updated ${item.updatedAt})`
}

function eventLine(event) {
  return `[${event.createdAt}] ${event.actor} @ ${event.repo}: ${event.summary}`
}

export function bucketPrompt(bucket, { from, to, user }) {
  const items = bucket.items.slice(0, MAX_PER_BUCKET).map(itemLine).join('\n')
  const events = bucket.events.slice(0, MAX_PER_BUCKET).map(eventLine).join('\n')
  return [
    `Repository: ${bucket.repo}`,
    `Timeframe: ${from} to ${to}${user ? ` — focus on user ${user}` : ''}`,
    bucket.items.length > MAX_PER_BUCKET || bucket.events.length > MAX_PER_BUCKET
      ? `Note: listing truncated to ${MAX_PER_BUCKET} entries per section.`
      : '',
    items ? `Issues and pull requests:\n${items}` : 'No issue/PR changes.',
    events ? `Activity events:\n${events}` : 'No activity events.',
  ].filter(Boolean).join('\n\n')
}

export const DIGEST_SCHEMA = {
  type: 'object',
  required: ['shipped', 'inProgress', 'discussed', 'stuck'],
  properties: {
    shipped: { type: 'array', items: { type: 'string' }, description: 'Merged/closed work, one line each, mention people and item keys' },
    inProgress: { type: 'array', items: { type: 'string' }, description: 'Open/active work' },
    discussed: { type: 'array', items: { type: 'string' }, description: 'Notable discussions or decisions' },
    stuck: { type: 'array', items: { type: 'string' }, description: 'Stale or blocked-looking work' },
  },
}

export const SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['headline', 'narrative', 'digest'],
  properties: {
    headline: { type: 'string', description: 'One sentence: the shape of the period' },
    narrative: {
      type: 'array',
      items: {
        type: 'object',
        required: ['person', 'contribution'],
        properties: {
          person: { type: 'string', description: 'GitHub login' },
          contribution: { type: 'string', description: 'Plain English — what KIND of work they did, not which PRs. E.g. "Heavy lifting on simulation convergence — rewrote the core loop and got it matching VBA" NOT "Merged #172, closed #166". Substance over references.' },
        },
      },
      description: 'One entry per active contributor. Subjective, qualitative, human. Omit when focused on a single user.',
    },
    digest: {
      type: 'object',
      required: ['merged', 'opened', 'closed', 'items'],
      properties: {
        merged: { type: 'number', description: 'Total merged PRs' },
        opened: { type: 'number', description: 'Total newly opened issues + PRs' },
        closed: { type: 'number', description: 'Total closed issues (not merged)' },
        items: { type: 'array', items: { type: 'string' }, description: 'Key items with repo#N references, one line each. Technical, factual, include PR/issue numbers.' },
      },
      description: 'Aggregate numbers and a technical list of notable items with references.',
    },
    risks: { type: 'array', items: { type: 'string' }, description: 'Stuck/blocked/risky items worth attention' },
  },
}

function fmtDate(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function renderReport(synthesis, meta) {
  const fromFmt = fmtDate(meta.from)
  const toFmt = fmtDate(meta.to)
  const genFmt = fmtDate(meta.generatedAt)
  const scope = meta.user ? ` · ${meta.user}` : ''
  const lines = [
    '---',
    `org: ${meta.org}`,
    `range: ${fromFmt} – ${toFmt}`,
    meta.user ? `user: ${meta.user}` : null,
    `items: ${meta.itemCount}  ·  events: ${meta.eventCount}`,
    `model: ${meta.model || 'workspace default'}`,
    `generated: ${genFmt}`,
    '---',
    '',
    `# ${meta.org}${scope}`,
    `**${fromFmt} – ${toFmt}** · ${meta.itemCount} items, ${meta.eventCount} events`,
    '',
    `> ${synthesis.headline}`,
  ]
  if (synthesis.narrative?.length) {
    lines.push('', '## What happened')
    for (const entry of synthesis.narrative) lines.push(`- **${entry.person}** — ${entry.contribution}`)
  }
  if (synthesis.digest) {
    const d = synthesis.digest
    lines.push('', '## Technical digest', `${d.merged} merged · ${d.opened} opened · ${d.closed} closed`)
    if (d.items?.length) {
      lines.push('')
      for (const item of d.items) lines.push(`- ${item}`)
    }
  }
  if (synthesis.risks?.length) {
    lines.push('', '## Worth attention')
    for (const risk of synthesis.risks) lines.push(`- ${risk}`)
  }
  return lines.filter((l) => l !== null).join('\n') + '\n'
}

export function reportPath(meta) {
  const day = meta.generatedAt.slice(0, 10)
  const slug = [meta.org, meta.from.slice(0, 10), 'to', meta.to.slice(0, 10), meta.user]
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9-]+/g, '-')
  return `reports/github/${day}-${slug}.md`
}

function customInstructionLine(focus) {
  if (!focus) return null
  return `Custom report instructions: ${focus}. Treat the custom instructions as binding for what to analyze, estimate, caveat, and emphasize. If the synced GitHub data cannot support part of the request, say so directly and explain the evidence limit.`
}

function digestSystem(focus) {
  return [
    'You digest GitHub repository activity. Be concrete: name people, item keys (owner/repo#N), and outcomes. No filler.',
    customInstructionLine(focus),
  ].filter(Boolean).join(' ')
}

function synthesisSystem({ user, focus }) {
  return [
    'You write activity summaries for a software organization. Two voices:',
    'NARRATIVE (per person): qualitative, subjective, human — describe the *kind* of work, not PR numbers. "Did heavy lifting on X", "Polished the UI and squashed edge-case bugs", "Reviewed several PRs and caught a regression". No issue/PR references here.',
    'DIGEST: technical, factual — aggregate counts and a list of notable items WITH repo#N references.',
    'Audience: a lead catching up. Plain statements over adjectives.',
    user ? `The summary is about user ${user} specifically — omit narrative array.` : 'Cover the whole org.',
    customInstructionLine(focus),
  ].filter(Boolean).join(' ')
}

export async function runSummarize(ctx, inputs, { nowIso = () => new Date().toISOString() } = {}) {
  const from = requireIso(inputs.from, 'from')
  const to = requireIso(inputs.to, 'to')
  const user = typeof inputs.user === 'string' && inputs.user ? inputs.user : null
  const users = Array.isArray(inputs.users) ? inputs.users.filter((u) => typeof u === 'string' && u) : []
  const repos = Array.isArray(inputs.repos) ? inputs.repos.filter((r) => typeof r === 'string' && r) : []
  const focus = typeof inputs.focus === 'string' && inputs.focus.trim() ? inputs.focus.trim().slice(0, 2000) : ''

  const settings = (await ctx.data.kv.get('settings')) || {}
  const modelId = settings.summaryModel || undefined

  await ctx.progress.step('Gathering activity')
  const items = (await ctx.data.collection('items').list()).map((row) => row.value).filter(Boolean)
  const events = (await ctx.data.collection('events').list()).map((row) => row.value).filter(Boolean)
  const activity = gatherActivity({ items, events }, { from, to, user, users, repos })
  if (activity.items.length === 0 && activity.events.length === 0) {
    throw new Error('No synced activity in that timeframe. Run a sync first or widen the range.')
  }

  const meta = {
    org: settings.org || '',
    from,
    to,
    user,
    model: modelId || '',
    itemCount: activity.items.length,
    eventCount: activity.events.length,
    generatedAt: nowIso(),
  }

  const focusBlock = focus ? `\n\nUser focus note: ${focus}` : ''
  const buckets = bucketByRepo(activity)
  const total = activity.items.length + activity.events.length
  let synthesisInput

  if (total > BUCKET_THRESHOLD && buckets.length > 1) {
    await ctx.progress.step('Summarizing per repository')
    const digests = []
    for (let i = 0; i < buckets.length; i++) {
      ctx.abort?.throwIfAborted?.()
      await ctx.progress.progress(0.15 + (0.55 * i) / buckets.length, buckets[i].repo)
      const digest = unwrapGenerated(await ctx.ai.generateObject({
        modelId,
        system: digestSystem(focus),
        prompt: `${bucketPrompt(buckets[i], meta)}${focusBlock}`,
        schema: DIGEST_SCHEMA,
      }))
      digests.push({ repo: buckets[i].repo, ...digest })
    }
    synthesisInput = `Per-repository digests (JSON):\n${JSON.stringify(digests, null, 1)}`
  } else {
    synthesisInput = buckets.map((bucket) => bucketPrompt(bucket, meta)).join('\n\n---\n\n')
  }

  await ctx.progress.step('Writing summary')
  const generated = await ctx.ai.generateObject({
    modelId,
    system: synthesisSystem({ user, focus }),
    prompt: `Timeframe: ${from} to ${to}.${focusBlock}\n\n${synthesisInput}`,
    schema: SYNTHESIS_SCHEMA,
  })
  const synthesis = unwrapGenerated(generated)
  meta.model = generated?.modelId || meta.model

  const path = reportPath(meta)
  const content = renderReport(synthesis, meta)
  await ctx.tools.call('fs.write', { path, content })

  const reports = (await ctx.data.kv.get('reports')) || []
  reports.unshift({ path, from, to, user, generatedAt: meta.generatedAt, headline: synthesis.headline })
  await ctx.data.kv.set('reports', reports.slice(0, 100))

  await ctx.progress.done(`Report written: ${path}`)
  return { status: 'complete', path, headline: synthesis.headline, itemCount: meta.itemCount, eventCount: meta.eventCount }
}

// ctx.ai.generateObject resolves to { object, usage, modelId, provider }.
function unwrapGenerated(result) {
  if (!result || typeof result.object !== 'object' || result.object === null) {
    throw new Error('AI generation returned no object')
  }
  return result.object
}

function requireIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`summarize requires an ISO date for "${label}"`)
  }
  return new Date(Date.parse(value)).toISOString()
}
