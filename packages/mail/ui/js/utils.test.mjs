// decodeEntities: Gmail API snippets arrive HTML-escaped (&#39; &amp; …)
// and padded with invisible preview characters — both must go before the
// UI escapes for display, or users see literal "&#39;" in list rows.

import { describe, it, expect } from 'vitest'
import { decodeEntities, cleanSnippet } from './utils.js'

describe('decodeEntities', () => {
  it('decodes numeric entities', () => {
    expect(decodeEntities('You&#39;re invited')).toBe("You're invited")
  })

  it('decodes hex entities', () => {
    expect(decodeEntities('a&#x27;b')).toBe("a'b")
  })

  it('decodes named entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &lt;3 &quot;quotes&quot;')).toBe('Tom & Jerry <3 "quotes"')
  })

  it('decodes &amp; last so double-escaped text stays escaped once', () => {
    expect(decodeEntities('&amp;#39;')).toBe('&#39;')
  })

  it('passes plain text through', () => {
    expect(decodeEntities('nothing here')).toBe('nothing here')
  })
})

describe('cleanSnippet', () => {
  it('strips invisible padding characters and collapses whitespace', () => {
    expect(cleanSnippet('See you! ‌ ͏ ͏ ‌  soon')).toBe('See you! soon')
  })

  it('decodes entities too', () => {
    expect(cleanSnippet('You&#39;re in ‌‌')).toBe("You're in")
  })
})

describe('date formats', () => {
  const now = new Date('2026-07-23T12:00:00').getTime()
  it('fmtTime: prior years read as years, not days', async () => {
    const { fmtTime } = await import('./utils.js')
    expect(fmtTime(new Date('2024-07-24T10:00:00').getTime(), now)).toBe('Jul ’24')
    expect(fmtTime(new Date('2026-07-03T10:00:00').getTime(), now)).toBe('3 Jul')
  })
  it('fmtLongTime: prior years carry the full year', async () => {
    const { fmtLongTime } = await import('./utils.js')
    expect(fmtLongTime(new Date('2024-07-03T14:32:00').getTime(), now)).toBe('3 Jul 2024 14:32')
  })
})
