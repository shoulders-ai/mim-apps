// Send-gate helpers: recipient validation and the ⌘⏎ guard-defer math.
// The confirm card is the product's hard human send gate — these pure
// helpers back the footer disable, the primaryAction refusal, the card's
// invalid-recipient error line, and the defer-never-drop send guard.

import { describe, it, expect } from 'vitest'
import { validRecipients, sendGuardDelay } from './studio.js'

const a = (email, name = '') => ({ name, email })

describe('validRecipients', () => {
  it('splits valid and invalid entries across to/cc/bcc', () => {
    const draft = {
      to: [a('alice@example.com'), a('x@')],
      cc: [a('bob@corp.io'), a('nope')],
      bcc: [a('carol@site.org')],
    }
    const r = validRecipients(draft)
    expect(r.valid.map(x => x.email)).toEqual(['alice@example.com', 'bob@corp.io', 'carol@site.org'])
    expect(r.invalid.map(x => x.email)).toEqual(['x@', 'nope'])
  })

  it('returns empty invalid for an all-valid draft', () => {
    const draft = { to: [a('a@b.co')], cc: [a('c@d.ee')], bcc: [] }
    expect(validRecipients(draft)).toEqual({
      valid: [a('a@b.co'), a('c@d.ee')],
      invalid: [],
    })
  })

  it('returns both empty for an empty draft', () => {
    expect(validRecipients({ to: [], cc: [], bcc: [] })).toEqual({ valid: [], invalid: [] })
  })

  it('rejects addresses without a dot after the @, without a user part, or with spaces', () => {
    const draft = {
      to: [a('foo@bar'), a('@x.com'), a('a b@c.de'), a('x@'), a('plainname')],
      cc: [],
      bcc: [],
    }
    const r = validRecipients(draft)
    expect(r.valid).toEqual([])
    expect(r.invalid).toHaveLength(5)
  })

  it('keeps the original entry objects (name preserved) in both buckets', () => {
    const good = a('ada@math.org', 'Ada')
    const bad = a('broken@', 'Broken')
    const r = validRecipients({ to: [good, bad], cc: [], bcc: [] })
    expect(r.valid[0]).toBe(good)
    expect(r.invalid[0]).toBe(bad)
  })

  it('tolerates missing fields and a null draft', () => {
    expect(validRecipients({ to: [a('a@b.co')] })).toEqual({ valid: [a('a@b.co')], invalid: [] })
    expect(validRecipients(null)).toEqual({ valid: [], invalid: [] })
  })
})

describe('sendGuardDelay', () => {
  it('returns the remaining guard time when inside the window', () => {
    expect(sendGuardDelay(0)).toBe(250)
    expect(sendGuardDelay(100)).toBe(150)
    expect(sendGuardDelay(249)).toBe(1)
  })

  it('returns 0 exactly at the window boundary', () => {
    expect(sendGuardDelay(250)).toBe(0)
  })

  it('returns 0 (never negative) past the window', () => {
    expect(sendGuardDelay(251)).toBe(0)
    expect(sendGuardDelay(10_000)).toBe(0)
  })

  it('honours a custom guard length', () => {
    expect(sendGuardDelay(40, 100)).toBe(60)
    expect(sendGuardDelay(120, 100)).toBe(0)
  })
})
