// GitHub Monitor backend: jobs and tools exported per the Mim runtime contract.

import { createGitHub, headerGet } from './github.mjs'
import { clearDownloadedData, runSync } from './sync.mjs'
import { runSummarize } from './summarize.mjs'

async function github(ctx) {
  const token = await ctx.secrets.get('github_token')
  return createGitHub({ http: ctx.http, token })
}

export const jobs = {
  sync: {
    label: 'Sync GitHub org',
    concurrency: 'single',
    // Housekeeping: no persisted run record, no Activity row. Progress lives in the app UI.
    ephemeral: true,
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Re-sync the whole window instead of starting from the watermark' },
      },
    },
    async run(ctx, input) {
      const gh = await github(ctx)
      return runSync(ctx, gh, { full: input?.full === true })
    },
  },

  summarize: {
    label: 'Summarize activity',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO start of the timeframe' },
        to: { type: 'string', description: 'ISO end of the timeframe' },
        user: { type: 'string', description: 'Optional single GitHub login to focus on (legacy, prefer users)' },
        users: { type: 'array', items: { type: 'string' }, description: 'Optional GitHub logins to include' },
        repos: { type: 'array', items: { type: 'string' }, description: 'Optional repos to include (full name, e.g. org/repo)' },
        focus: { type: 'string', description: 'Optional free-text focus note for the summary' },
      },
      required: ['from', 'to'],
    },
    async run(ctx, input) {
      return runSummarize(ctx, input)
    },
  },
}

export const tools = {
  validateToken: {
    label: 'Validate GitHub token',
    description: 'Check the stored GitHub token and report the authenticated login and token scopes.',
    inputSchema: { type: 'object', properties: {} },
    async execute(ctx) {
      const gh = await github(ctx)
      const result = await gh.rest('user')
      const scopes = (await safeScopes(gh)) || ''
      return {
        ok: true,
        login: result.body?.login || '',
        name: result.body?.name || '',
        scopes,
      }
    },
  },

  clearDownloadedData: {
    label: 'Clear downloaded GitHub data',
    description: 'Delete the local GitHub Monitor cache for repositories, issues, pull requests, activity events, projects, and sync state. Settings, token, saved views, and generated reports are kept.',
    inputSchema: { type: 'object', properties: {} },
    async execute(ctx) {
      return clearDownloadedData(ctx)
    },
  },

  summarizeActivity: {
    label: 'Summarize GitHub activity',
    description: 'Start a GitHub activity summary job for a timeframe, optionally focused on one user. Requires the GitHub Monitor package to be configured and synced.',
    audience: ['chat'],
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO start of the timeframe' },
        to: { type: 'string', description: 'ISO end of the timeframe' },
        user: { type: 'string', description: 'Optional GitHub login to focus on' },
        focus: { type: 'string', description: 'Optional focus note' },
      },
      required: ['from', 'to'],
    },
    async execute(ctx, input) {
      return ctx.tools.call('package.jobs.start', {
        jobId: 'summarize',
        inputs: {
          from: input.from,
          to: input.to,
          ...(typeof input.user === 'string' && input.user ? { user: input.user } : {}),
          ...(typeof input.focus === 'string' && input.focus ? { focus: input.focus } : {}),
        },
      })
    },
  },
}

async function safeScopes(gh) {
  // Classic PATs report scopes in the x-oauth-scopes header of any response.
  try {
    const result = await gh.rest('rate_limit')
    return headerGet(result.response, 'x-oauth-scopes')
  } catch {
    return null
  }
}
