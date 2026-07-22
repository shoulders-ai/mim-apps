import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  validateClientJson, setupInstructionsText, renderOnboarding,
  onboardingActions, focusStep,
} from './onboarding.js'
import { state } from './state.js'

const desktop = {
  installed: {
    client_id: '123-abc.apps.googleusercontent.com',
    client_secret: 'GOCSPX-xyz',
    project_id: 'mail-mirror-42',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
}

const ARROW = '→' // '→' — banned from all onboarding copy

beforeEach(() => {
  Object.assign(state.onboarding, {
    step: 1, json: '', validation: null, connecting: false,
    waiting: false, consentUrl: '', deadline: 0, error: '', copied: false,
    accountType: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Node has no DOM; give focusStep/action handlers a capturing stand-in.
function stubDom() {
  const focused = []
  vi.stubGlobal('document', {
    querySelector: (sel) => ({ focus: () => focused.push(sel) }),
  })
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 0 })
  return focused
}

describe('validateClientJson', () => {
  it('empty input is quiet', () => {
    expect(validateClientJson('')).toEqual({ state: 'empty' })
    expect(validateClientJson('   \n ')).toEqual({ state: 'empty' })
  })

  it('invalid JSON while typing is incomplete, not an error', () => {
    const v = validateClientJson('{"installed": {')
    expect(v.state).toBe('incomplete')
    expect(v.message).toBe('Not valid JSON yet.')
  })

  it('non-object JSON is incomplete', () => {
    expect(validateClientJson('42').state).toBe('incomplete')
    expect(validateClientJson('[1,2]').state).toBe('incomplete')
    expect(validateClientJson('null').state).toBe('incomplete')
  })

  it('web-application clients are rejected by name', () => {
    const v = validateClientJson(JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }))
    expect(v.state).toBe('error')
    expect(v.message).toContain('Web application')
    expect(v.message).toContain('Desktop app')
  })

  it('missing installed key is an error', () => {
    const v = validateClientJson(JSON.stringify({ something: {} }))
    expect(v.state).toBe('error')
    expect(v.message).toContain('installed')
  })

  it('missing client_id / client_secret are named field errors', () => {
    const noId = JSON.parse(JSON.stringify(desktop))
    delete noId.installed.client_id
    expect(validateClientJson(JSON.stringify(noId))).toEqual({
      state: 'error', message: 'Missing installed.client_id.',
    })
    const noSecret = JSON.parse(JSON.stringify(desktop))
    delete noSecret.installed.client_secret
    expect(validateClientJson(JSON.stringify(noSecret))).toEqual({
      state: 'error', message: 'Missing installed.client_secret.',
    })
  })

  it('a valid Desktop client passes with its project id', () => {
    expect(validateClientJson(JSON.stringify(desktop))).toEqual({
      state: 'valid', projectId: 'mail-mirror-42',
    })
  })

  it('valid without project_id still passes', () => {
    const bare = { installed: { client_id: 'a', client_secret: 'b' } }
    expect(validateClientJson(JSON.stringify(bare))).toEqual({ state: 'valid', projectId: '' })
  })

  it('no validation message ever contains a raw arrow', () => {
    const inputs = [
      '{"installed": {', '42', '[1,2]', 'null',
      JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }),
      JSON.stringify({ something: {} }),
      JSON.stringify({ installed: { client_secret: 'b' } }),
      JSON.stringify({ installed: { client_id: 'a' } }),
    ]
    for (const input of inputs) {
      expect(validateClientJson(input).message ?? '').not.toContain(ARROW)
    }
  })
})

