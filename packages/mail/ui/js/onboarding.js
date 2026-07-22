// Onboarding (UX-SPEC §3.1): guided BYO-OAuth-client setup with instant
// client-JSON validation. Step 1 forks on account type (workspace |
// personal) and tailors the consent-screen copy; the paste step is last.
// validateClientJson and setupInstructionsText are pure and node-tested.

import { state, render, showToast } from './state.js'
import { escapeHtml, escapeAttr, qs } from './utils.js'
import { icon } from './icons.js'
import * as data from './data.js'

// state.js owns the store shape; the fork field is seeded here at runtime.
state.onboarding.accountType ??= null

// ── Pure validator (paste step) ──────────────────────────────────────────
// Returns { state: 'empty'|'incomplete'|'error'|'valid', message?, projectId? }

export function validateClientJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { state: 'empty' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'incomplete', message: 'Not valid JSON yet.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'incomplete', message: 'Not valid JSON yet.' }
  }
  if (parsed.web) {
    return { state: 'error', message: 'This is a Web application client. Create a Desktop app client instead.' }
  }
  const inst = parsed.installed
  if (!inst || typeof inst !== 'object') {
    return { state: 'error', message: 'No "installed" client in this JSON — download the Desktop app client file.' }
  }
  if (!inst.client_id) return { state: 'error', message: 'Missing installed.client_id.' }
  if (!inst.client_secret) return { state: 'error', message: 'Missing installed.client_secret.' }
  return { state: 'valid', projectId: inst.project_id || '' }
}

// ── Account-type fork copy ───────────────────────────────────────────────

const ACCOUNT_LABELS = {
  workspace: 'Work (Google Workspace)',
  personal: 'Personal Gmail',
}

const CONSENT_COPY = {
  workspace: { body: 'Choose Internal. Done.', warn: '' },
  personal: {
    body: 'Choose External, then add yourself as a test user.',
    warn: 'Google disconnects personal accounts every 7 days — reconnecting takes about 20 seconds.',
  },
}

// Unknown/unset falls back to the personal copy — the cautious branch.
function consentCopy(accountType) {
  return CONSENT_COPY[accountType] || CONSENT_COPY.personal
}

// ── Steps ────────────────────────────────────────────────────────────────
// body/warning may be functions of accountType (resolved at render time).
// `text` is the plain-text stand-in used only by setupInstructionsText.

const STEPS = [
  {
    n: 1,
    title: 'Which account?',
    fork: true,
  },
  {
    n: 2,
    title: 'Create a Google Cloud project',
    link: 'https://console.cloud.google.com/projectcreate',
    linkLabel: 'Open project creator',
    body: 'Any name works. Free, no billing needed.',
  },
  {
    n: 3,
    title: 'Enable the Gmail API',
    link: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    linkLabel: 'Open Gmail API page',
    body: 'Pick your new project, press Enable.',
  },
  {
    n: 4,
    title: 'Configure the consent screen',
    link: 'https://console.cloud.google.com/apis/credentials/consent',
    linkLabel: 'Open consent screen',
    body: (accountType) => consentCopy(accountType).body,
    warning: (accountType) => consentCopy(accountType).warn,
  },
  {
    n: 5,
    title: 'Create a Desktop-app OAuth client',
    link: 'https://console.cloud.google.com/apis/credentials/oauthclient',
    linkLabel: 'Open client creator',
    body: 'Application type: Desktop app. Download the JSON.',
  },
  {
    n: 6,
    title: 'Paste the client JSON',
    text: 'Open Mail and paste the contents of the downloaded JSON file into the setup screen.',
  },
]

const LAST_STEP = STEPS.length

// ── Plain-text instructions for handing to IT ────────────────────────────
// Pure. Inlines the chosen account-type branch; with no choice yet, both
// branches appear, labeled.

export function setupInstructionsText(accountType) {
  const acct = ACCOUNT_LABELS[accountType] ? accountType : null
  const branchLine = (type) => {
    const c = consentCopy(type)
    return [c.body, c.warn].filter(Boolean).join(' ')
  }
  const lines = ['Mail — Gmail setup (your own Google OAuth client, Desktop app)']
  lines.push(acct
    ? `Account type: ${ACCOUNT_LABELS[acct]}`
    : 'Account type: not chosen yet — both options included below.')
  STEPS.filter((s) => !s.fork).forEach((step, i) => {
    lines.push('', `${i + 1}. ${step.title}`)
    if (typeof step.body === 'function') {
      if (acct) lines.push(`   ${branchLine(acct)}`)
      else {
        lines.push(`   ${ACCOUNT_LABELS.workspace}: ${branchLine('workspace')}`)
        lines.push(`   ${ACCOUNT_LABELS.personal}: ${branchLine('personal')}`)
      }
    } else if (step.body || step.text) {
      lines.push(`   ${step.body || step.text}`)
    }
    if (step.link) lines.push(`   ${step.link}`)
  })
  return lines.join('\n') + '\n'
}

// ── View ─────────────────────────────────────────────────────────────────

