#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { serializeKnowledge } from '../backend/index.mjs'

const SOURCE_DEFAULT = join(homedir(), 'mim', 'context')
const TARGET_DEFAULT = join(process.cwd(), 'knowledge')
const NOW = new Date().toISOString()

const SKIP = new Set(['ai-integration-framework.md', 'log.md'])

const PROJECTS = {
  'eversana.md': {
    id: 'eversana-engagement',
    tags: ['fde', 'heor', 'client'],
    org: 'eversana',
    contacts: ['nicole-ferko', 'sumeet-singh', 'tim-disher'],
    links: ['engagement_for eversana', 'introduced_by ciaran-higgins', 'applies_to fde-three-views'],
  },
  'healthlumen.md': {
    id: 'healthlumen-engagement',
    tags: ['fde', 'epi', 'client'],
    org: 'healthlumen',
    contacts: ['simon-lande', 'james-cook'],
    links: ['engagement_for healthlumen'],
  },
  'vandage.md': {
    id: 'vandage-engagement',
    tags: ['fde', 'rwe', 'client'],
    org: 'vandage',
    contacts: ['daniel-gensorowsky'],
    links: ['engagement_for vandage', 'applies_to fde-three-views'],
  },
  'scharr-consulting.md': {
    id: 'scharr-engagement',
    tags: ['freelance', 'heor', 'client'],
    org: 'scharr',
    contacts: ['donna-rowen'],
    links: ['engagement_for scharr'],
  },
  'adigens.md': {
    id: 'adigens-engagement',
    tags: ['fde', 'rwe', 'pipeline'],
    org: 'adigens',
    contacts: ['radek-wasiak'],
    links: ['engagement_for adigens', 'applies_to fde-three-views'],
  },
  'horizon.md': {
    id: 'horizon-engagement',
    tags: ['fde', 'heor', 'pipeline'],
    org: 'horizon',
    contacts: ['tom-ward'],
    links: ['engagement_for horizon'],
  },
  'thermo-fisher.md': {
    id: 'thermo-fisher-engagement',
    tags: ['fde', 'heor', 'pipeline'],
    org: 'thermo-fisher',
    contacts: ['rachel-huelin'],
    links: ['engagement_for thermo-fisher'],
  },
  'vitaccess.md': {
    id: 'vitaccess-engagement',
    tags: ['fde', 'rwe', 'pipeline'],
    org: 'vitaccess',
    contacts: ['anna-richards'],
    links: ['engagement_for vitaccess'],
  },
  'science-prestige.md': {
    id: 'science-prestige',
    tags: ['research', 'pipeline'],
    contacts: ['mathis-federico'],
    links: [],
  },
  'model-builder.md': {
    id: 'model-builder',
    tags: ['heor', 'product'],
    contacts: ['matthijs'],
    links: [],
  },
}

const NOTES = {
  'shoulders.md': ['shoulders', ['product', 'shoulders', 'heor']],
  'nice-graph.md': ['nice-graph', ['product', 'nice', 'heor']],
  'mesh.md': ['mesh', ['product', 'concept']],
  'heor-benchmark.md': ['heor-benchmark', ['initiative', 'heor', 'benchmark']],
  'fde-three-views.md': ['fde-three-views', ['fde', 'framework', 'positioning']],
  'fde-pitch-notes.md': ['fde-pitch-notes', ['fde', 'pitch', 'sales']],
  'fde-pe-roll-ups.md': ['fde-pe-roll-ups', ['fde', 'pe', 'strategy']],
  'fde-panel-spc.md': ['fde-panel-spc', ['fde', 'panel', 'reference']],
  'palantirization.md': ['palantirization', ['fde', 'critique', 'strategy']],
  'domain-native-ai-playbook.md': ['domain-native-ai-playbook', ['fde', 'playbook', 'reference']],
  'marketing-template-alephic.md': ['marketing-template-alephic', ['fde', 'template', 'marketing']],
  'yc-ai-native-company.md': ['yc-ai-native-company', ['strategy', 'reference', 'yc']],
  'vc-market-insights.md': ['vc-market-insights', ['vc', 'strategy', 'reference']],
  'ai-native-consultancy-framework.md': ['ai-native-consultancy-framework', ['fde', 'framework', 'working-notes']],
  'heor-ai-survey.md': ['heor-ai-survey', ['heor', 'research', 'collaboration']],
  'style.md': ['style', ['style', 'design', 'reference']],
  'writing.md': ['writing', ['style', 'writing', 'reference']],
  'voice-samples.md': ['voice-samples', ['voice', 'writing', 'reference']],
  'post-examples.md': ['post-examples', ['linkedin', 'writing', 'reference']],
  'bio.md': ['bio', ['identity', 'reference']],
  'cv.md': ['cv', ['identity', 'reference']],
  'user.md': ['user', ['identity', 'reference']],
  'kinderakademie-research.md': ['kinderakademie', ['personal', 'eberswalde', 'school']],
}

