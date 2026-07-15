// gmail.mjs — Gmail REST client with auth, retry, and body extraction
// Agent B owns this file.

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1'

export function createGmailClient({ oauth, fetch: fetchFn = globalThis.fetch }) {

  /**
   * Core request wrapper — auth header, query building, JSON errors surfaced with status.
   * Retry per §5: 429 Retry-After ≤5s once; 403 rate backoff 1/2/4s; 401 → one refresh retry.
   */
  async function request(path, { method = 'GET', query, body, _retryState } = {}) {
    const state = _retryState || { retried429: false, retried403: 0, retried401: false }

    const token = await oauth.accessToken()
    let url = `${BASE_URL}${path}`

    if (query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v))
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
    if (body) options.body = JSON.stringify(body)

    const response = await fetchFn(url, options)

    if (response.ok) {
      return response.json()
    }

    const status = response.status
    const errorBody = await response.json().catch(() => ({}))
    const errorMsg = errorBody?.error?.message || errorBody?.error || `HTTP ${status}`

    // 429 — retry once honoring Retry-After ≤ 5s
    if (status === 429 && !state.retried429) {
      const retryAfter = parseFloat(response.headers.get('retry-after') || '1')
      if (retryAfter <= 5) {
        await sleep(retryAfter * 1000)
        return request(path, { method, query, body, _retryState: { ...state, retried429: true } })
      }
    }

    // 403 — rate-limit errors only: backoff 1s, 2s, 4s
    if (status === 403 && state.retried403 < 3) {
      const reason = errorBody?.error?.errors?.[0]?.reason || ''
      const isRateLimit = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
        || errorMsg.toLowerCase().includes('rate limit')
      if (isRateLimit) {
        const backoffMs = [1000, 2000, 4000][state.retried403]
        await sleep(backoffMs)
        return request(path, { method, query, body, _retryState: { ...state, retried403: state.retried403 + 1 } })
      }
    }

    // 401 — one forced token refresh attempt
    if (status === 401 && !state.retried401) {
      try {
        if (oauth.refreshAccessToken) {
          await oauth.refreshAccessToken()
        } else {
          await oauth.accessToken()
        }
      } catch { /* ignore refresh failure, will fail below */ }
      return request(path, { method, query, body, _retryState: { ...state, retried401: true } })
    }

    const error = new Error(`Gmail API error: ${errorMsg}`)
    error.status = status
    throw error
  }

  // --- Typed helpers ---

  /** GET users/me/profile */
  async function profile() {
    return request('/users/me/profile')
  }

  /** GET users/me/labels */
  async function listLabels() {
    return request('/users/me/labels')
  }

  /** GET users/me/messages with query and pagination */
  async function listMessages(q, pageToken) {
    const query = { maxResults: '100' }
    if (q) query.q = q
    if (pageToken) query.pageToken = pageToken
    return request('/users/me/messages', { query })
  }

  /** GET users/me/messages/{id}?format=full */
  async function getMessage(id) {
    return request(`/users/me/messages/${id}`, { query: { format: 'full' } })
  }

  /** GET users/me/history */
  async function history(startHistoryId, pageToken) {
    const query = { startHistoryId }
    if (pageToken) query.pageToken = pageToken
    return request('/users/me/history', { query })
  }

  /** POST users/me/messages/{id}/modify */
  async function modifyMessage(id, addLabelIds, removeLabelIds) {
    return request(`/users/me/messages/${id}/modify`, {
      method: 'POST',
      body: {
        addLabelIds: addLabelIds || [],
        removeLabelIds: removeLabelIds || [],
      },
    })
  }

  /** POST users/me/messages/send */
  async function send(raw, threadId) {
    const body = { raw }
    if (threadId) body.threadId = threadId
    return request('/users/me/messages/send', {
      method: 'POST',
      body,
    })
  }

  return {
    request,
    profile,
    listLabels,
    listMessages,
    getMessage,
    history,
    modifyMessage,
    send,
    // Utility exports for sync/index to use
    extractBody,
    extractAttachments,
    parseMessage,
  }
}

// --- Body extraction helpers (pure, tested) ---

/**
 * Extract text body from a Gmail message payload.
 * Prefer text/plain part, fallback html→text.
 * Skip attachment parts (filename non-empty).
 */
