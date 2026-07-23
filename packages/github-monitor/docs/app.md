# GitHub Monitor App

GitHub Monitor is a read-only Mim app for watching one GitHub organization
across all of its repositories. It indexes repositories, open issues, open pull
requests, recently closed items, recent organization activity, ProjectsV2 board
status, saved views, and AI-generated activity summaries.

The app is intentionally not part of Mim core. Its source can be provided by a
Team at `apps/github-monitor/` or by one Project at
`packages/github-monitor/`.

## Enable

Open **Settings > Apps & agents**, review GitHub Monitor's declared access,
enable it for the current Project, and open the GitHub view.

## Setup

Open GitHub Monitor settings and configure:

| Setting | Purpose |
| --- | --- |
| GitHub token | Classic personal access token stored in the OS keychain. |
| Organization | GitHub organization login, for example `dark-peak-analytics`. |
| Sync window | How far back recently closed items and activity are retained. |
| Repositories | Optional include/exclude list for narrowing large orgs. |
| Summary model | Optional model override for summaries; blank uses the workspace default. |

Use a classic PAT with these scopes:

| Scope | Why |
| --- | --- |
| `repo` | Reads private repositories, issues, and pull requests. |
| `read:org` | Reads organization metadata. |
| `read:project` or `project` | Reads organization ProjectsV2 board metadata. |

Fine-grained PATs may work for repository issues and pull requests, but classic
PATs are the reliable path for organization ProjectsV2 data.

Settings also includes **Clear downloaded data**. It deletes the disposable
local cache for repositories, issues, pull requests, activity events, ProjectsV2
metadata, and sync state. It keeps the token, settings, saved views, and
generated reports.

## What Sync Does

Sync is local, incremental, and safe to rerun.

| Data | Source | Stored in |
| --- | --- | --- |
| Repositories | GitHub GraphQL organization repositories | `repos` collection |
| Issues and PRs | GitHub GraphQL search | `items` collection |
| Activity feed | `GET /orgs/{org}/events` with ETags | `events` collection |
| ProjectsV2 | GitHub GraphQL ProjectsV2 | `projects` collection and item status fields |
| Summaries | Local cache plus workspace AI model | Markdown files under `reports/github/` |

Full sync indexes:

- all currently open issues and pull requests, regardless of age
- recently closed issues and pull requests inside the configured sync window
- repository metadata and open issue/PR totals
- recent org activity events
- open ProjectsV2 boards and item statuses

Full sync first clears the downloaded cache so stale records from a previous
organization or repository filter cannot remain visible. Saving settings also
clears the cache automatically when the organization, sync window, repository
mode, or repository list changes.

Incremental sync starts from the stored item watermark and upserts records by
stable IDs. The cache is disposable: deleting package data only means the next
full sync rebuilds it.

## Using The App

The app is one column: a navigation top bar, one contextual bar that changes
per view, a content area with an optional detail panel, and a status footer.
There is no internal sidebar; Mim's Navigator is the only sidebar.

### Four views

The top bar navigates between four views, each answering a distinct question.

| View | Answers | Shows |
| --- | --- | --- |
| Activity | "What happened recently?" | A chronological feed of org activity and item history, grouped by day. This is the default landing view. |
| Work | "What's open or in flight?" | Every synced issue and pull request as a dense list or board. |
| People | "Who did what? How is someone doing?" | Per-contributor activity stats over a chosen timeframe. |
| Reports | "Write me a digest" | AI activity summaries and past reports. |

Switch views with the tabs, the `1`–`4` keys, or by clicking a person in
People (which jumps to Activity filtered to them).

### Activity

Activity merges GitHub's organization event feed with derived item lifecycle
(opened, merged, closed) so the feed is never empty when work exists. GitHub's
org feed only retains the most recent ~300 events, so derived item history
fills in the gaps; "opened" events are de-duplicated against the feed so each
opening appears once.

Each row shows the time, a type glyph, the actor, the repo, and a one-line
summary. Click an issue/PR row to open it on GitHub. Filter by type (pushes,
reviews, comments, issues, PRs, releases), repo, person, or free text.

### Work

Issues and pull requests together, with a clear type marker on every row
(round dot for issues, diamond for PRs) and an explicit Type control
(All / Issues / PRs) so the two are unified but never confused.

One coherent filter model — no more scope-vs-state overlap:

- **Type**: segmented All / Issues / PRs.
- **State**, **Repo**, **Person**, **Label**, **Project**: searchable
  multi-select dropdowns with per-value counts.
- **Date**: Updated or Created, with presets (Any, 7, 14, 30, 90 days, Custom).
- **Sort**: Updated / Created / Comments. **Layout**: List or Board (group by
  state, assignee, or project status).
- **Views (★)**: a single menu holding built-in presets (All open, Open issues,
  Open PRs, Recently closed), your saved views, and "Save current as view".
  A preset applies a bundle of filters; tweak any filter and the menu shows
  "Custom". Saved views persist filters, sort, layout, and grouping in kv.

When filters are active, a pill strip shows each one with a remove `×` and a
"Clear all" link. The active view, filters, sort, and layout persist in kv as
`uiState`.

Select a row (or use `j`/`k`) to open the detail panel: excerpt, labels,
assignees, project status, comment count, recent repo activity, and an Open on
GitHub link.

### People

