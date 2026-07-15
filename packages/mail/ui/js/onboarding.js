// Onboarding (UX-SPEC §3.1): guided BYO-OAuth-client setup with instant
// client-JSON validation. validateClientJson is pure and node-tested.

import { state, render, showToast } from './state.js'
import { escapeHtml, escapeAttr, qs } from './utils.js'
import { icon } from './icons.js'
import * as data from './data.js'

// ── Pure validator (§3.1 step 5) ─────────────────────────────────────────
// -> { state: 'empty'|'incomplete'|'error'|'valid', message?, projectId? }

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

// ── View ─────────────────────────────────────────────────────────────────

const STEPS = [
  {
    n: 1,
    title: 'Create a Google Cloud project',
    link: 'https://console.cloud.google.com/projectcreate',
    linkLabel: 'Open project creator',
    body: 'Any name works. Free, no billing needed.',
  },
  {
    n: 2,
    title: 'Enable the Gmail API',
    link: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    linkLabel: 'Open Gmail API page',
    body: 'Pick your new project, press Enable.',
  },
  {
    n: 3,
    title: 'Configure the consent screen',
    link: 'https://console.cloud.google.com/apis/credentials/consent',
    linkLabel: 'Open consent screen',
    body: 'Workspace account → choose Internal.',
    warning: true,
  },
  {
    n: 4,
    title: 'Create a Desktop-app OAuth client',
    link: 'https://console.cloud.google.com/apis/credentials/oauthclient',
    linkLabel: 'Open client creator',
    body: 'Application type: Desktop app. Download the JSON.',
  },
  {
    n: 5,
    title: 'Paste the client JSON',
  },
]

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
  let inner = ''
  if (step.link) {
    inner += `<a class="ob-link" href="${escapeAttr(step.link)}" target="_blank" rel="noreferrer"
      id="obStepPrimary">${escapeHtml(step.linkLabel)} ↗</a>`
  }
  if (step.body) inner += `<div class="ob-body">${escapeHtml(step.body)}</div>`
  if (step.warning) {
    inner += `<div class="ob-warn">
      <span class="ob-warn-icon">${icon('alert-triangle')}</span>
      <span>Personal account → External + Testing: Google expires the connection every 7 days — you'll reconnect weekly. Add yourself as a test user.</span>
    </div>`
  }
  if (step.n < 5) {
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
    ${ob.consentUrl ? `<div class="ob-quiet">Browser didn't open? <button type="button" class="btn-quiet" data-action="ob-copy-link" title="Copy the consent URL">Copy link</button></div>` : ''}`
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
  // Errors raised outside step 5 (e.g. runtime unavailable at boot) must
  // still have a face — step 5's card only renders when it is current.
  const globalError = state.onboarding.error && state.onboarding.step !== 5
    ? `<div class="ob-error-card" role="alert"><div>${escapeHtml(state.onboarding.error)}</div></div>`
    : ''
  return `<div class="ob-wrap">
    <div class="ob" role="region" aria-label="Connect Gmail">
      <div class="ob-brand">Mail</div>
      <div class="ob-sub">Your Gmail, drafted with you — stored in one local file. Nothing touches a third-party server. One-time setup, about 5 minutes.</div>
      ${globalError}
      <div class="ob-steps">${STEPS.map(stepHtml).join('')}</div>
    </div>
  </div>`
}

// Focus the advancing step's primary control (§5.2).
export function focusStep() {
  requestAnimationFrame(() => {
    if (state.onboarding.step === 5) qs('#obJson')?.focus()
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
  const opened = window.open(ob.consentUrl, '_blank')
  if (!opened) showToast('Browser didn’t open — use Copy link')
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
      // Route → Inbox immediately; the inbox streams in during backfill.
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
  'ob-next': () => {
    state.onboarding.step = Math.min(5, state.onboarding.step + 1)
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
