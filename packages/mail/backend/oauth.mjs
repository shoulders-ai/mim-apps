// oauth.mjs — Google installed-app OAuth with PKCE S256
// Agent B owns this file.

import { randomBytes, createHash } from 'node:crypto'

const SCOPES = 'https://www.googleapis.com/auth/gmail.modify'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

const FLOW_TIMEOUT_MS = 120_000 // 120 seconds

export function createOAuth({ secrets, fetch: fetchFn = globalThis.fetch, createServer }) {
  let _pendingFlow = null
  let _tokens = null // cached token bundle

  // Load client config from secrets
  function _getClient() {
    const raw = secrets.get('google_oauth_client')
    if (!raw) throw new Error('No OAuth client configured — store client JSON via secrets')
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed.web) {
      throw new Error('Web OAuth client not supported — use a Desktop app (installed) client')
    }
    const client = parsed.installed
    if (!client) {
      throw new Error('Invalid client JSON — expected an "installed" key (Desktop app client)')
    }
    return client
  }

  // Load cached tokens from secrets
  function _loadTokens() {
    if (_tokens) return _tokens
    const raw = secrets.get('google_oauth_tokens')
    if (!raw) return null
    _tokens = typeof raw === 'string' ? JSON.parse(raw) : raw
    return _tokens
  }

  // Save tokens to secrets
  function _saveTokens(tokens) {
    _tokens = tokens
    secrets.set('google_oauth_tokens', JSON.stringify(tokens))
  }

  // Generate PKCE code verifier + challenge (S256)
  function _generatePKCE() {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  /**
   * Start the OAuth consent flow.
   * @returns {{ consentUrl: string, waitForToken: () => Promise<object> }}
   */
  function startFlow() {
    if (_pendingFlow) {
      throw new Error('An OAuth flow is already in progress')
    }

    const client = _getClient()
    const { verifier, challenge } = _generatePKCE()
    const state = randomBytes(16).toString('hex')

    let resolveToken, rejectToken
    const tokenPromise = new Promise((resolve, reject) => {
      resolveToken = resolve
      rejectToken = reject
    })

    // We'll set up the server and build the consent URL
    const serverModule = createServer || _defaultCreateServer()

    const server = serverModule((req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`)
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body>Authorization denied. You can close this tab.</body></html>')
          _cleanup()
          rejectToken(new Error(`OAuth error: ${error}`))
          return
        }

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body>State mismatch. You can close this tab.</body></html>')
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<html><body>No authorization code received.</body></html>')
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body>Authorization successful! You can close this tab.</body></html>')

        // Exchange code for tokens
        _exchangeCode(code, client, verifier, server.address().port)
          .then(tokenBundle => {
            _cleanup()
            resolveToken(tokenBundle)
          })
          .catch(err => {
            _cleanup()
            rejectToken(err)
          })
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal error')
        _cleanup()
        rejectToken(err)
      }
    })

    // Listen on random port, 127.0.0.1 only
    server.listen(0, '127.0.0.1')
    const port = server.address().port

    // Build consent URL
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: `http://127.0.0.1:${port}`,
      response_type: 'code',
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    })
    const consentUrl = `${AUTH_URL}?${params.toString()}`

    // Self-terminating timeout
    const timeout = setTimeout(() => {
      _cleanup()
      rejectToken(new Error('OAuth flow timed out after 120 seconds'))
    }, FLOW_TIMEOUT_MS)

    function _cleanup() {
      _pendingFlow = null
      clearTimeout(timeout)
      try { server.close() } catch {}
    }

    _pendingFlow = { server, timeout, cleanup: _cleanup }

    return {
      consentUrl,
      waitForToken: () => tokenPromise,
    }
  }

  // Exchange auth code for tokens
  async function _exchangeCode(code, client, verifier, port) {
    const body = new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: `http://127.0.0.1:${port}`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    })

    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${data.error_description || data.error || 'unknown'}`)
    }

    const tokenBundle = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope || SCOPES,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    }

    _saveTokens(tokenBundle)
    return tokenBundle
  }

  /**
   * Get a valid access token, refreshing if needed (60s buffer).
   * @returns {Promise<string>}
   */
  async function accessToken() {
    const tokens = _loadTokens()
    if (!tokens) throw new Error('No OAuth tokens — run the connect flow first')

    // Refresh if expired or within 60s of expiry
    if (Date.now() >= tokens.expires_at - 60_000) {
      return _refresh(tokens)
    }

    return tokens.access_token
  }

  /**
   * Force a token refresh regardless of expiry (for 401 retry).
   * @returns {Promise<string>}
   */
  async function refreshAccessToken() {
    const tokens = _loadTokens()
    if (!tokens) throw new Error('No OAuth tokens — run the connect flow first')
    return _refresh(tokens)
  }

  // Refresh the access token
  async function _refresh(tokens) {
    const client = _getClient()

    const body = new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    })

    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${data.error_description || data.error || 'unknown'}`)
    }

    // Preserve prior refresh_token/scope when response omits them
    const newBundle = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      scope: data.scope || tokens.scope,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    }

    _saveTokens(newBundle)
    return newBundle.access_token
  }

  /**
   * Connection status.
   */
  function status() {
    const tokens = _loadTokens()
    if (!tokens) return { connected: false }
    return {
      connected: true,
      token_ok: Date.now() < tokens.expires_at,
      scope: tokens.scope,
    }
  }

  return {
    startFlow,
    accessToken,
    refreshAccessToken,
    status,
  }
}

// Not used at runtime — createServer is always injected.
// Exists only as documentation of the expected shape.
function _defaultCreateServer() {
  throw new Error('createServer must be injected — node:http is not importable via require() in ESM')
}