const RECORDS = {
  'priorb.md': ['priorb', ['admin', 'company', 'tax'], true],
  'personal-bank-account.md': ['personal-bank-account', ['banking', 'personal', 'sensitive'], true],
}

const NOTE_LINKS = {
  'fde-three-views': ['references fde-pitch-notes', 'counterweights palantirization'],
  'fde-pitch-notes': ['references fde-three-views', 'references fde-pe-roll-ups'],
  palantirization: ['counterweights fde-three-views'],
  'domain-native-ai-playbook': ['references fde-three-views'],
}

const ORGS = {
  eversana: ['EVERSANA', 'Global HEOR and life-sciences services organization; org for the EVERSANA AI advisory engagement.', ['eversana', 'heor', 'client'], { kind: 'client' }],
  healthlumen: ['HealthLumen', 'Epidemiology consultancy and client context for AI workflow audit work.', ['healthlumen', 'epi', 'client'], { kind: 'client' }],
  vandage: ['Vandage', 'RWE boutique consultancy using Shoulders and AI-assisted review/workflow tooling.', ['vandage', 'rwe', 'client'], { kind: 'client' }],
  scharr: ['SCHARR', 'University of Sheffield SCHARR consulting context for DCE image generation work.', ['scharr', 'heor', 'client'], { kind: 'client' }],
  adigens: ['Adigens Health', 'RWE consultancy and FDE pipeline prospect for AI workflow integration.', ['adigens', 'rwe', 'pipeline'], { kind: 'pipeline' }],
  horizon: ['Horizon Health Economics', 'HEOR consultancy and pipeline prospect around AI workflow integration.', ['horizon', 'heor', 'pipeline'], { kind: 'pipeline' }],
  'thermo-fisher': ['Thermo Fisher Scientific', 'Pipeline prospect from Evidence Synthesis leadership interest in AI tooling.', ['thermo-fisher', 'heor', 'pipeline'], { kind: 'pipeline' }],
  vitaccess: ['Vitaccess', 'Patient-centered RWE company and pipeline prospect for proposal/status workflow automation.', ['vitaccess', 'rwe', 'pipeline'], { kind: 'pipeline' }],
}

