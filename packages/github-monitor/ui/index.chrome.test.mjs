import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'index.html'), 'utf8')

// Structural contracts for the redesigned GitHub Monitor UI. These lock the
// decisions that make the interface clear: four destination views, one
// contextual bar (not stacked subbar/filterbar/pills bands), rolling summary
// timeframes, and Activity as the default landing surface.

describe('GitHub Monitor UI structural contracts', () => {
  it('exposes exactly four navigation views: Activity, Work, People, Reports', () => {
    const viewsBlock = source.match(/const VIEWS = \[([\s\S]*?)\]/)?.[1] ?? ''
    for (const id of ['activity', 'work', 'people', 'reports']) {
      expect(viewsBlock).toContain(`id: '${id}'`)
    }
    // No leftover Items tab from the old design.
    expect(viewsBlock).not.toMatch(/id: 'items'/)
  })

  it('makes Activity the default landing view', () => {
    expect(source).toMatch(/view: 'activity'/)
  })

  it('renders one contextual bar, not the old stacked subbar/filterbar/pills bands', () => {
    expect(source).toMatch(/class="ctxbar"/)
    expect(source).toMatch(/class="ctx-controls"/)
    // The old design had separate #subbar, #filterbar, and #pills-bar elements.
    expect(source).not.toMatch(/id="subbar"/)
    expect(source).not.toMatch(/id="filterbar"/)
    expect(source).not.toMatch(/id="pills-bar"/)
  })

  it('keeps the sync instrument in the top bar, separate from navigation', () => {
    expect(source).toMatch(/id="sync-slot"/)
    expect(source).toMatch(/id="nav"/)
  })

  it('uses rolling timeframes for reports, not calendar-bound weeks', () => {
    expect(source).toMatch(/data-range="7d"/)
    expect(source).toMatch(/data-range="30d"/)
    expect(source).toMatch(/data-range="90d"/)
    // The old "This week" / "Last week" presets are gone.
    expect(source).not.toMatch(/'week'/)
    expect(source).not.toMatch(/'lastweek'/)
    expect(source).not.toMatch(/Last week/)
  })

  it('derives a unified activity timeline so the feed is never empty when items exist', () => {
    expect(source).toMatch(/function buildActivityFeed/)
    expect(source).toMatch(/kind: 'opened'/)
    expect(source).toMatch(/kind: 'feed'/)
  })

  it('keeps read-only GitHub open as the only outbound item action', () => {
    expect(source).toMatch(/Open on GitHub/)
    // No inline create/edit/duplicate GitHub-state affordances.
    expect(source).not.toMatch(/New issue/)
    expect(source).not.toMatch(/Edit on GitHub/)
  })

  it('drives sync feedback from the global job-event stream, not per-run subscriptions', () => {
    // The bug that cleared the sync meter on "Job already running": feedback
    // must be keyed by jobId globally so a click while a sync is running is
    // a no-op, not an error that clobbers in-flight state.
    expect(source).toMatch(/function setupJobListener/)
    expect(source).toMatch(/event\.jobId === 'sync'/)
    // A click while already running surfaces the running sync instead of erroring.
    expect(source).toMatch(/already running/i)
    expect(source).toMatch(/if \(S\.syncing\) \{ renderSync\(\); return \}/)
  })

  it('shows a prominent pre-flight eligibility count and a model picker in Reports', () => {
    expect(source).toMatch(/class="r-eligibility"/)
    expect(source).toMatch(/will be summarized/)
    expect(source).toMatch(/id="rep-model"/)
    expect(source).toMatch(/Workspace default/)
  })

  it('keeps implementation detail out of the Reports generate row', () => {
    // The old muted "Reads the local cache only · writes to reports/github/"
    // inline span does not belong in the UI; it survives only as a button title.
    expect(source).not.toMatch(/Reads the local cache only · writes to reports\/github\/<\/span>/)
  })

  it('computes Reports facet counts dependently so each badge reflects the other filter', () => {
    // Selecting repo X must make person Y's badge show Y's activity on X (and
    // vice versa), not Y's all-time total. Each facet reflects the OTHER facet
    // plus the timeframe, never its own selection.
    expect(source).toMatch(/function reportFacetCounts/)
    expect(source).toMatch(/People badges reflect the selected repos/)
    expect(source).toMatch(/Repo badges reflect the selected people/)
    // The opts pull counts from the facet maps, not from all-time totals.
    expect(source).toMatch(/count: facets\.people\.get\(p\) \|\| 0/)
    expect(source).toMatch(/count: facets\.repos\.get\(r\) \|\| 0/)
    // Zero-count options that are not already selected are hidden so the list
    // stays relevant as filters narrow.
    expect(source).toMatch(/o\.count > 0 \|\| S\.reports_form\.users\.includes/)
    expect(source).toMatch(/o\.count > 0 \|\| S\.reports_form\.repos\.includes/)
  })

  it('shows the GitHub mark in the top bar and links it to the configured org', () => {
    // The manifest icon is text-only, so the recognizable brand mark lives in
    // the app's own top bar as an inline SVG, linking to the org on GitHub.
    expect(source).toMatch(/class="brand" id="org-link"/)
    expect(source).toMatch(/viewBox="0 0 16 16" fill="currentColor"/)
    // The href is derived from the configured org at render time.
    expect(source).toMatch(/https:\/\/github\.com\/\$\{encodeURIComponent\(org\)\}/)
  })

  it('uses the GitHub mark SVG as the sidebar/rail icon, not a letter token', () => {
    // The package manifest points the icon at a served SVG asset so the
    // Navigator nav-token renders the masked GitHub mark (core capability)
    // instead of the placeholder 'G' token.
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    expect(manifest.mim.icon).toBe('./ui/icon.svg')
    expect(existsSync(join(here, 'icon.svg'))).toBe(true)
    const svg = readFileSync(join(here, 'icon.svg'), 'utf8')
    expect(svg).toMatch(/viewBox="0 0 16 16"/)
  })

  it('offers a settings action to clear downloaded GitHub cache', () => {
    expect(source).toMatch(/id="btn-clear-cache"/)
    expect(source).toMatch(/Clear downloaded data/)
    expect(source).toMatch(/function clearDownloadedData/)
  })

  it('clears cache-affecting settings changes before saving or full sync', () => {
    expect(source).toMatch(/function settingsAffectCache/)
    expect(source).toMatch(/settingsAffectCache\(S\.settings \|\| \{\}, settings\)/)
    expect(source).toMatch(/await clearDownloadedData\(/)
  })
})
