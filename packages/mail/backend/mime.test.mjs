// mime.test.mjs — tests for RFC 2822/2047 MIME builder
import { describe, it, expect } from 'vitest'
import { createMime } from './mime.mjs'

describe('createMime', () => {
  const mime = createMime()

  describe('buildMessage', () => {
    it('builds a basic message with required headers', () => {
      const msg = mime.buildMessage({
        from: 'Alice <alice@example.com>',
        to: 'Bob <bob@example.com>',
        subject: 'Hello',
        bodyText: 'Hi Bob!',
      })

      expect(msg).toContain('From: Alice <alice@example.com>')
      expect(msg).toContain('To: Bob <bob@example.com>')
      expect(msg).toContain('Subject: Hello')
      expect(msg).toContain('MIME-Version: 1.0')
      expect(msg).toContain('Content-Type: text/plain; charset=UTF-8')
      expect(msg).toContain('Content-Transfer-Encoding: base64')
      expect(msg).toContain('Date: ')
    })

    it('encodes body as base64 with 76-char lines', () => {
      const longBody = 'A'.repeat(200)
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'c@d.com',
        subject: 'Test',
        bodyText: longBody,
      })

      // Find body after empty line
      const parts = msg.split('\r\n\r\n')
      expect(parts.length).toBe(2)
      const bodyLines = parts[1].split('\r\n')
      for (const line of bodyLines) {
        expect(line.length).toBeLessThanOrEqual(76)
      }

      // Decode and verify
      const decoded = Buffer.from(bodyLines.join(''), 'base64').toString('utf-8')
      expect(decoded).toBe(longBody)
    })

    it('uses RFC 2047 UTF-8 base64 encoding for non-ASCII subjects', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'c@d.com',
        subject: 'Héllo Wörld',
        bodyText: 'test',
      })

      // Should contain RFC 2047 encoded-word
      const subjectLine = msg.split('\r\n').find(l => l.startsWith('Subject: '))
      expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/)

      // Decode it
      const match = subjectLine.match(/=\?UTF-8\?B\?(.+)\?=$/)
      const decoded = Buffer.from(match[1], 'base64').toString('utf-8')
      expect(decoded).toBe('Héllo Wörld')
    })

    it('does not encode ASCII-only subjects', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'c@d.com',
        subject: 'Plain ASCII',
        bodyText: 'test',
      })

      expect(msg).toContain('Subject: Plain ASCII')
      expect(msg).not.toContain('=?UTF-8?B?')
    })

    it('handles multiple To recipients', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: ['bob@b.com', 'carol@c.com'],
        subject: 'Test',
        bodyText: 'test',
      })

      expect(msg).toContain('To: bob@b.com, carol@c.com')
    })

    it('includes Cc header when provided', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        cc: ['cc1@b.com', 'cc2@b.com'],
        subject: 'Test',
        bodyText: 'test',
      })

      expect(msg).toContain('Cc: cc1@b.com, cc2@b.com')
    })

    it('includes Bcc header when provided', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        bcc: 'secret@b.com',
        subject: 'Test',
        bodyText: 'test',
      })

      expect(msg).toContain('Bcc: secret@b.com')
    })

    it('omits Cc/Bcc headers when empty', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'test',
      })

      expect(msg).not.toContain('Cc:')
      expect(msg).not.toContain('Bcc:')
    })

    it('does not include a Message-ID header (Gmail assigns)', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'test',
      })

      const lines = msg.split('\r\n')
      const messageIdLine = lines.find(l => l.startsWith('Message-ID:'))
      expect(messageIdLine).toBeUndefined()
    })
  })

  describe('reply threading', () => {
    it('adds In-Reply-To and References headers', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'reply text',
        inReplyTo: '<orig@example.com>',
        references: ['<root@example.com>', '<parent@example.com>'],
      })

      expect(msg).toContain('In-Reply-To: <orig@example.com>')
      // References = original References + original Message-ID
      expect(msg).toContain('References: <root@example.com> <parent@example.com> <orig@example.com>')
    })

    it('adds Re: prefix to subject case-insensitively once', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Hello',
        bodyText: 'reply',
        inReplyTo: '<orig@example.com>',
      })

      expect(msg).toContain('Subject: Re: Hello')
    })

    it('does not double Re: prefix', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Re: Hello',
        bodyText: 'reply',
        inReplyTo: '<orig@example.com>',
      })

      expect(msg).toContain('Subject: Re: Hello')
      expect(msg).not.toContain('Subject: Re: Re: Hello')
    })

    it('does not double RE: prefix (case-insensitive)', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'RE: Hello',
        bodyText: 'reply',
        inReplyTo: '<orig@example.com>',
      })

      // Should keep RE: as-is, not add another Re:
      const subjectLine = msg.split('\r\n').find(l => l.startsWith('Subject: '))
      expect(subjectLine).toBe('Subject: RE: Hello')
    })

    it('handles References being empty — just uses inReplyTo', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'reply',
        inReplyTo: '<orig@example.com>',
        references: [],
      })

      expect(msg).toContain('References: <orig@example.com>')
    })

    it('does not duplicate inReplyTo in References when already present', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'reply',
        inReplyTo: '<orig@example.com>',
        references: ['<orig@example.com>'],
      })

      expect(msg).toContain('References: <orig@example.com>')
      // Should appear only once
      const refLine = msg.split('\r\n').find(l => l.startsWith('References: '))
      const ids = refLine.replace('References: ', '').split(' ')
      expect(ids).toEqual(['<orig@example.com>'])
    })
  })

  describe('quoting', () => {
    it('appends quoted text at send time', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Re: Hello',
        bodyText: 'My reply.',
        inReplyTo: '<orig@example.com>',
        quote: {
          date: 'Mon, 1 Jan 2024 10:00:00 +0000',
          fromDisplay: 'Bob',
          bodyText: 'Original message.\nSecond line.',
        },
      })

      // Decode the body
      const parts = msg.split('\r\n\r\n')
      const bodyBase64 = parts[1].replace(/\r\n/g, '')
      const body = Buffer.from(bodyBase64, 'base64').toString('utf-8')

      expect(body).toContain('My reply.')
      expect(body).toContain('On Mon, 1 Jan 2024 10:00:00 +0000, Bob wrote:')
      expect(body).toContain('> Original message.')
      expect(body).toContain('> Second line.')
    })

    it('does not include quote when not provided', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'Clean body.',
      })

      const parts = msg.split('\r\n\r\n')
      const bodyBase64 = parts[1].replace(/\r\n/g, '')
      const body = Buffer.from(bodyBase64, 'base64').toString('utf-8')

      expect(body).toBe('Clean body.')
      expect(body).not.toContain('wrote:')
    })
  })

  describe('encodeRaw', () => {
    it('produces valid base64url output', () => {
      const raw = mime.encodeRaw('Hello, World!')
      expect(raw).not.toContain('+')
      expect(raw).not.toContain('/')
      expect(raw).not.toContain('=')
    })

    it('round-trips through base64url decode', () => {
      const original = 'From: a@b.com\r\nTo: c@d.com\r\n\r\nBody'
      const encoded = mime.encodeRaw(original)
      // Decode base64url
      const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(b64, 'base64').toString('utf-8')
      expect(decoded).toBe(original)
    })
  })

  describe('byte-pattern assertions', () => {
    it('uses CRLF line endings between headers', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'body',
      })

      // Headers separated by CRLF
      const buf = Buffer.from(msg, 'utf-8')
      const crlfIdx = buf.indexOf('\r\n')
      expect(crlfIdx).toBeGreaterThan(0)
    })

    it('has exactly one empty line (CRLFCRLF) between headers and body', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Test',
        bodyText: 'body',
      })

      const separatorIdx = msg.indexOf('\r\n\r\n')
      expect(separatorIdx).toBeGreaterThan(0)

      // Only one occurrence of the double CRLF separator
      const afterSep = msg.indexOf('\r\n\r\n', separatorIdx + 4)
      expect(afterSep).toBe(-1)
    })

    it('encodes non-ASCII subject as valid base64 bytes', () => {
      const subject = '日本語テスト'
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject,
        bodyText: 'test',
      })

      const subLine = msg.split('\r\n').find(l => l.startsWith('Subject: '))
      const m = subLine.match(/=\?UTF-8\?B\?(.+)\?=$/)
      expect(m).not.toBeNull()

      // Verify the encoded bytes decode correctly
      const decoded = Buffer.from(m[1], 'base64').toString('utf-8')
      expect(decoded).toBe(subject)
    })

    it('Re: prefix on non-ASCII subject is encoded correctly', () => {
      const msg = mime.buildMessage({
        from: 'a@b.com',
        to: 'b@b.com',
        subject: 'Ünïcödé',
        bodyText: 'reply',
        inReplyTo: '<orig@example.com>',
      })

      const subLine = msg.split('\r\n').find(l => l.startsWith('Subject: '))
      const m = subLine.match(/=\?UTF-8\?B\?(.+)\?=$/)
      expect(m).not.toBeNull()
      const decoded = Buffer.from(m[1], 'base64').toString('utf-8')
      expect(decoded).toBe('Re: Ünïcödé')
    })
  })
})