const PEOPLE = {
  'nicole-ferko': ['Nicole Ferko', 'General Manager, Value & Evidence Services at EVERSANA. Primary contact for the AI+HEOR consulting engagement.', ['eversana', 'heor', 'client'], ['works_at eversana', 'contact_for eversana-engagement'], { role: 'General Manager, Value & Evidence Services', org: 'eversana' }],
  'sumeet-singh': ['Sumeet Singh', 'VP HEOR at EVERSANA. Contact for the EVERSANA AI+HEOR consulting engagement.', ['eversana', 'heor', 'client'], ['works_at eversana', 'contact_for eversana-engagement'], { role: 'VP, HEOR', org: 'eversana' }],
  'tim-disher': ['Tim Disher', 'Consultant to EVERSANA working with the core AI team; technical contact for evidence synthesis and GVD automation context.', ['eversana', 'heor', 'client'], ['works_at eversana', 'contact_for eversana-engagement'], { role: 'Consultant', org: 'eversana' }],
  'ciaran-higgins': ['Ciaran Higgins', 'Introduced Paul to the EVERSANA opportunity.', ['eversana', 'network'], [], {}],
  'simon-lande': ['Simon Lande', 'HealthLumen contact for AI workflow audit and coaching work.', ['healthlumen', 'epi', 'client'], ['works_at healthlumen', 'contact_for healthlumen-engagement'], { org: 'healthlumen' }],
  'james-cook': ['James Cook', 'HealthLumen contact involved in AI workflow and data workbook work.', ['healthlumen', 'epi', 'client'], ['works_at healthlumen', 'contact_for healthlumen-engagement'], { org: 'healthlumen' }],
  'daniel-gensorowsky': ['Daniel Gensorowsky', 'Vandage contact for Shoulders, Word review, and RWE workflow automation.', ['vandage', 'rwe', 'client'], ['works_at vandage', 'contact_for vandage-engagement'], { org: 'vandage' }],
  'donna-rowen': ['Donna Rowen', 'SCHARR contact for DCE image generation consulting and Sheffield procurement.', ['scharr', 'heor', 'client'], ['works_at scharr', 'contact_for scharr-engagement'], { org: 'scharr' }],
  'radek-wasiak': ['Radek Wasiak', 'Adigens Health contact for RWE/FDE advisory pipeline work.', ['adigens', 'rwe', 'pipeline'], ['works_at adigens', 'contact_for adigens-engagement'], { org: 'adigens' }],
  'tom-ward': ['Tom Ward', 'Horizon Health Economics contact for HEOR AI workflow pipeline discussions.', ['horizon', 'heor', 'pipeline'], ['works_at horizon', 'contact_for horizon-engagement'], { org: 'horizon' }],
  'rachel-huelin': ['Rachel Huelin', 'Thermo Fisher Scientific evidence synthesis contact who reached out about AI tooling.', ['thermo-fisher', 'heor', 'pipeline'], ['works_at thermo-fisher', 'contact_for thermo-fisher-engagement'], { org: 'thermo-fisher' }],
  'anna-richards': ['Anna Richards', 'Head of Commercial at Vitaccess; contact for proposal and SharePoint workflow automation pipeline.', ['vitaccess', 'rwe', 'pipeline'], ['works_at vitaccess', 'contact_for vitaccess-engagement'], { role: 'Head of Commercial', org: 'vitaccess', email: 'anna.richards@vitaccess.com' }],
  'mathis-federico': ['Mathis Federico', 'Contact for Science Prestige knowledge graph project quantifying scientific prestige through evidence-hypothesis networks.', ['research', 'pipeline'], ['contact_for science-prestige'], {}],
  matthijs: ['Matthijs', 'Netherlands-based collaborator on the agentic HTA cost-effectiveness model builder prototype.', ['heor', 'product'], ['contact_for model-builder'], {}],
}

function parseArgs(argv) {
  const args = { source: SOURCE_DEFAULT, target: TARGET_DEFAULT, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = resolve(argv[++i])
    else if (argv[i] === '--target') args.target = resolve(argv[++i])
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const close = raw.indexOf('\n---', 3)
  if (close === -1) return { meta: {}, body: raw }
  return {
    meta: parseFrontmatter(raw.slice(3, close).trim()),
    body: raw.slice(close + 4).replace(/^\r?\n/, ''),
  }
}

function parseFrontmatter(text) {
  const meta = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    meta[match[1]] = parseScalar(match[2])
  }
  return meta
}

function parseScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(part => part.trim()).filter(Boolean)
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return trimmed
}