describe('setupInstructionsText', () => {
  const titles = [
    'Create a Google Cloud project',
    'Enable the Gmail API',
    'Configure the consent screen',
    'Create a Desktop-app OAuth client',
    'Paste the client JSON',
  ]

  it('workspace branch: Internal, no External, no arrows', () => {
    const text = setupInstructionsText('workspace')
    expect(text).toContain('Work (Google Workspace)')
    expect(text).toContain('Choose Internal. Done.')
    expect(text).not.toContain('External')
    expect(text).not.toContain('test user')
    expect(text).not.toContain(ARROW)
  })

  it('personal branch: External + test user + 7-day expiry, no Internal, no arrows', () => {
    const text = setupInstructionsText('personal')
    expect(text).toContain('Personal Gmail')
    expect(text).toContain('Choose External, then add yourself as a test user.')
    expect(text).toContain('every 7 days')
    expect(text).toContain('about 20 seconds')
    expect(text).not.toContain('Internal')
    expect(text).not.toContain(ARROW)
  })

  it('lists exactly five numbered steps with titles and links, fork excluded', () => {
    for (const acct of ['workspace', 'personal']) {
      const text = setupInstructionsText(acct)
      expect(text.match(/^\d+\. /gm)).toHaveLength(5)
      titles.forEach((t, i) => expect(text).toContain(`${i + 1}. ${t}`))
      expect(text).not.toContain('Which account?')
      expect(text).toContain('https://console.cloud.google.com/projectcreate')
      expect(text).toContain('https://console.cloud.google.com/apis/library/gmail.googleapis.com')
      expect(text).toContain('https://console.cloud.google.com/apis/credentials/consent')
      expect(text).toContain('https://console.cloud.google.com/apis/credentials/oauthclient')
    }
  })

  it('without a chosen type, both branches are inlined and labeled', () => {
    const text = setupInstructionsText(null)
    expect(text).toContain('Work (Google Workspace): Choose Internal. Done.')
    expect(text).toContain('Personal Gmail: Choose External')
    expect(text).toContain('every 7 days')
    expect(text).not.toContain(ARROW)
  })
})

describe('renderOnboarding', () => {
  it('sub-line is honest: no third-party-server claim, discloses AI data flow', () => {
    const html = renderOnboarding()
    expect(html).toContain('Your own Google OAuth client. About four minutes.')
    expect(html).toContain('Mail mirrors to one local file. Drafting sends the open thread and your voice notes to the AI model you configure — nowhere else.')
    expect(html).not.toContain('Nothing touches a third-party server')
    expect(html).not.toContain('third-party')
    expect(html).not.toContain('5 minutes')
  })

  it('renders six steps with the paste step last', () => {
    const html = renderOnboarding()
    expect(html.match(/class="ob-step ob-(done|future|current)"/g)).toHaveLength(6)
    expect(html.indexOf('Paste the client JSON')).toBeGreaterThan(html.indexOf('Which account?'))
  })

  it('step 1 is the account fork: two option buttons, workspace first and focusable', () => {
    const html = renderOnboarding()
    expect(html).toContain('Which account?')
    expect(html).toContain('Work (Google Workspace)')
    expect(html).toContain('Personal Gmail')
    const first = html.match(/<button[^>]*data-action="ob-account"[^>]*>/)
    expect(first[0]).toContain('data-account="workspace"')
    expect(first[0]).toContain('id="obStepPrimary"')
    expect(first[0]).toContain('btn-quiet')
    expect(html).toContain('data-account="personal"')
    // The fork advances by choosing — no generic Done button on it.
    expect(html).not.toContain('data-action="ob-next"')
  })

  it('a completed fork step reopens via ob-goto like any done step', () => {
    state.onboarding.step = 3
    state.onboarding.accountType = 'workspace'
    const html = renderOnboarding()
    expect(html).toMatch(/data-action="ob-goto" data-step="1"/)
  })

  it('consent step tailors to workspace: Internal, no warning card', () => {
    state.onboarding.step = 4
    state.onboarding.accountType = 'workspace'
    const html = renderOnboarding()
    expect(html).toContain('Choose Internal. Done.')
    expect(html).not.toContain('External')
    expect(html).not.toContain('ob-warn')
  })

  it('consent step tailors to personal: External + test user + red 7-day warning', () => {
    state.onboarding.step = 4
    state.onboarding.accountType = 'personal'
    const html = renderOnboarding()
    expect(html).toContain('Choose External, then add yourself as a test user.')
    expect(html).toContain('ob-warn')
    expect(html).toContain('every 7 days')
    expect(html).toContain('about 20 seconds')
    expect(html).not.toContain('Choose Internal')
  })

  it('offers a copy-setup-instructions action beside the sub-line', () => {
    const html = renderOnboarding()
    const btn = html.match(/<button[^>]*data-action="ob-copy-setup"[^>]*>/)
    expect(btn[0]).toContain('btn-quiet')
    expect(html).toContain('Copy setup instructions')
  })

  it('no raw arrow anywhere, on any step, for either account type', () => {
    for (const acct of ['workspace', 'personal', null]) {
      for (let step = 1; step <= 6; step++) {
        state.onboarding.step = step
        state.onboarding.accountType = acct
        expect(renderOnboarding()).not.toContain(ARROW)
      }
    }
  })

  it('paste step (6) renders the textarea and gates Connect on validation', () => {
    state.onboarding.step = 6
    state.onboarding.accountType = 'personal'
    let html = renderOnboarding()
    expect(html).toContain('id="obJson"')
    expect(html.match(/<button[^>]*id="obConnect"[^>]*>/)[0]).toContain('disabled')
    state.onboarding.validation = { state: 'valid', projectId: 'p' }
    html = renderOnboarding()
    expect(html.match(/<button[^>]*id="obConnect"[^>]*>/)[0]).not.toContain('disabled')
  })

  it('global errors keep a face on every step but the paste step', () => {
    state.onboarding.error = 'Runtime unavailable: boom'
    state.onboarding.step = 1
    expect(renderOnboarding()).toContain('role="alert"')
    state.onboarding.step = 6
    const html = renderOnboarding()
    expect(html).not.toContain('role="alert"')
    expect(html).toContain('ob-error-card') // paste step renders its own card
  })
})

