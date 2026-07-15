// mime.mjs — RFC 2822/2047 MIME builder for plain-text email
// Agent B owns this file. Pure functions, no I/O.

export function createMime() {
  return {
    buildMessage,
    encodeRaw,
  }
}

/**
 * Build an RFC 2822 message string.
 * @param {Object} opts
 * @param {string} opts.from - From address (display + email)
 * @param {string|string[]} opts.to - To address(es)
 * @param {string|string[]} [opts.cc] - Cc address(es)
 * @param {string|string[]} [opts.bcc] - Bcc address(es)
 * @param {string} opts.subject
 * @param {string} opts.bodyText - Plain text body
 * @param {string} [opts.inReplyTo] - Message-ID of the message being replied to
 * @param {string[]} [opts.references] - References header values from original
 * @param {Object} [opts.quote] - Quote to append at send time
 * @param {string} opts.quote.date - Date string for the quote header
 * @param {string} opts.quote.fromDisplay - Display name for the quote header
 * @param {string} opts.quote.bodyText - Body text to quote
 * @returns {string} RFC 2822 message string
 */
function buildMessage({ from, to, cc, bcc, subject, bodyText, inReplyTo, references, quote }) {
  const lines = []

  // From
  lines.push(`From: ${from}`)

  // To — may be string or array
  const toList = Array.isArray(to) ? to : [to]
  lines.push(`To: ${toList.join(', ')}`)

  // Cc
  if (cc) {
    const ccList = Array.isArray(cc) ? cc : [cc]
    if (ccList.length > 0) {
      lines.push(`Cc: ${ccList.join(', ')}`)
    }
  }

  // Bcc
  if (bcc) {
    const bccList = Array.isArray(bcc) ? bcc : [bcc]
    if (bccList.length > 0) {
      lines.push(`Bcc: ${bccList.join(', ')}`)
    }
  }

  // Subject — RFC 2047 encode if non-ASCII
  lines.push(`Subject: ${encodeSubject(subject)}`)

  // Date — RFC 2822
  lines.push(`Date: ${new Date().toUTCString()}`)

  // Reply threading
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)

    // References = original References + original Message-ID
    const refs = []
    if (references && references.length > 0) {
      refs.push(...references)
    }
    // Add the original Message-ID if not already in references
    if (!refs.includes(inReplyTo)) {
      refs.push(inReplyTo)
    }
    lines.push(`References: ${refs.join(' ')}`)
  }

  // Re: prefix — add once, case-insensitively
  // (handled by caller providing correct subject, but we enforce here too
  //  for the reply case)
  if (inReplyTo) {
    // Check the Subject line we already pushed and fix if needed
    const subIdx = lines.findIndex(l => l.startsWith('Subject: '))
    if (subIdx !== -1) {
      const currentSubject = lines[subIdx].slice('Subject: '.length)
      const decoded = decodeSubjectForCheck(currentSubject)
      if (!/^re:\s/i.test(decoded)) {
        lines[subIdx] = `Subject: ${encodeSubject('Re: ' + subject)}`
      }
    }
  }

  // MIME headers
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset=UTF-8')
  lines.push('Content-Transfer-Encoding: base64')

  // Empty line before body
  lines.push('')

  // Body: assemble with quote if present
  let fullBody = bodyText
  if (quote) {
    const quotedLines = quote.bodyText.split('\n').map(l => `> ${l}`)
    fullBody += `\n\nOn ${quote.date}, ${quote.fromDisplay} wrote:\n${quotedLines.join('\n')}`
  }

  // Base64 encode body with 76-char line wrapping
  const bodyBase64 = Buffer.from(fullBody, 'utf-8').toString('base64')
  const wrappedBody = wrapBase64(bodyBase64, 76)
  lines.push(wrappedBody)

  return lines.join('\r\n')
}

/**
 * RFC 2047 UTF-8 base64 encoded-word for Subject when non-ASCII.
 */
function encodeSubject(subject) {
  if (!subject) return ''
  // Check if all ASCII
  if (/^[\x00-\x7F]*$/.test(subject)) return subject
  // RFC 2047: =?charset?encoding?encoded-text?=
  const encoded = Buffer.from(subject, 'utf-8').toString('base64')
  return `=?UTF-8?B?${encoded}?=`
}

/**
 * Decode an RFC 2047 encoded subject for Re: prefix checking.
 */
function decodeSubjectForCheck(subject) {
  const match = subject.match(/^=\?UTF-8\?B\?(.+)\?=$/)
  if (match) {
    return Buffer.from(match[1], 'base64').toString('utf-8')
  }
  return subject
}

/**
 * Wrap a base64 string to lines of maxLen characters.
 */
function wrapBase64(str, maxLen) {
  const lines = []
  for (let i = 0; i < str.length; i += maxLen) {
    lines.push(str.slice(i, i + maxLen))
  }
  return lines.join('\r\n')
}

/**
 * Encode an RFC 2822 message string as base64url for Gmail API.
 */
function encodeRaw(rfc2822) {
  return Buffer.from(rfc2822, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
