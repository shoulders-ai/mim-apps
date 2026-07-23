# GitHub Monitor — a Mim package

Org-wide GitHub overview inside Mim: every issue, pull request, project board,
and activity event across all repositories of an organization, with filtering,
saved views, a board layout, an activity feed, and AI-written "who did what"
summaries for any timeframe.

## Availability and activation

In the `mim-apps` checkout this directory is a Project app. It can be promoted
to a Team source at `apps/github-monitor/` when it should be available across
Projects, or copied to one Project at `packages/github-monitor/`.

Open **Settings > Apps & agents**, review its declared access, and enable it for
the current Project.

## Setup

1. Open the **GitHub** view in Mim and hit **Settings**.
2. Paste a GitHub **classic personal access token** with scopes
   `repo`, `read:org`, `read:project` (or `project`)
   (create one at github.com/settings/tokens). The token is stored in the OS
   keychain — it never touches a file and is never shown again.
3. Enter your organization name, optionally narrow the repository list, and
   pick a summary model (defaults to the workspace chat model).
4. **Save & full re-sync**. A full re-sync first clears the local downloaded
   GitHub cache, then rebuilds it from the current settings.

## What it does

- **Sync** (incremental, resumable): repositories, all currently open issues +
  PRs, recently closed items in the sync window, GraphQL search time-range
  bisection around GitHub's 1,000-result search cap, the org activity feed via
  REST with ETags, and ProjectsV2 board statuses denormalized onto items.
- **Four views**, each answering a distinct question:
  - **Activity** — "what happened recently?" A chronological feed that merges
    the org event feed with derived item lifecycle (opened/merged/closed), so
    it is never empty when work exists.
  - **Work** — "what's open or in flight?" Issues + PRs as a dense list or
    board, with one coherent filter model (type, state, repo, person, label,
    project, date) and saved views.
  - **People** — "who did what?" Per-contributor stats (opened, merged,
    reviews, comments, pushes) over a rolling timeframe.
  - **Reports** — "write me a digest." AI summaries over rolling timeframes
    (Last 7 / 30 / 90 days, or Custom), globally or scoped to people/repos.
- **Summaries** write narrative + technical-digest markdown to `reports/github/`
  via the workspace AI model; large timeframes are map-reduced per repository.
- **Chat tool**: `summarizeActivity` lets the workspace agent kick off a
  summary for any timeframe.

## Permissions (manifest)

| Permission | Why |
| --- | --- |
| `http: ["api.github.com"]` | the only host the backend may call |
| `secrets: ["github_token"]` | keychain slot for the PAT |
| `workspace: read/write` | writes summary reports into the workspace |
| `ai: true` | generates summaries via the workspace model registry |

All synced data is a disposable local cache (package collections); deleting it
just means the next sync rebuilds it. Settings has **Clear downloaded data** for
removing cached repos, issues, pull requests, events, projects, and sync state
without removing the token, settings, saved views, or generated reports.

## Development

```sh
npm install
npm test        # vitest — backend logic runs against a fake runtime ctx
```

Backend modules are plain ESM with the runtime `ctx` injected, so everything
(sync engine, bisection, rate-limit handling, summarizer) is unit-tested
without network or Electron. See `docs/plan.md` for the full design.

## Docs

- `docs/app.md` — user/operator documentation for enabling, configuring,
  syncing, summaries, permissions, and troubleshooting.
- `docs/plan.md` — original build plan and architecture notes.