Lists every contributor with stats for the chosen timeframe (Last 7 / 30 / 90
days, or Custom): issues opened, PRs opened, PRs merged, reviews, comments,
pushes, repos touched, and last active (relative age plus the absolute date).
The active date range is shown in the contextual bar. Stats combine authored
items with org-feed events. Click a person to jump to Activity scoped to them.

### Reports

AI activity summaries over rolling timeframes. The view is laid out as:

- **Scope** — the timeframe (Last 7 / 30 / 90 days, or Custom) plus optional
  Repos and People filters. This defines *what* gets summarized. The Repos and
  People dropdowns use **dependent counts**: each repo's badge reflects the
  selected people (and timeframe), and each person's badge reflects the
  selected repos (and timeframe) — so selecting repo X makes person Y show Y's
  activity on X, not Y's org-wide total. Options with no activity in the
  current scope are hidden unless already selected.
- **Focus** — an optional free-text instruction for the summarizer (e.g.
  "release readiness", "blockers", "who shipped what"). Left blank, the
  summarizer covers the whole scope. When provided, this focus is included in
  the report agent's system instructions and in the activity prompt so every
  summary pass treats it as binding and calls out evidence limits when the
  local GitHub data cannot support part of the request.
- **Eligibility** — a prominent, live count: `N items · M events will be
  summarized`, computed from the local cache against the current scope. It
  warns when nothing matches, and notes when a large dataset triggers
  per-repo truncation.
- **Generate** — the primary `Summarize activity` action plus a subtle **Model**
  picker (defaults to the workspace default; choosing one persists it to
  settings). While running it shows a live progress label.
- **Past reports** — list below; click to open the markdown file in the editor.

Summaries read the local cache only and write to `reports/github/`.

**Scale.** There is no hard cap and the summarizer never rejects a timeframe.
When activity exceeds 120 entries across more than one repository it
map-reduces: each repository is digested separately (truncated to 200 items
and 200 events per repo), then one synthesis pass combines the digests. So
1,000+ activities are handled gracefully — the cost scales with the number of
active repositories, not the raw item count, and each AI call is bounded by
the per-repo truncation.

### Sync and status

The sync control lives at the right of the top bar. Idle, it shows freshness
(`Synced 2m ago`; click syncs, option-click runs a full re-sync; `s` syncs
from the keyboard). While syncing it becomes a progress meter with the current
step, mirrored by a 2px accent hairline over the content, and shows a brief
`Up to date` confirmation when done. Sync feedback is driven by the live job
event stream, so the meter reflects any in-flight sync regardless of who
started it (the auto-sync on open, your click, or chat); clicking Sync while
one is already running is a no-op that keeps the meter visible, never an error.
The app auto-syncs on open when the last sync is older than 15 minutes. The
sync job is `ephemeral`, so sync runs leave no Activity rows or run records in
Mim; all sync feedback is in-app.

The status footer shows the org, repo totals, sync errors (click for detail),
and freshness; the freshness text turns warning-colored when older than a day.

### Keyboard

`1`–`4` switch views · `/` focus search · `j`/`k` or arrows move Work
selection · `Enter` open the selected item on GitHub · `Esc` close the detail
panel · `s` sync now.

## Summaries

The summary job reads only local package data. It does not call GitHub while
summarizing.

Inputs:

| Input | Meaning |
| --- | --- |
| Timeframe | This week, last week, last 30 days, or custom dates. |
| Repos | Optional multi-select to narrow which repositories are summarized. Default: all. |
| People | Optional multi-select to focus on specific contributors. Default: all. |
| Focus | Optional instruction such as release readiness or blockers. |

Reports have two main sections:

- **What happened** — qualitative, per-person narrative describing the kind of work done (no PR numbers).
- **Technical digest** — aggregate stats (merged/opened/closed counts) and a factual list of notable items with references.

Reports are written to:

```text
reports/github/
```

They are ordinary workspace markdown files, so they can be opened, edited, and
committed like other artifacts.

## Permissions

The package manifest asks for:

| Permission | Use |
| --- | --- |
| `http: ["api.github.com"]` | Restricts network calls to GitHub's API host. |
| `secrets: ["github_token"]` | Stores and reads the PAT from the OS keychain. |
| `workspace.read/write` | Writes markdown summary reports. |
| `ai: true` | Generates activity summaries through the workspace model registry. |

The token is never written into package data or report files.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Token validation says a scope is missing | Use a classic PAT with `repo`, `read:org`, and `read:project` or `project`. |
| Repos appear but issue/PR details are empty | Run a full re-sync. The app also shows repo-index totals so the org does not appear empty while item details rebuild. |
| Activity is sparse | GitHub's org events API is recent activity only, not full history. |
| Projects are missing | Confirm the token has `read:project` or `project`; fine-grained PATs can be inconsistent here. |
| Counts look stale | Use Sync, or Save & full re-sync after changing org/repository filters. |
| Old org data is still visible | Use Settings → Clear downloaded data, or Save & full re-sync. |

## Current Limits

- Read-only: the app does not create or edit GitHub issues, PRs, or projects.
- Polling only: there are no webhooks because Mim is a local desktop app.
- Activity feed is bounded by GitHub's recent org events API.
- Large orgs may require a longer first full sync; repo include/exclude filters
  are available to narrow the scope.