function forkHtml() {
  return `<div>
    <button type="button" class="btn-quiet" data-action="ob-account" data-account="workspace"
      id="obStepPrimary" title="Google Workspace account">${escapeHtml(ACCOUNT_LABELS.workspace)}</button>
    <button type="button" class="btn-quiet" data-action="ob-account" data-account="personal"
      title="Personal @gmail.com account">${escapeHtml(ACCOUNT_LABELS.personal)}</button>
  </div>`
}

function stepHtml(step) {
  const ob = state.onboarding
  const current = ob.step === step.n
  const done = ob.step > step.n
  if (done) {
    return `<button type="button" class="ob-step ob-done" data-action="ob-goto" data-step="${step.n}"
      title="Reopen step ${step.n}">
      <span class="ob-check">${icon('check')}</span>
      <span class="ob-num">${step.n}</span>
      <span class="ob-step-title">${escapeHtml(step.title)}</span>
    </button>`
  }
  if (!current) {
    return `<div class="ob-step ob-future">
      <span class="ob-dot">○</span>
      <span class="ob-num">${step.n}</span>
      <span class="ob-step-title">${escapeHtml(step.title)}</span>
    </div>`
  }
  const body = typeof step.body === 'function' ? step.body(ob.accountType) : step.body
  const warning = typeof step.warning === 'function' ? step.warning(ob.accountType) : ''
  let inner = ''
  if (step.link) {
    inner += `<a class="ob-link" href="${escapeAttr(step.link)}" target="_blank" rel="noreferrer"
      id="obStepPrimary">${escapeHtml(step.linkLabel)} ↗</a>`
  }
  if (body) inner += `<div class="ob-body">${escapeHtml(body)}</div>`
  if (warning) {
    inner += `<div class="ob-warn">
      <span class="ob-warn-icon">${icon('alert-triangle')}</span>
      <span>${escapeHtml(warning)}</span>
    </div>`
  }
  if (step.fork) {
    inner += forkHtml() // choosing advances — no generic Done button
  } else if (step.n < LAST_STEP) {
    inner += `<button type="button" class="btn-quiet ob-next" data-action="ob-next" title="Mark done, continue">Done — next</button>`
  } else {
    inner += pasteStepHtml()
  }
  return `<div class="ob-step ob-current">
    <span class="ob-dot ob-dot-on">●</span>
    <span class="ob-num">${step.n}</span>
    <span class="ob-step-title">${escapeHtml(step.title)}</span>
    <div class="ob-step-body">${inner}</div>
  </div>`
}

function pasteStepHtml() {
  const ob = state.onboarding
  const v = ob.validation
  let feedback = ''
  if (v && v.state === 'incomplete') {
    feedback = `<div class="ob-quiet">${escapeHtml(v.message)}</div>`
  } else if (v && v.state === 'error') {
    feedback = `<div class="ob-error">${escapeHtml(v.message)}</div>`
  } else if (v && v.state === 'valid') {
    feedback = `<div class="ob-ok">${icon('check')} Desktop client ✓${v.projectId ? ` · project ${escapeHtml(v.projectId)}` : ''}</div>`
  }

  let connect = ''
  if (ob.waiting) {
    const left = Math.max(0, Math.ceil((ob.deadline - Date.now()) / 1000))
    const mm = Math.floor(left / 60)
    const ss = String(left % 60).padStart(2, '0')
    connect = `<div class="ob-wait">
      <span class="spinner" aria-hidden="true"></span>
      <span>Waiting for Google… (<span class="mono" id="obCountdown">${mm}:${ss}</span>)</span>
      <button type="button" class="btn-quiet" data-action="ob-cancel" title="Stop waiting">Cancel</button>
    </div>
    ${ob.consentUrl ? `<div class="ob-quiet">Browser didn't open? <a href="${escapeHtml(ob.consentUrl)}" target="_blank" rel="noreferrer">Open link</a> · <button type="button" class="btn-quiet" data-action="ob-copy-link" title="Copy the consent URL">Copy link</button></div>` : ''}`
  } else {
    connect = `<button type="button" class="btn-primary" data-action="ob-connect" id="obConnect"
      ${v?.state === 'valid' && !ob.connecting ? '' : 'disabled'} title="Store the client and open Google consent">
      ${ob.connecting ? '<span class="spinner" aria-hidden="true"></span> Connecting…' : 'Connect Google'}</button>`
  }

  const error = ob.error
    ? `<div class="ob-error-card">
        <div>${escapeHtml(ob.error)}</div>
        <button type="button" class="btn-quiet" data-action="ob-retry" title="Try connecting again">Try again</button>
      </div>`
    : ''

  return `<textarea id="obJson" class="ob-json" rows="6" spellcheck="false" data-region="input"
      placeholder="Paste client_secret_*.json">${escapeHtml(ob.json)}</textarea>
    ${feedback}
    ${connect}
    ${error}`
}