describe('onboardingActions + focus discipline', () => {
  it('ob-account stores the type, advances to step 2, focuses its primary control', () => {
    const focused = stubDom()
    onboardingActions['ob-account']({ dataset: { account: 'workspace' } })
    expect(state.onboarding.accountType).toBe('workspace')
    expect(state.onboarding.step).toBe(2)
    expect(focused).toContain('#obStepPrimary')

    state.onboarding.step = 1
    onboardingActions['ob-account']({ dataset: { account: 'personal' } })
    expect(state.onboarding.accountType).toBe('personal')
    expect(state.onboarding.step).toBe(2)
  })

  it('ob-next clamps at the paste step (6)', () => {
    stubDom()
    state.onboarding.step = 5
    onboardingActions['ob-next']()
    expect(state.onboarding.step).toBe(6)
    onboardingActions['ob-next']()
    expect(state.onboarding.step).toBe(6)
  })

  it('ob-goto reopens an earlier step', () => {
    stubDom()
    state.onboarding.step = 4
    onboardingActions['ob-goto']({ dataset: { step: '1' } })
    expect(state.onboarding.step).toBe(1)
  })

  it('focusStep targets the fork option, step links, then the textarea', () => {
    let focused = stubDom()
    state.onboarding.step = 1
    focusStep()
    expect(focused).toEqual(['#obStepPrimary'])

    focused.length = 0
    state.onboarding.step = 4
    focusStep()
    expect(focused).toEqual(['#obStepPrimary'])

    focused.length = 0
    state.onboarding.step = 6
    focusStep()
    expect(focused).toEqual(['#obJson'])
  })

  it('ob-copy-setup copies the chosen branch and toasts', async () => {
    stubDom()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    state.onboarding.accountType = 'personal'
    await onboardingActions['ob-copy-setup']()
    expect(writeText).toHaveBeenCalledWith(setupInstructionsText('personal'))
    expect(state.toast.msg).toBe('Setup instructions copied')
  })

  it('ob-copy-setup before the fork copies both branches', async () => {
    stubDom()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await onboardingActions['ob-copy-setup']()
    const text = writeText.mock.calls[0][0]
    expect(text).toContain('Choose Internal. Done.')
    expect(text).toContain('Choose External')
  })

  it('ob-copy-setup failure toasts without throwing', async () => {
    stubDom()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('nope') }) } })
    await onboardingActions['ob-copy-setup']()
    expect(state.toast.msg).toBe('Copy failed')
  })
})
