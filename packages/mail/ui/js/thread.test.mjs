// cleanBody display cleanup + foldQuoted contract.

import { describe, it, expect } from 'vitest'
import { cleanBody, foldQuoted } from './thread.js'

describe('cleanBody', () => {
  it('collapses runs of 3+ newlines to a single blank line', () => {
    expect(cleanBody('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('normalizes CRLF and lone CR to LF', () => {
    expect(cleanBody('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('strips invisible preview-padding characters (ZWNJ, CGJ, ZWSP, soft hyphen, BOM)', () => {
    const junk = 'Hello‌͏​­﻿ world'
    expect(cleanBody(junk)).toBe('Hello world')
  })

  it('turns invisible-only padding lines into collapsed blanks', () => {
    const body = 'Intro\n‌ ‌ ‌\n͏ ͏ ‌\n‌\n\nReal content'
    expect(cleanBody(body)).toBe('Intro\n\nReal content')
  })

  it('trims trailing whitespace per line and around the body', () => {
    expect(cleanBody('  \na  \nb\t\n  ')).toBe('a\nb')
  })

  it('keeps normal single and double newlines intact', () => {
    expect(cleanBody('a\nb\n\nc')).toBe('a\nb\n\nc')
  })
})

describe('linkify', () => {
  it('turns bare URLs into safe anchors and escapes everything else', async () => {
    const { linkify } = await import('./thread.js')
    const html = linkify('See https://example.com/a?b=1&c=2 <now>')
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">')
    expect(html).toContain('&lt;now&gt;')
    expect(html).not.toContain('<now>')
  })

  it('keeps trailing punctuation out of the link', async () => {
    const { linkify } = await import('./thread.js')
    const html = linkify('Go to https://example.com/x.')
    expect(html).toContain('href="https://example.com/x"')
    expect(html.endsWith('</a>.')).toBe(true)
  })

  it('plain text passes through escaped only', async () => {
    const { linkify } = await import('./thread.js')
    expect(linkify('a & b')).toBe('a &amp; b')
  })
})

describe('foldQuoted', () => {
  it('folds a trailing "On … wrote:" quote block', () => {
    const body = 'Thanks!\n\nOn Mon, Jul 1, 2026, Alice wrote:\n> earlier\n> lines'
    const { main, quoted } = foldQuoted(body)
    expect(main).toBe('Thanks!')
    expect(quoted).toContain('> earlier')
  })

  it('returns everything as main when there is no quote trail', () => {
    const { main, quoted } = foldQuoted('Just a message\nwith lines')
    expect(main).toBe('Just a message\nwith lines')
    expect(quoted).toBe('')
  })
})
