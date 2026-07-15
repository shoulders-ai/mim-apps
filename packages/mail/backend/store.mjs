import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL,
  history_id TEXT, pending_history_id TEXT,
  backfill_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (backfill_state IN ('pending','running','done','error')),
  backfill_cursor TEXT, backfill_total INTEGER, backfill_done INTEGER,
  sync_window_days INTEGER NOT NULL DEFAULT 180,
  last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_id TEXT NOT NULL,
  name TEXT NOT NULL, type TEXT NOT NULL, UNIQUE(account_id, gmail_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_id TEXT NOT NULL,
  subject TEXT, snippet TEXT, last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  is_unread INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_recent ON threads(account_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  from_name TEXT, from_email TEXT, to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT, subject TEXT, snippet TEXT, body_text TEXT,
  internal_date INTEGER, is_unread INTEGER NOT NULL DEFAULT 0,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  rfc822_message_id TEXT, references_json TEXT NOT NULL DEFAULT '[]',
  label_ids_json TEXT NOT NULL DEFAULT '[]',
  has_attachments INTEGER NOT NULL DEFAULT 0, fetched_at TEXT,
  UNIQUE(account_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  gmail_attachment_id TEXT, filename TEXT, mime TEXT, size INTEGER
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  thread_id TEXT REFERENCES threads(id), reply_to_message_id TEXT,
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]', subject TEXT,
  voice_id TEXT,
  state TEXT NOT NULL DEFAULT 'composing' CHECK (state IN
    ('composing','approved','sent','send_failed','discarded')),
  current_revision_id TEXT,
  approved_revision_id TEXT, approved_at TEXT,
  last_send_error TEXT, gmail_sent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
  seq INTEGER NOT NULL, body_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN
    ('ai_initial','human_edit','proposal_accept','revert')),
  proposal_id TEXT, hunk_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(draft_id, seq)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('draft','voice')),
  target_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  intent_text TEXT NOT NULL, scope_json TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user_request','chat_agent','flywheel')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','resolved','superseded','invalidated','dismissed')),
  model_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS hunks (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id),
  seq INTEGER NOT NULL, original_text TEXT NOT NULL, proposed_text TEXT NOT NULL,
  note TEXT, paragraph_index INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','accepted','rejected','stale','dropped')),
  drop_reason TEXT, comment TEXT, resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  body_md TEXT NOT NULL, current_revision_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_revisions (
  id TEXT PRIMARY KEY, voice_id TEXT NOT NULL REFERENCES voices(id),
  seq INTEGER NOT NULL, body_md TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seed','human_edit','proposal_accept')),
  proposal_id TEXT, created_at TEXT NOT NULL, UNIQUE(voice_id, seq)
);

CREATE TABLE IF NOT EXISTS provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id TEXT,
  ts TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_provenance_draft ON provenance(draft_id, id);

