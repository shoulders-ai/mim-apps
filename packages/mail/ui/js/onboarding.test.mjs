import { describe, expect, it } from 'vitest'
import { validateClientJson } from './onboarding.js'

const desktop = {
  installed: {
    client_id: '123-abc.apps.googleusercontent.com',
    client_secret: 'GOCSPX-xyz',
    project_id: 'mail-mirror-42',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
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
})