function titleFromBody(body, fallback) {
  const heading = body.match(/^#\s+(.+)$/m)
  return heading ? heading[1].trim() : fallback
}

function summaryFrom(meta, body) {
  const source = typeof meta.description === 'string' && meta.description.trim()
    ? meta.description.trim()
    : firstBodySentence(body)
  return truncate(source.replace(/\s+/g, ' '), 320)
}

function firstBodySentence(body) {
  return body
    .split(/\r?\n/)
    .map(line => line.replace(/^#+\s+/, '').trim())
    .find(Boolean) || ''
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max - 3).trimEnd() + '...' : value
}

function entry(id, title, type, summary, tags, links, extra, body = '') {
  return {
    id,
    title,
    type,
    summary,
    tags,
    links,
    extra,
    created: NOW,
    updated: NOW,
    body,
  }
}

function contextEntry(sourceDir, file) {
  const raw = readFileSync(join(sourceDir, file), 'utf8')
  const { meta, body } = splitFrontmatter(raw)
  const project = PROJECTS[file]
  if (project) {
    const links = [...project.links, ...project.contacts.map(contact => `has_contact ${contact}`)]
    const extra = {}
    for (const key of ['status', 'client', 'domain', 'rate', 'source']) {
      if (meta[key] !== undefined) extra[key] = meta[key]
    }
    return entry(project.id, titleFromBody(body, project.id), 'project', summaryFrom(meta, body), project.tags, links, extra, body)
  }

  if (NOTES[file]) {
    const [id, tags] = NOTES[file]
    const extra = {}
    for (const key of ['status', 'domain', 'source']) {
      if (meta[key] !== undefined) extra[key] = meta[key]
    }
    return entry(id, titleFromBody(body, id), 'note', summaryFrom(meta, body), tags, NOTE_LINKS[id] || [], extra, body)
  }

  if (RECORDS[file]) {
    const [id, tags, sensitive] = RECORDS[file]
    return entry(id, titleFromBody(body, id), 'record', summaryFrom(meta, body), tags, [], { sensitive }, body)
  }

  return null
}

function agenticPatternEntries(sourceDir) {
  const dir = join(sourceDir, 'files', 'agentic-engineering-patterns')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const raw = readFileSync(join(dir, name), 'utf8')
      const { body } = splitFrontmatter(raw)
      const base = name.replace(/\.md$/, '')
      const id = `agentic-engineering-${base.replace(/^[0-9]+-?/, '') || 'index'}`
      return entry(
        id,
        titleFromBody(body, base.replace(/-/g, ' ')),
        'note',
        truncate(firstBodySentence(body), 320),
        ['agentic-engineering', 'reference'],
        base === '00-index' ? [] : ['references agentic-engineering-index'],
        { source_path: `context/files/agentic-engineering-patterns/${name}` },
        body,
      )
    })
}

function seedEntries(sourceDir) {
  const entries = []
  for (const [id, [title, summary, tags, extra]] of Object.entries(ORGS)) {
    entries.push(entry(id, title, 'org', summary, tags, [], extra))
  }
  for (const [id, [title, summary, tags, links, extra]] of Object.entries(PEOPLE)) {
    entries.push(entry(id, title, 'person', summary, tags, links, extra))
  }
  for (const file of readdirSync(sourceDir).filter(name => name.endsWith('.md')).sort()) {
    if (SKIP.has(file)) continue
    const migrated = contextEntry(sourceDir, file)
    if (migrated) entries.push(migrated)
  }
  entries.push(...agenticPatternEntries(sourceDir))
  return entries
}

function writeEntry(targetDir, item, force) {
  const path = join(targetDir, `${item.id}.md`)
  if (existsSync(path) && !force) return { skipped: item.id }
  writeFileSync(path, serializeKnowledge(item), 'utf8')
  return { written: item.id }
}

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.source)) throw new Error(`Source context directory not found: ${args.source}`)
mkdirSync(args.target, { recursive: true })

const results = seedEntries(args.source).map(item => writeEntry(args.target, item, args.force))
const written = results.filter(result => result.written).length
const skipped = results.filter(result => result.skipped).length
console.log(`Seeded ${written} knowledge entries into ${args.target}; skipped ${skipped} existing files.`)
if (skipped > 0) console.log('Use --force to overwrite existing entries.')
