// testUtils.mjs — shared test helpers for the mail backend
// Agent B owns this file. Reusable by Wave 2 integration tests.

/**
 * fakeFetch(routes) — returns a fetch-like function that matches
 * method + path patterns against the routes map.
 *
 * routes is an array of { method, pattern, handler } where:
 *   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'
 *   - pattern: string or RegExp matched against the URL pathname + search
 *   - handler: (url, options) => { status, body, headers? }
 *              or { status, body, headers? } directly
 *
 * Returns a function with the same signature as global fetch.
 */
export function fakeFetch(routes = []) {
  return async function fetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase()
    const urlStr = typeof url === 'string' ? url : url.toString()

    for (const route of routes) {
      const routeMethod = (route.method || 'GET').toUpperCase()
      if (routeMethod !== '*' && routeMethod !== method) continue

      let matched = false
      if (typeof route.pattern === 'string') {
        matched = urlStr.includes(route.pattern)
      } else if (route.pattern instanceof RegExp) {
        matched = route.pattern.test(urlStr)
      }

      if (matched) {
        const result = typeof route.handler === 'function'
          ? await route.handler(urlStr, options)
          : route.handler
        const status = result.status || 200
        const headers = new Map(Object.entries(result.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (k) => headers.get(k.toLowerCase()) || null },
          json: async () => result.body,
          text: async () => typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
        }
      }
    }

    // No matching route → 404
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({ error: { code: 404, message: `No route for ${method} ${urlStr}` } }),
      text: async () => `No route for ${method} ${urlStr}`,
    }
  }
}

/**
 * Fixture builders for Gmail API message payloads.
 */

/** Build a minimal Gmail message payload (format=full). */
export function buildGmailMessage({
  id = 'msg_1',
  threadId = 'thread_1',
  labelIds = ['INBOX'],
  internalDate = '1700000000000',
  subject = 'Test Subject',
  from = 'Alice <alice@example.com>',
  to = 'Bob <bob@example.com>',
  cc,
  bcc,
  replyTo,
  bodyText = 'Hello, world!',
  bodyHtml,
  attachments = [],
  messageId = '<msg1@example.com>',
  references,
  snippet = '',
} = {}) {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: to },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: messageId },
  ]
  if (cc) headers.push({ name: 'Cc', value: cc })
  if (bcc) headers.push({ name: 'Bcc', value: bcc })
  if (replyTo) headers.push({ name: 'Reply-To', value: replyTo })
  if (references) headers.push({ name: 'References', value: references })

  const parts = []

  if (bodyText && bodyHtml) {
    // Multipart alternative
    parts.push({
      mimeType: 'text/plain',
      body: { data: base64url(bodyText), size: bodyText.length },
    })
    parts.push({
      mimeType: 'text/html',
      body: { data: base64url(bodyHtml), size: bodyHtml.length },
    })
  } else if (bodyHtml) {
    parts.push({
      mimeType: 'text/html',
      body: { data: base64url(bodyHtml), size: bodyHtml.length },
    })
  } else if (bodyText) {
    parts.push({
      mimeType: 'text/plain',
      body: { data: base64url(bodyText), size: bodyText.length },
    })
  }

  for (const att of attachments) {
    parts.push({
      filename: att.filename || 'file.bin',
      mimeType: att.mimeType || 'application/octet-stream',
      body: {
        attachmentId: att.attachmentId || `att_${Math.random().toString(36).slice(2)}`,
        size: att.size || 1024,
      },
    })
  }

  const payload = {
    headers,
    mimeType: parts.length > 1 ? 'multipart/alternative' : (parts[0]?.mimeType || 'text/plain'),
  }

  if (parts.length > 1 || attachments.length > 0) {
    payload.parts = parts
  } else if (parts.length === 1) {
    payload.body = parts[0].body
  } else {
    payload.body = { data: '', size: 0 }
  }

  return {
    id,
    threadId,
    labelIds,
    snippet,
    internalDate,
    payload,
  }
}

/** Build a multipart message with both text and html. */
export function buildMultipartMessage(overrides = {}) {
  return buildGmailMessage({
    bodyText: 'Plain text version',
    bodyHtml: '<p>HTML version</p>',
    ...overrides,
  })
}

/** Build an HTML-only message (no text/plain part). */
export function buildHtmlOnlyMessage(overrides = {}) {
  return buildGmailMessage({
    bodyText: null,
    bodyHtml: '<p>Only HTML here</p>',
    ...overrides,
  })
}

/** Build a message with attachments. */
export function buildAttachmentMessage(overrides = {}) {
  return buildGmailMessage({
    attachments: [
      { filename: 'report.pdf', mimeType: 'application/pdf', size: 50000, attachmentId: 'att_1' },
      { filename: 'image.png', mimeType: 'image/png', size: 25000, attachmentId: 'att_2' },
    ],
    ...overrides,
  })
}

/** Build a profile response. */
export function buildProfile({ emailAddress = 'user@example.com', historyId = '12345' } = {}) {
  return { emailAddress, messagesTotal: 1000, threadsTotal: 500, historyId }
}

/** Build a labels response. */
export function buildLabelsResponse(labels) {
  return {
    labels: labels || [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'SENT', name: 'SENT', type: 'system' },
      { id: 'TRASH', name: 'TRASH', type: 'system' },
      { id: 'Label_1', name: 'Work', type: 'user' },
    ],
  }
}

/** Build a messages.list response. */
export function buildMessageList({ messages = [], nextPageToken, resultSizeEstimate = 100 } = {}) {
  return {
    messages: messages.map(m => typeof m === 'string' ? { id: m, threadId: `thread_${m}` } : m),
    nextPageToken,
    resultSizeEstimate,
  }
}

/** Build a history.list response. */
export function buildHistoryResponse({
  history = [],
  historyId = '99999',
  nextPageToken,
} = {}) {
  return { history, historyId, nextPageToken }
}

/** base64url encode a string. */
export function base64url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Create a minimal in-memory secrets store for testing. */
export function fakeSecrets(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    delete: (key) => { store.delete(key) },
    _store: store,
  }
}
