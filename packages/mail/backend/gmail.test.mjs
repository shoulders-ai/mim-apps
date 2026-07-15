// gmail.test.mjs — tests for Gmail REST client
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createGmailClient, extractBody, htmlToText, parseMessage, extractAttachments } from './gmail.mjs'
import {
  fakeFetch, fakeSecrets, buildGmailMessage, buildMultipartMessage,
  buildHtmlOnlyMessage, buildAttachmentMessage, buildProfile,
  buildLabelsResponse, buildMessageList, buildHistoryResponse, base64url,
} from './testUtils.mjs'

function fakeOAuth(accessTokenValue = 'test-token') {
  let callCount = 0
  return {
    accessToken: async () => {
      callCount++
      return accessTokenValue
    },
    get _callCount() { return callCount },
  }
}

describe('createGmailClient', () => {
  let oauth

  beforeEach(() => {
    oauth = fakeOAuth()
  })

  describe('request wrapper', () => {
    it('includes Authorization header with Bearer token', async () => {
      let capturedHeaders
      const fetch = async (url, options) => {
        capturedHeaders = options.headers
        return { ok: true, status: 200, json: async () => ({}) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await gmail.profile()

      expect(capturedHeaders.Authorization).toBe('Bearer test-token')
    })

    it('builds query string from query params', async () => {
      let capturedUrl
      const fetch = async (url, options) => {
        capturedUrl = url
        return { ok: true, status: 200, json: async () => ({ messages: [] }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await gmail.listMessages('is:unread', 'page2')

      expect(capturedUrl).toContain('q=is%3Aunread')
      expect(capturedUrl).toContain('pageToken=page2')
      expect(capturedUrl).toContain('maxResults=100')
    })

    it('surfaces API errors with status', async () => {
      const fetch = fakeFetch([{
        method: 'GET',
        pattern: '/users/me/profile',
        handler: () => ({
          status: 400,
          body: { error: { code: 400, message: 'Bad request' } },
        }),
      }])

      const gmail = createGmailClient({ oauth, fetch })

      try {
        await gmail.profile()
        expect.fail('should have thrown')
      } catch (err) {
        expect(err.message).toContain('Bad request')
        expect(err.status).toBe(400)
      }
    })
  })

  describe('retry logic', () => {
    it('retries 429 once honoring Retry-After ≤ 5s', async () => {
      let attempts = 0
      const fetch = async (url, options) => {
        attempts++
        if (attempts === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (k) => k.toLowerCase() === 'retry-after' ? '0.1' : null },
            json: async () => ({ error: { message: 'Rate limit' } }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ emailAddress: 'test@test.com' }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      const result = await gmail.profile()

      expect(attempts).toBe(2)
      expect(result.emailAddress).toBe('test@test.com')
    })

    it('does not retry 429 when Retry-After > 5s', async () => {
      const fetch = async () => ({
        ok: false,
        status: 429,
        headers: { get: (k) => k.toLowerCase() === 'retry-after' ? '10' : null },
        json: async () => ({ error: { message: 'Rate limit' } }),
      })

      const gmail = createGmailClient({ oauth, fetch })
      await expect(gmail.profile()).rejects.toThrow('Rate limit')
    })

    it('retries 403 rate-limit errors with exponential backoff up to 3 times', async () => {
      let attempts = 0
      const fetch = async () => {
        attempts++
        if (attempts <= 3) {
          return {
            ok: false,
            status: 403,
            headers: { get: () => null },
            json: async () => ({
              error: {
                message: 'Rate limit exceeded',
                errors: [{ reason: 'rateLimitExceeded' }],
              },
            }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      const result = await gmail.profile()

      expect(attempts).toBe(4) // 3 retries + 1 success
      expect(result.ok).toBe(true)
    }, 15000) // longer timeout for backoff waits

    it('fails after 3 unsuccessful 403 rate-limit retries', async () => {
      const fetch = async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({
          error: {
            message: 'Rate limit exceeded',
            errors: [{ reason: 'rateLimitExceeded' }],
          },
        }),
      })

      const gmail = createGmailClient({ oauth, fetch })
      await expect(gmail.profile()).rejects.toThrow('Rate limit exceeded')
    }, 15000)

    it('does not retry non-rate-limit 403 errors', async () => {
      let attempts = 0
      const fetch = async () => {
        attempts++
        return {
          ok: false,
          status: 403,
          headers: { get: () => null },
          json: async () => ({
            error: {
              message: 'Insufficient Permission',
              errors: [{ reason: 'insufficientPermissions' }],
            },
          }),
        }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await expect(gmail.profile()).rejects.toThrow('Insufficient Permission')
      expect(attempts).toBe(1) // no retries
    })

    it('retries 401 once with forced token refresh', async () => {
      let attempts = 0
      let refreshCalled = false
      const oauthWithRefresh = {
        accessToken: async () => 'test-token',
        refreshAccessToken: async () => {
          refreshCalled = true
          return 'refreshed-token'
        },
      }
      const fetch = async () => {
        attempts++
        if (attempts === 1) {
          return {
            ok: false,
            status: 401,
            headers: { get: () => null },
            json: async () => ({ error: { message: 'Unauthorized' } }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ emailAddress: 'test@test.com' }) }
      }

      const gmail = createGmailClient({ oauth: oauthWithRefresh, fetch })
      const result = await gmail.profile()

      expect(attempts).toBe(2)
      expect(refreshCalled).toBe(true)
      expect(result.emailAddress).toBe('test@test.com')
    })

    it('fails on second 401 (no infinite retry)', async () => {
      const fetch = async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({ error: { message: 'Unauthorized' } }),
      })

      const gmail = createGmailClient({ oauth, fetch })
      await expect(gmail.profile()).rejects.toThrow('Unauthorized')
    })
  })

  describe('typed helpers', () => {
    it('profile() calls /users/me/profile', async () => {
      const fetch = fakeFetch([{
        method: 'GET',
        pattern: '/users/me/profile',
        handler: () => ({ status: 200, body: buildProfile() }),
      }])

      const gmail = createGmailClient({ oauth, fetch })
      const result = await gmail.profile()
      expect(result.emailAddress).toBe('user@example.com')
      expect(result.historyId).toBe('12345')
    })

    it('listLabels() calls /users/me/labels', async () => {
      const fetch = fakeFetch([{
        method: 'GET',
        pattern: '/users/me/labels',
        handler: () => ({ status: 200, body: buildLabelsResponse() }),
      }])

      const gmail = createGmailClient({ oauth, fetch })
      const result = await gmail.listLabels()
      expect(result.labels).toHaveLength(4)
    })

    it('listMessages() calls /users/me/messages with query', async () => {
      let capturedUrl
      const fetch = async (url) => {
        capturedUrl = url
        return { ok: true, status: 200, json: async () => buildMessageList({ messages: ['m1'] }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await gmail.listMessages('newer_than:7d')
      expect(capturedUrl).toContain('q=newer_than%3A7d')
    })

    it('getMessage() calls /users/me/messages/{id}?format=full', async () => {
      let capturedUrl
      const fetch = async (url) => {
        capturedUrl = url
        return { ok: true, status: 200, json: async () => buildGmailMessage({ id: 'msg_1' }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      const result = await gmail.getMessage('msg_1')
      expect(capturedUrl).toContain('/users/me/messages/msg_1')
      expect(capturedUrl).toContain('format=full')
      expect(result.id).toBe('msg_1')
    })

    it('history() calls /users/me/history with startHistoryId', async () => {
      let capturedUrl
      const fetch = async (url) => {
        capturedUrl = url
        return { ok: true, status: 200, json: async () => buildHistoryResponse() }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await gmail.history('12345')
      expect(capturedUrl).toContain('startHistoryId=12345')
    })

    it('modifyMessage() posts to /users/me/messages/{id}/modify', async () => {
      let capturedBody
      const fetch = async (url, options) => {
        capturedBody = JSON.parse(options.body)
        return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await gmail.modifyMessage('msg_1', ['INBOX'], ['UNREAD'])

      expect(capturedBody.addLabelIds).toEqual(['INBOX'])
      expect(capturedBody.removeLabelIds).toEqual(['UNREAD'])
    })

    it('send() posts to /users/me/messages/send', async () => {
      let capturedUrl, capturedBody
      const fetch = async (url, options) => {
        capturedUrl = url
        capturedBody = JSON.parse(options.body)
        return { ok: true, status: 200, json: async () => ({ id: 'sent_1', threadId: 't1' }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      const result = await gmail.send('base64rawdata', 'thread_1')

      expect(capturedUrl).toContain('/users/me/messages/send')
      expect(capturedBody.raw).toBe('base64rawdata')
      expect(capturedBody.threadId).toBe('thread_1')
      expect(result.id).toBe('sent_1')
    })

    it('send() omits threadId when not provided', async () => {
      let capturedBody
      const fetch = async (url, options) => {
        capturedBody = JSON.parse(options.body)
        return { ok: true, status: 200, json: async () => ({ id: 'sent_1' }) }
      }

      const gmail = createGmailClient({ oauth, fetch })
      await gmail.send('base64rawdata')

      expect(capturedBody.threadId).toBeUndefined()
    })
  })
})

describe('extractBody', () => {
  it('extracts text/plain body from simple message', () => {
    const msg = buildGmailMessage({ bodyText: 'Hello, world!' })
    expect(extractBody(msg.payload)).toBe('Hello, world!')
  })

  it('prefers text/plain over text/html in multipart', () => {
    const msg = buildMultipartMessage()
    expect(extractBody(msg.payload)).toBe('Plain text version')
  })

  it('falls back to html→text when no text/plain', () => {
    const msg = buildHtmlOnlyMessage({ bodyHtml: '<p>Hello</p><p>World</p>', bodyText: null })
    const body = extractBody(msg.payload)
    expect(body).toContain('Hello')
    expect(body).toContain('World')
    expect(body).not.toContain('<p>')
  })

  it('skips attachment parts', () => {
    const msg = buildAttachmentMessage({ bodyText: 'Message with attachments' })
    const body = extractBody(msg.payload)
    expect(body).toBe('Message with attachments')
    expect(body).not.toContain('report.pdf')
  })

  it('handles empty payload', () => {
    expect(extractBody(null)).toBe('')
    expect(extractBody({})).toBe('')
  })

  it('decodes base64url body data', () => {
    const text = 'Special chars: <>&"'
    const msg = buildGmailMessage({ bodyText: text })
    expect(extractBody(msg.payload)).toBe(text)
  })
})

describe('htmlToText', () => {
  it('strips HTML tags', () => {
    expect(htmlToText('<b>bold</b> and <i>italic</i>')).toBe('bold and italic')
  })

  it('decodes HTML entities', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39; &apos;')).toBe('& < > " \' \'')
  })

  it('converts block elements to newlines', () => {
    const html = '<p>First</p><p>Second</p>'
    const text = htmlToText(html)
    expect(text).toContain('First')
    expect(text).toContain('Second')
    // Should have newlines between paragraphs
    expect(text.includes('\n')).toBe(true)
  })

  it('converts <br> to newlines', () => {
    expect(htmlToText('Line 1<br>Line 2<br/>Line 3')).toBe('Line 1\nLine 2\nLine 3')
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('&#65;&#66;')).toBe('AB')
  })

  it('decodes hex entities', () => {
    expect(htmlToText('&#x41;&#x42;')).toBe('AB')
  })

  it('converts &nbsp; to space', () => {
    expect(htmlToText('hello&nbsp;world')).toBe('hello world')
  })

  it('collapses multiple newlines to max 2', () => {
    const html = '<p>A</p><p></p><p></p><p>B</p>'
    const text = htmlToText(html)
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('trims result', () => {
    expect(htmlToText('  <p>hello</p>  ')).toBe('hello')
  })

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('')
    expect(htmlToText(null)).toBe('')
  })
})

describe('extractAttachments', () => {
  it('extracts attachment metadata', () => {
    const msg = buildAttachmentMessage()
    const atts = extractAttachments(msg.payload)

    expect(atts).toHaveLength(2)
    expect(atts[0]).toEqual({
      gmail_attachment_id: 'att_1',
      filename: 'report.pdf',
      mime: 'application/pdf',
      size: 50000,
    })
    expect(atts[1]).toEqual({
      gmail_attachment_id: 'att_2',
      filename: 'image.png',
      mime: 'image/png',
      size: 25000,
    })
  })

  it('returns empty array for no attachments', () => {
    const msg = buildGmailMessage()
    const atts = extractAttachments(msg.payload)
    expect(atts).toEqual([])
  })
})

describe('parseMessage', () => {
  it('parses a full Gmail message into normalized format', () => {
    const msg = buildGmailMessage({
      id: 'msg_123',
      threadId: 'thread_456',
      from: 'Alice Test <alice@example.com>',
      to: 'Bob <bob@example.com>',
      cc: 'Carol <carol@example.com>',
      subject: 'Test Subject',
      bodyText: 'Hello!',
      internalDate: '1700000000000',
      labelIds: ['INBOX', 'UNREAD'],
      messageId: '<abc@example.com>',
      references: '<root@example.com> <parent@example.com>',
    })

    const parsed = parseMessage(msg)

    expect(parsed.gmail_id).toBe('msg_123')
    expect(parsed.thread_gmail_id).toBe('thread_456')
    expect(parsed.from_name).toBe('Alice Test')
    expect(parsed.from_email).toBe('alice@example.com')
    expect(parsed.subject).toBe('Test Subject')
    expect(parsed.body_text).toBe('Hello!')
    expect(parsed.internal_date).toBe(1700000000000)
    expect(parsed.is_unread).toBe(1)
    expect(parsed.rfc822_message_id).toBe('<abc@example.com>')
    expect(JSON.parse(parsed.references_json)).toEqual(['<root@example.com>', '<parent@example.com>'])
    expect(JSON.parse(parsed.label_ids_json)).toEqual(['INBOX', 'UNREAD'])
    expect(parsed.has_attachments).toBe(0)

    // To/Cc parsed as arrays
    const to = JSON.parse(parsed.to_json)
    expect(to[0].email).toBe('bob@example.com')
    const cc = JSON.parse(parsed.cc_json)
    expect(cc[0].email).toBe('carol@example.com')
  })

  it('handles message with no From header', () => {
    const msg = buildGmailMessage({ from: '' })
    const parsed = parseMessage(msg)
    expect(parsed.from_email).toBe('')
  })

  it('handles internalDate → integer conversion', () => {
    const msg = buildGmailMessage({ internalDate: '1609459200000' })
    const parsed = parseMessage(msg)
    expect(parsed.internal_date).toBe(1609459200000)
    expect(typeof parsed.internal_date).toBe('number')
  })

  it('marks message as read when UNREAD not in labels', () => {
    const msg = buildGmailMessage({ labelIds: ['INBOX'] })
    const parsed = parseMessage(msg)
    expect(parsed.is_unread).toBe(0)
  })

  it('sets is_from_me from the SENT system label', () => {
    // recentSentTo, voice seeding, and the Sent tab all key off is_from_me;
    // Gmail's SENT label is the authoritative signal at parse time.
    const sent = parseMessage(buildGmailMessage({ labelIds: ['SENT'] }))
    expect(sent.is_from_me).toBe(1)
    const received = parseMessage(buildGmailMessage({ labelIds: ['INBOX', 'UNREAD'] }))
    expect(received.is_from_me).toBe(0)
  })

  it('extracts attachment metadata alongside body', () => {
    const msg = buildAttachmentMessage({ bodyText: 'See attached' })
    const parsed = parseMessage(msg)
    expect(parsed.has_attachments).toBe(1)
    expect(parsed.attachments).toHaveLength(2)
    expect(parsed.body_text).toBe('See attached')
  })
})