export function extractBody(payload) {
  if (!payload) return ''

  // Single-part message
  if (payload.body?.data && !payload.parts) {
    if (payload.mimeType === 'text/plain') {
      return decodeBase64url(payload.body.data)
    }
    if (payload.mimeType === 'text/html') {
      return htmlToText(decodeBase64url(payload.body.data))
    }
    return ''
  }

  // Multipart message — walk parts
  if (payload.parts) {
    return extractBodyFromParts(payload.parts)
  }

  return ''
}

function extractBodyFromParts(parts) {
  let textContent = ''
  let htmlContent = ''

  for (const part of parts) {
    // Skip attachment parts
    if (part.filename) continue

    // Recurse into nested multipart
    if (part.parts) {
      const nested = extractBodyFromParts(part.parts)
      if (nested) return nested
    }

    if (part.mimeType === 'text/plain' && part.body?.data) {
      textContent = decodeBase64url(part.body.data)
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      htmlContent = decodeBase64url(part.body.data)
    }
  }

  // Prefer text/plain
  if (textContent) return textContent
  if (htmlContent) return htmlToText(htmlContent)
  return ''
}

/**
 * Extract attachment metadata from a Gmail message payload.
 */
export function extractAttachments(payload) {
  const attachments = []
  if (!payload?.parts) return attachments

  for (const part of payload.parts) {
    if (part.filename) {
      attachments.push({
        gmail_attachment_id: part.body?.attachmentId || null,
        filename: part.filename,
        mime: part.mimeType || 'application/octet-stream',
        size: part.body?.size || 0,
      })
    }
    // Recurse into nested parts
    if (part.parts) {
      attachments.push(...extractAttachments(part))
    }
  }

  return attachments
}

/**
 * Parse a full Gmail message response into a normalized object
 * suitable for store upsert.
 */
export function parseMessage(msg) {
  const headers = msg.payload?.headers || []
  const getHeader = (name) => {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase())
    return h?.value || ''
  }

  const from = getHeader('From')
  const fromParsed = parseEmailAddress(from)

  const bodyText = extractBody(msg.payload)
  const attachments = extractAttachments(msg.payload)

  return {
    gmail_id: msg.id,
    thread_gmail_id: msg.threadId,
    from_name: fromParsed.name,
    from_email: fromParsed.email,
    to_json: JSON.stringify(parseAddressList(getHeader('To'))),
    cc_json: JSON.stringify(parseAddressList(getHeader('Cc'))),
    bcc_json: JSON.stringify(parseAddressList(getHeader('Bcc'))),
    reply_to: getHeader('Reply-To') || null,
    subject: getHeader('Subject'),
    snippet: msg.snippet || '',
    body_text: bodyText,
    internal_date: parseInt(msg.internalDate, 10) || 0,
    is_unread: (msg.labelIds || []).includes('UNREAD') ? 1 : 0,
    // Gmail marks every message the account sent with the SENT system label —
    // the mirror's is_from_me flag drives recentSentTo exemplars, voice
    // seeding, and the Sent tab, so it must be set at parse time.
    is_from_me: (msg.labelIds || []).includes('SENT') ? 1 : 0,
    label_ids_json: JSON.stringify(msg.labelIds || []),
    has_attachments: attachments.length > 0 ? 1 : 0,
    rfc822_message_id: getHeader('Message-ID') || null,
    references_json: JSON.stringify(parseReferences(getHeader('References'))),
    attachments,
  }
}

// --- Pure helper: HTML → text ---

/**
 * Convert HTML to plain text: strip tags, decode entities,
 * block elements to newlines.
 */
export function htmlToText(html) {
  if (!html) return ''

  let text = html

  // Block elements → newlines (before stripping tags)
  text = text.replace(/<\/(p|div|br|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, '\n')

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

  // Collapse multiple newlines to max 2
  text = text.replace(/\n{3,}/g, '\n\n')

  // Trim leading/trailing whitespace
  text = text.trim()

  return text
}

// --- Utility helpers ---

function decodeBase64url(data) {
  if (!data) return ''
  // base64url → base64
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf-8')
}

function parseEmailAddress(raw) {
  if (!raw) return { name: '', email: '' }
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/)
  if (match) {
    return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2] }
  }
  return { name: '', email: raw.trim() }
}

function parseAddressList(raw) {
  if (!raw) return []
  return raw.split(',').map(addr => {
    const parsed = parseEmailAddress(addr.trim())
    return parsed
  }).filter(a => a.email)
}

function parseReferences(raw) {
  if (!raw) return []
  return raw.match(/<[^>]+>/g) || []
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