export function renderOnboarding() {
  // Errors raised outside the paste step (e.g. runtime unavailable at boot)
  // must still have a face — the paste step's card only renders when it is
  // current.
  const globalError = state.onboarding.error && state.onboarding.step !== LAST_STEP
    ? `<div class="ob-error-card" role="alert"><div>${escapeHtml(state.onboarding.error)}</div></div>`
    : ''
  return `<div class="ob-wrap">
    <div class="ob" role="region" aria-label="Connect Gmail">
      <div class="ob-brand">Mail</div>
      <div class="ob-sub">
        <div>Your own Google OAuth client. About four minutes.</div>
        <div>Mail mirrors to one local file. Drafting sends the open thread and your voice notes to the AI model you configure — nowhere else.</div>
        <button type="button" class="btn-quiet" data-action="ob-copy-setup" title="Copy these steps as plain text, e.g. for IT">Copy setup instructions</button>
      </div>
      ${globalError}
      <div class="ob-steps">${STEPS.map(stepHtml).join('')}</div>
    </div>
  </div>`
}

// Focus the advancing step's primary control (§5.2): the fork step's first
// option and link steps carry #obStepPrimary; the paste step focuses the
// textarea.
export function focusStep() {
  requestAnimationFrame(() => {
    if (state.onboarding.step === LAST_STEP) qs('#obJson')?.focus()
    else qs('#obStepPrimary')?.focus()
  })
}

let countdownTimer = null
let pollTimer = null

function stopConnectTimers() {
  if (countdownTimer) clearInterval(countdownTimer)
  if (pollTimer) clearInterval(pollTimer)
  countdownTimer = pollTimer = null
}

async function startConnect() {
  const ob = state.onboarding
  ob.error = ''
  ob.connecting = true
  render()
  try {
    await data.setSecret('google_oauth_client', ob.json.trim())
  } catch (err) {
    ob.connecting = false
    ob.error = `Couldn't store the client: ${err?.message || err}`
    render()
    return
  }
  const r = await data.connectStart()
  if (!r.ok) {
    ob.connecting = false
    ob.error = r.error
    render()
    return
  }
  ob.connecting = false
  ob.waiting = true
  ob.consentUrl = r.value.consentUrl
  ob.deadline = Date.now() + 120000
  // Electron denies the popup and opens the URL in the system browser via
  // shell.openExternal, so window.open returns null even on success — the
  // return value must not be treated as failure. The waiting card carries an
  // Open link + Copy link fallback for the cases where nothing opened.
  window.open(ob.consentUrl, '_blank')
  render()

  countdownTimer = setInterval(() => {
    const el = qs('#obCountdown')
    const left = Math.max(0, Math.ceil((state.onboarding.deadline - Date.now()) / 1000))
    if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    if (left <= 0) {
      stopConnectTimers()
      state.onboarding.waiting = false
      state.onboarding.error = 'Timed out waiting for Google. Try again.'
      render()
    }
  }, 1000)

  pollTimer = setInterval(async () => {
    await data.refreshConn()
    if (state.conn.connected && state.conn.tokenOk) {
      stopConnectTimers()
      state.onboarding.waiting = false
      // Route to Inbox immediately; the inbox streams in during backfill.
      state.route = { view: 'inbox', threadId: null, draftId: null }
      render()
      data.getSettings()
      await data.loadInbox({ reset: true })
      data.ensureFastPoll()
      render()
      requestAnimationFrame(() => qs('#listRows .trow')?.focus())
    }
  }, 2500)
}

export const onboardingActions = {
  'ob-account': (el) => {
    state.onboarding.accountType = el.dataset.account === 'workspace' ? 'workspace' : 'personal'
    state.onboarding.step = 2
    render()
    focusStep()
  },
  'ob-next': () => {
    state.onboarding.step = Math.min(LAST_STEP, state.onboarding.step + 1)
    render()
    focusStep()
  },
  'ob-goto': (el) => {
    state.onboarding.step = Number(el.dataset.step)
    render()
    focusStep()
  },
  'ob-connect': () => { startConnect() },
  'ob-retry': () => { startConnect() },
  'ob-cancel': () => {
    // Backend flow self-terminates; just reset the UI (§3.1).
    stopConnectTimers()
    state.onboarding.waiting = false
    state.onboarding.connecting = false
    render()
  },
  'ob-copy-link': async () => {
    try {
      await navigator.clipboard.writeText(state.onboarding.consentUrl)
      showToast('Link copied')
    } catch {
      showToast('Copy failed — select the URL manually')
    }
  },
  'ob-copy-setup': async () => {
    try {
      await navigator.clipboard.writeText(setupInstructionsText(state.onboarding.accountType))
      showToast('Setup instructions copied')
    } catch {
      showToast('Copy failed')
    }
  },
}

export function bindOnboardingInputs(root) {
  const ta = qs('#obJson', root)
  if (!ta) return
  ta.addEventListener('input', () => {
    state.onboarding.json = ta.value
    const prev = state.onboarding.validation?.state
    state.onboarding.validation = validateClientJson(ta.value)
    if (state.onboarding.validation.state !== prev) {
      // Re-render feedback + button without stealing the textarea focus.
      const caret = [ta.selectionStart, ta.selectionEnd]
      render()
      const next = qs('#obJson')
      if (next) {
        next.focus()
        try { next.setSelectionRange(caret[0], caret[1]) } catch {}
      }
    }
  })
}