CREATE TABLE IF NOT EXISTS sends (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id),
  gmail_message_id TEXT, sent_at TEXT NOT NULL,
  final_text TEXT NOT NULL, first_ai_text TEXT,
  survival_rate REAL, untouched INTEGER NOT NULL DEFAULT 0,
  voice_id TEXT, distilled INTEGER NOT NULL DEFAULT 0
);
`

// FTS table must be created outside IF NOT EXISTS for virtual tables
// We handle it separately in migration
const FTS_SQL = `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED, subject, from_text, body);
`

/**
 * createStore({ dbPath }) — Agent A's storage layer.
 * Opens lazily on first call; WAL journal mode; stays open until close().
 */
export function createStore({ dbPath }) {
  let db = null

  function ensureOpen() {
    if (db) return db
    mkdirSync(dirname(dbPath), { recursive: true })
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('PRAGMA foreign_keys=ON')
    migrate()
    return db
  }

  function migrate() {
    db.exec(SCHEMA_SQL)
    // Check if FTS table exists
    const ftsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
    ).get()
    if (!ftsExists) {
      db.exec(FTS_SQL)
    }

    // Set schema_version in meta
    const existing = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
    if (!existing) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
    }
  }

  // --- Accounts ---

  function upsertAccount({ id, email, created_at }) {
    const d = ensureOpen()
    // created_at defaults so update-only callers (e.g. sync.mjs storing the
    // profile email) need not thread it through; node:sqlite refuses to bind
    // undefined even when the ON CONFLICT branch would ignore the column.
    d.prepare(`
      INSERT INTO accounts (id, email, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email
    `).run(id, email, created_at ?? new Date().toISOString())
  }

  function getAccount(id) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null
  }

  function updateAccount(id, patch) {
    const d = ensureOpen()
    const allowed = [
      'email', 'history_id', 'pending_history_id', 'backfill_state',
      'backfill_cursor', 'backfill_total', 'backfill_done',
      'sync_window_days', 'last_sync_at', 'last_error',
    ]
    const sets = []
    const vals = []
    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`)
        vals.push(patch[key])
      }
    }
    if (sets.length === 0) return
    vals.push(id)
    d.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  // --- Labels ---

  function upsertLabels(accountId, rows) {
    const d = ensureOpen()
    // Row ids are generated here when absent (sync.mjs passes only
    // gmail_id/name/type), and an existing row keeps its id on update —
    // rewriting the primary key on every sync would churn references.
    const stmt = d.prepare(`
      INSERT INTO labels (id, account_id, gmail_id, name, type)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, gmail_id) DO UPDATE SET
        name = excluded.name, type = excluded.type
    `)
    for (const row of rows) {
      stmt.run(row.id ?? randomUUID(), accountId, row.gmail_id, row.name, row.type)
    }
  }

  function listLabels(accountId) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM labels WHERE account_id = ?').all(accountId)
  }

  // --- Threads (internal, maintained via upsertMessage) ---

  function _ensureThread(d, accountId, gmailThreadId) {
    let thread = d.prepare(
      'SELECT id FROM threads WHERE account_id = ? AND gmail_id = ?'
    ).get(accountId, gmailThreadId)
    if (!thread) {
      const id = randomUUID()
      d.prepare(
        'INSERT INTO threads (id, account_id, gmail_id) VALUES (?, ?, ?)'
      ).run(id, accountId, gmailThreadId)
      return id
    }
    return thread.id
  }

  function _refreshThreadRollup(d, threadId) {
    const stats = d.prepare(`
      SELECT
        COUNT(*) as message_count,
        MAX(internal_date) as last_message_at,
        MAX(is_unread) as is_unread
      FROM messages WHERE thread_id = ?
    `).get(threadId)

    // Get subject/snippet from the most recent message
    const latest = d.prepare(`
      SELECT subject, snippet FROM messages
      WHERE thread_id = ? ORDER BY internal_date DESC LIMIT 1
    `).get(threadId)

    d.prepare(`
      UPDATE threads SET
        message_count = ?,
        last_message_at = ?,
        is_unread = ?,
        subject = ?,
        snippet = ?
      WHERE id = ?
    `).run(
      stats?.message_count ?? 0,
      stats?.last_message_at ?? null,
      stats?.is_unread ?? 0,
      latest?.subject ?? null,
      latest?.snippet ?? null,
      threadId,
    )
  }

  // --- Messages ---

  function upsertMessage(accountId, msg) {
    const d = ensureOpen()
    const threadId = _ensureThread(d, accountId, msg.thread_gmail_id)

    // Check if message exists
    const existing = d.prepare(
      'SELECT id FROM messages WHERE account_id = ? AND gmail_id = ?'
    ).get(accountId, msg.gmail_id)

    if (existing) {
      // Update existing message — delete old FTS entry first
      d.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(existing.id)
      d.prepare(`
        UPDATE messages SET
          thread_id = ?, from_name = ?, from_email = ?,
          to_json = ?, cc_json = ?, bcc_json = ?,
          reply_to = ?, subject = ?, snippet = ?, body_text = ?,
          internal_date = ?, is_unread = ?, is_from_me = ?,
          rfc822_message_id = ?, references_json = ?,
          label_ids_json = ?, has_attachments = ?, fetched_at = ?
        WHERE id = ?
      `).run(
        threadId, msg.from_name ?? null, msg.from_email ?? null,
        msg.to_json ?? '[]', msg.cc_json ?? '[]', msg.bcc_json ?? '[]',
        msg.reply_to ?? null, msg.subject ?? null, msg.snippet ?? null,
        msg.body_text ?? null,
        msg.internal_date ?? null, msg.is_unread ?? 0, msg.is_from_me ?? 0,
        msg.rfc822_message_id ?? null, msg.references_json ?? '[]',
        msg.label_ids_json ?? '[]', msg.has_attachments ?? 0,
        msg.fetched_at ?? null,
        existing.id,
      )
      // Re-insert FTS
      d.prepare(
        'INSERT INTO messages_fts (message_id, subject, from_text, body) VALUES (?, ?, ?, ?)'
      ).run(
        existing.id,
        msg.subject ?? '',
        [msg.from_name, msg.from_email].filter(Boolean).join(' '),
        msg.body_text ?? '',
      )
    } else {
      // Insert new message
      const id = randomUUID()
      d.prepare(`
        INSERT INTO messages (
          id, account_id, gmail_id, thread_id,
          from_name, from_email, to_json, cc_json, bcc_json,
          reply_to, subject, snippet, body_text,
          internal_date, is_unread, is_from_me,
          rfc822_message_id, references_json,
          label_ids_json, has_attachments, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, accountId, msg.gmail_id, threadId,
        msg.from_name ?? null, msg.from_email ?? null,
        msg.to_json ?? '[]', msg.cc_json ?? '[]', msg.bcc_json ?? '[]',
        msg.reply_to ?? null, msg.subject ?? null, msg.snippet ?? null,
        msg.body_text ?? null,
        msg.internal_date ?? null, msg.is_unread ?? 0, msg.is_from_me ?? 0,
        msg.rfc822_message_id ?? null, msg.references_json ?? '[]',
        msg.label_ids_json ?? '[]', msg.has_attachments ?? 0,
        msg.fetched_at ?? null,
      )
      // Insert FTS
      d.prepare(
        'INSERT INTO messages_fts (message_id, subject, from_text, body) VALUES (?, ?, ?, ?)'
      ).run(
        id,
        msg.subject ?? '',
        [msg.from_name, msg.from_email].filter(Boolean).join(' '),
        msg.body_text ?? '',
      )
    }

    _refreshThreadRollup(d, threadId)
  }

  function deleteMessageByGmailId(accountId, gmailId) {
    const d = ensureOpen()
    const msg = d.prepare(
      'SELECT id, thread_id FROM messages WHERE account_id = ? AND gmail_id = ?'
    ).get(accountId, gmailId)
    if (!msg) return

    d.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(msg.id)
    d.prepare('DELETE FROM attachments WHERE message_id = ?').run(msg.id)
    d.prepare('DELETE FROM messages WHERE id = ?').run(msg.id)
    _refreshThreadRollup(d, msg.thread_id)
  }

  function applyLabelChange(accountId, gmailId, addIds, removeIds) {
    const d = ensureOpen()
    const msg = d.prepare(
      'SELECT id, thread_id, label_ids_json, is_unread FROM messages WHERE account_id = ? AND gmail_id = ?'
    ).get(accountId, gmailId)
    if (!msg) return

    let labels = JSON.parse(msg.label_ids_json || '[]')
    for (const id of removeIds || []) {
      labels = labels.filter(l => l !== id)
    }
    for (const id of addIds || []) {
      if (!labels.includes(id)) labels.push(id)
    }

    const isUnread = labels.includes('UNREAD') ? 1 : 0
    d.prepare(
      'UPDATE messages SET label_ids_json = ?, is_unread = ? WHERE id = ?'
    ).run(JSON.stringify(labels), isUnread, msg.id)

    _refreshThreadRollup(d, msg.thread_id)
  }

  // --- Search ---

  function searchThreads({ accountId, tab, query, limit = 50, offset = 0 }) {
    const d = ensureOpen()

    if (query) {
      // FTS search
      const ftsTerms = String(query).toLowerCase().match(/[a-z0-9À-ɏ]+/g) || []
      const match = ftsTerms.map(t => `${t}*`).join(' ')
      if (!match) return []

      // FTS returns message_ids; join to threads
      let sql = `
        SELECT DISTINCT t.*
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.message_id
        JOIN threads t ON t.id = m.thread_id
        WHERE fts.messages_fts MATCH ?
          AND m.account_id = ?
      `
      const params = [match, accountId]

      if (tab === 'inbox') {
        sql += ` AND m.label_ids_json LIKE '%"INBOX"%'`
      } else if (tab === 'sent') {
        sql += ` AND m.label_ids_json LIKE '%"SENT"%'`
      }

      sql += ` ORDER BY t.last_message_at DESC LIMIT ? OFFSET ?`
      params.push(limit, offset)
      return d.prepare(sql).all(...params)
    }

    // Non-FTS: tab-filtered thread listing
    if (tab === 'inbox' || tab === 'sent') {
      const labelFilter = tab === 'inbox' ? 'INBOX' : 'SENT'
      return d.prepare(`
        SELECT DISTINCT t.*
        FROM threads t
        JOIN messages m ON m.thread_id = t.id
        WHERE t.account_id = ?
          AND m.label_ids_json LIKE ?
        ORDER BY t.last_message_at DESC
        LIMIT ? OFFSET ?
      `).all(accountId, `%"${labelFilter}"%`, limit, offset)
    }

    // Default: all threads for account
    return d.prepare(`
      SELECT * FROM threads
      WHERE account_id = ?
      ORDER BY last_message_at DESC
      LIMIT ? OFFSET ?
    `).all(accountId, limit, offset)
  }

  function getThread(threadId) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) || null
  }

  function getThreadMessages(threadId) {
    const d = ensureOpen()
    return d.prepare(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY internal_date ASC'
    ).all(threadId)
  }

  function getMessage(id) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null
  }

  // --- recentSentTo ---

  function recentSentTo({ accountId, email, domain, limit = 3 }) {
    const d = ensureOpen()

    // Try exact email match first
    // to_json contains arrays like [{"email":"bob@acme.com","name":"Bob"}]
    // We search for the email string within the JSON
    const exactResults = d.prepare(`
      SELECT * FROM messages
      WHERE account_id = ? AND is_from_me = 1
        AND to_json LIKE ?
      ORDER BY internal_date DESC
      LIMIT ?
    `).all(accountId, `%"${email}"%`, limit)

    if (exactResults.length > 0) return exactResults

    // Fall back to domain match
    const domainToSearch = domain || (email ? email.split('@')[1] : null)
    if (!domainToSearch) return []

    return d.prepare(`
      SELECT * FROM messages
      WHERE account_id = ? AND is_from_me = 1
        AND to_json LIKE ?
      ORDER BY internal_date DESC
      LIMIT ?
    `).all(accountId, `%@${domainToSearch}%`, limit)
  }

  // --- Drafts ---

  function createDraft(fields) {
    const d = ensureOpen()
    const id = randomUUID()
    const now = new Date().toISOString()
    d.prepare(`
      INSERT INTO drafts (
        id, account_id, thread_id, reply_to_message_id,
        to_json, cc_json, bcc_json, subject, voice_id,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'composing', ?, ?)
    `).run(
      id,
      fields.account_id ?? '',
      fields.thread_id ?? null,
      fields.reply_to_message_id ?? null,
      fields.to_json ?? '[]',
      fields.cc_json ?? '[]',
      fields.bcc_json ?? '[]',
      fields.subject ?? null,
      fields.voice_id ?? null,
      now, now,
    )
    return getDraft(id)
  }

  function getDraft(id) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM drafts WHERE id = ?').get(id) || null
  }

  function updateDraft(id, patch) {
    const d = ensureOpen()
    const allowed = [
      'thread_id', 'reply_to_message_id', 'to_json', 'cc_json', 'bcc_json',
      'subject', 'voice_id', 'state', 'current_revision_id',
      'approved_revision_id', 'approved_at', 'last_send_error', 'gmail_sent_id',
    ]
    const sets = ['updated_at = ?']
    const vals = [new Date().toISOString()]
    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`)
        vals.push(patch[key])
      }
    }
    vals.push(id)
    d.prepare(`UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  function listDrafts({ state } = {}) {
    const d = ensureOpen()
    if (state) {
      return d.prepare('SELECT * FROM drafts WHERE state = ? ORDER BY updated_at DESC').all(state)
    }
    return d.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all()
  }

  // --- Revisions ---

  function appendRevision({ draftId, body, source, proposalId, hunkId }) {
    const d = ensureOpen()
    const id = randomUUID()
    const now = new Date().toISOString()

    // Get next seq
    const maxSeq = d.prepare(
      'SELECT MAX(seq) as max_seq FROM revisions WHERE draft_id = ?'
    ).get(draftId)
    const seq = (maxSeq?.max_seq ?? 0) + 1

    d.prepare(`
      INSERT INTO revisions (id, draft_id, seq, body_text, source, proposal_id, hunk_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, draftId, seq, body, source, proposalId ?? null, hunkId ?? null, now)

    // Bump current_revision_id
    d.prepare('UPDATE drafts SET current_revision_id = ?, updated_at = ? WHERE id = ?').run(id, now, draftId)

    // Handle approved → composing + approval_revoked
    const draft = d.prepare('SELECT state FROM drafts WHERE id = ?').get(draftId)
    if (draft && draft.state === 'approved') {
      d.prepare(
        "UPDATE drafts SET state = 'composing', updated_at = ? WHERE id = ?"
      ).run(now, draftId)
      d.prepare(`
        INSERT INTO provenance (draft_id, ts, kind, payload_json)
        VALUES (?, ?, 'approval_revoked', '{}')
      `).run(draftId, now)
    }

    return { id, seq, draftId, body_text: body, source, created_at: now }
  }

  function getRevision(id) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM revisions WHERE id = ?').get(id) || null
  }

  function listRevisions(draftId) {
    const d = ensureOpen()
    return d.prepare(
      'SELECT * FROM revisions WHERE draft_id = ? ORDER BY seq ASC'
    ).all(draftId)
  }

  // --- Proposals & Hunks ---

  function createProposal({ target_kind, target_id, base_revision_id, intent_text, scope_json, origin, model_id, hunks = [] }) {
    const d = ensureOpen()
    const id = randomUUID()
    const now = new Date().toISOString()

    d.prepare(`
      INSERT INTO proposals (
        id, target_kind, target_id, base_revision_id,
        intent_text, scope_json, origin, model_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, target_kind, target_id, base_revision_id,
      intent_text, scope_json ?? null, origin,
      model_id ?? null, now,
    )

    for (const hunk of hunks) {
      const hunkId = randomUUID()
      d.prepare(`
        INSERT INTO hunks (
          id, proposal_id, seq, original_text, proposed_text,
          note, paragraph_index, status, drop_reason, comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hunkId, id, hunk.seq ?? 0,
        hunk.original_text ?? '', hunk.proposed_text ?? '',
        hunk.note ?? null, hunk.paragraph_index ?? null,
        hunk.status ?? 'pending', hunk.drop_reason ?? null,
        hunk.comment ?? null,
      )
    }

    return { id, target_kind, target_id, status: 'pending', created_at: now }
  }

  function getProposal(id, { withHunks = false } = {}) {
    const d = ensureOpen()
    const proposal = d.prepare('SELECT * FROM proposals WHERE id = ?').get(id)
    if (!proposal) return null
    if (withHunks) {
      proposal.hunks = d.prepare(
        'SELECT * FROM hunks WHERE proposal_id = ? ORDER BY seq ASC'
      ).all(id)
    }
    return proposal
  }

  function pendingProposal(targetKind, targetId) {
    const d = ensureOpen()
    return d.prepare(`
      SELECT * FROM proposals
      WHERE target_kind = ? AND target_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(targetKind, targetId) || null
  }

  function listProposals({ targetKind, targetId }) {
    const d = ensureOpen()
    return d.prepare(`
      SELECT * FROM proposals
      WHERE target_kind = ? AND target_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(targetKind, targetId)
  }

  function getHunk(id) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM hunks WHERE id = ?').get(id) || null
  }

  function updateHunk(id, patch) {
    const d = ensureOpen()
    const allowed = ['status', 'drop_reason', 'comment', 'resolved_at', 'paragraph_index']
    const sets = []
    const vals = []
    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`)
        vals.push(patch[key])
      }
    }
    if (sets.length === 0) return
    vals.push(id)
    d.prepare(`UPDATE hunks SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  function updateProposal(id, patch) {
    const d = ensureOpen()
    const allowed = ['status', 'resolved_at']
    const sets = []
    const vals = []
    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`)
        vals.push(patch[key])
      }
    }
    if (sets.length === 0) return
    vals.push(id)
    d.prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  // --- Voices ---

  function createVoice({ name, description, body_md }) {
    const d = ensureOpen()
    const id = randomUUID()
    const now = new Date().toISOString()

    // Create the voice
    d.prepare(`
      INSERT INTO voices (id, name, description, body_md, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description ?? null, body_md, now, now)

    // Create seed revision
    const vrId = randomUUID()
    d.prepare(`
      INSERT INTO voice_revisions (id, voice_id, seq, body_md, source, created_at)
      VALUES (?, ?, 1, ?, 'seed', ?)
    `).run(vrId, id, body_md, now)

    // Set current_revision_id
    d.prepare('UPDATE voices SET current_revision_id = ? WHERE id = ?').run(vrId, id)

    return getVoice(id)
  }

  function listVoices({ archived = false } = {}) {
    const d = ensureOpen()
    return d.prepare(
      'SELECT * FROM voices WHERE archived = ? ORDER BY name ASC'
    ).all(archived ? 1 : 0)
  }

  function getVoice(id) {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM voices WHERE id = ?').get(id) || null
  }

  function updateVoice(id, patch) {
    const d = ensureOpen()
    const allowed = ['name', 'description', 'archived']
    const sets = ['updated_at = ?']
    const vals = [new Date().toISOString()]
    for (const key of allowed) {
      if (key in patch) {
        sets.push(`${key} = ?`)
        vals.push(patch[key])
      }
    }
    if (sets.length === 1) return
    vals.push(id)
    d.prepare(`UPDATE voices SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  function appendVoiceRevision({ voiceId, body, source, proposalId }) {
    const d = ensureOpen()
    const id = randomUUID()
    const now = new Date().toISOString()

    const maxSeq = d.prepare(
      'SELECT MAX(seq) as max_seq FROM voice_revisions WHERE voice_id = ?'
    ).get(voiceId)
    const seq = (maxSeq?.max_seq ?? 0) + 1

    d.prepare(`
      INSERT INTO voice_revisions (id, voice_id, seq, body_md, source, proposal_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, voiceId, seq, body, source, proposalId ?? null, now)

    // Update voice body and current_revision_id
    d.prepare(
      'UPDATE voices SET body_md = ?, current_revision_id = ?, updated_at = ? WHERE id = ?'
    ).run(body, id, now, voiceId)

    return { id, seq, voiceId, body_md: body, source, created_at: now }
  }

  // --- Provenance ---

  function appendProvenance({ draftId, kind, payload }) {
    const d = ensureOpen()
    const now = new Date().toISOString()
    d.prepare(`
      INSERT INTO provenance (draft_id, ts, kind, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(draftId ?? null, now, kind, JSON.stringify(payload ?? {}))
  }

  function listProvenance({ draftId, sinceId } = {}) {
    const d = ensureOpen()
    if (draftId && sinceId) {
      return d.prepare(
        'SELECT * FROM provenance WHERE draft_id = ? AND id > ? ORDER BY id ASC'
      ).all(draftId, sinceId)
    }
    if (draftId) {
      return d.prepare(
        'SELECT * FROM provenance WHERE draft_id = ? ORDER BY id ASC'
      ).all(draftId)
    }
    if (sinceId) {
      return d.prepare(
        'SELECT * FROM provenance WHERE id > ? ORDER BY id ASC'
      ).all(sinceId)
    }
    return d.prepare('SELECT * FROM provenance ORDER BY id ASC').all()
  }

  // --- Sends ---

  function recordSend(row) {
    const d = ensureOpen()
    d.prepare(`
      INSERT INTO sends (
        draft_id, gmail_message_id, sent_at, final_text, first_ai_text,
        survival_rate, untouched, voice_id, distilled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      row.draft_id, row.gmail_message_id ?? null,
      row.sent_at, row.final_text, row.first_ai_text ?? null,
      row.survival_rate ?? null, row.untouched ?? 0,
      row.voice_id ?? null,
    )
  }

  function undistilledSends() {
    const d = ensureOpen()
    return d.prepare('SELECT * FROM sends WHERE distilled = 0').all()
  }

  function markDistilled(draftIds) {
    const d = ensureOpen()
    if (!draftIds || draftIds.length === 0) return
    const placeholders = draftIds.map(() => '?').join(', ')
    d.prepare(
      `UPDATE sends SET distilled = 1 WHERE draft_id IN (${placeholders})`
    ).run(...draftIds)
  }

  // --- voiceMetrics ---

  function voiceMetrics() {
    const d = ensureOpen()

    // Per-voice metrics: ISO-week survival means, scored_sends, untouched_rate
    const perVoice = d.prepare(`
      SELECT
        voice_id,
        COUNT(*) as scored_sends,
        AVG(CASE WHEN untouched = 1 THEN 1.0 ELSE 0.0 END) as untouched_rate
      FROM sends
      WHERE voice_id IS NOT NULL AND survival_rate IS NOT NULL
      GROUP BY voice_id
    `).all()

    // For each voice, get survival trend by ISO week
    const trendStmt = d.prepare(`
      SELECT
        strftime('%Y-W', sent_at, 'weekday 0', '-6 days') || printf('%02d', CAST(strftime('%W', sent_at) AS INTEGER)) as week_raw,
        substr(sent_at, 1, 4) || '-W' || printf('%02d', CAST(strftime('%W', sent_at) AS INTEGER)) as week,
        AVG(survival_rate) as mean
      FROM sends
      WHERE voice_id = ? AND survival_rate IS NOT NULL
      GROUP BY week
      ORDER BY week ASC
    `)

    const result = perVoice.map(v => {
      const trend = trendStmt.all(v.voice_id).map(r => ({
        week: r.week,
        mean: r.mean,
      }))
      return {
        voice_id: v.voice_id,
        scored_sends: v.scored_sends,
        survival_trend: trend,
        untouched_rate: v.untouched_rate,
      }
    })

    // Funnel: drafts → sent → sent_untouched
    const funnel = d.prepare(`
      SELECT
        (SELECT COUNT(*) FROM drafts) as drafts,
        (SELECT COUNT(*) FROM sends) as sent,
        (SELECT COUNT(*) FROM sends WHERE untouched = 1) as sent_untouched
    `).get() || { drafts: 0, sent: 0, sent_untouched: 0 }

    return {
      per_voice: result,
      funnel: {
        drafts: funnel.drafts ?? 0,
        sent: funnel.sent ?? 0,
        sent_untouched: funnel.sent_untouched ?? 0,
      },
    }
  }

  // --- untouched check (internal, used by provenance.mjs) ---
  // Delegates to listProposals (the promoted public form of these queries)
  // for the dismissed-proposal signal; rejected hunks stay a single join.

  function _untouchedCheck(draftId) {
    const d = ensureOpen()

    const proposals = listProposals({ targetKind: 'draft', targetId: draftId })
    if (proposals.some(p => p.status === 'dismissed')) return false

    // Check for rejected hunks on proposals targeting this draft
    const rejectedHunk = d.prepare(`
      SELECT h.id FROM hunks h
      JOIN proposals p ON p.id = h.proposal_id
      WHERE p.target_kind = 'draft' AND p.target_id = ? AND h.status = 'rejected'
      LIMIT 1
    `).get(draftId)
    if (rejectedHunk) return false

    return true
  }

  // --- close ---

  function close() {
    if (db) {
      try { db.close() } catch { /* already closed */ }
      db = null
    }
  }

  return {
    // Mirror
    upsertAccount, getAccount, updateAccount,
    upsertLabels, listLabels,
    upsertMessage, deleteMessageByGmailId, applyLabelChange,
    searchThreads, getThread, getThreadMessages, getMessage,
    recentSentTo,
    // Drafting
    createDraft, getDraft, updateDraft, listDrafts,
    appendRevision, getRevision, listRevisions,
    createProposal, getProposal, pendingProposal, listProposals,
    getHunk, updateHunk, updateProposal,
    // Voices
    createVoice, listVoices, getVoice, updateVoice, appendVoiceRevision,
    // Learning
    appendProvenance, listProvenance,
    recordSend, undistilledSends, markDistilled,
    voiceMetrics,
    // Internal (used by provenance.mjs)
    _untouchedCheck,
    // Lifecycle
    close,
  }
}
