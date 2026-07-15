// sync.mjs — Gmail backfill + incremental history sync
// Agent B owns this file.

const BATCH_SIZE = 25
const FETCH_CONCURRENCY = 4

export function createSync({ store, gmail, progress, signal }) {

  /**
   * Backfill — full message sync per §5.
   * Resumable via backfill_cursor; batches of 25 with event-loop yields.
   *
   * 1. GET users/me/profile → store email, pending_history_id = historyId
   *    (CAPTURED BEFORE LISTING — load-bearing ordering)
   * 2. GET users/me/labels → upsert
   * 3. Loop messages.list pages → getMessage for each, upsert in batches
   * 4. Done → history_id = pending_history_id, backfill_state: 'done'
   */
  async function backfill(accountId) {
    const account = store.getAccount(accountId)
    if (!account) throw new Error(`Account ${accountId} not found`)

    try {
      store.updateAccount(accountId, { backfill_state: 'running' })

      // Step 1: Get profile FIRST — capture historyId before listing
      const profile = await gmail.profile()
      store.updateAccount(accountId, {
        pending_history_id: profile.historyId,
      })
      // Store email if not already set
      if (!account.email) {
        store.upsertAccount({ id: accountId, email: profile.emailAddress })
      }

      // Step 2: Labels
      const labelsResponse = await gmail.listLabels()
      const labels = (labelsResponse.labels || []).map(l => ({
        gmail_id: l.id,
        name: l.name,
        type: l.type,
      }))
      store.upsertLabels(accountId, labels)

      // Step 3: Message listing + fetching
      const syncWindow = account.sync_window_days || 180
      const query = `newer_than:${syncWindow}d`
      let pageToken = account.backfill_cursor || undefined
      let totalEstimate = account.backfill_total || 0
      let done = account.backfill_done || 0

      do {
        if (signal?.aborted) break

        const listResponse = await gmail.listMessages(query, pageToken)
        const messageRefs = listResponse.messages || []
        pageToken = listResponse.nextPageToken || null

        if (listResponse.resultSizeEstimate && !totalEstimate) {
          totalEstimate = listResponse.resultSizeEstimate
          store.updateAccount(accountId, { backfill_total: totalEstimate })
        }

        // Fetch messages in groups of FETCH_CONCURRENCY, accumulate for
        // batch-of-25 upserts per contract §5
        let pendingUpserts = []

        for (let i = 0; i < messageRefs.length; i += FETCH_CONCURRENCY) {
          if (signal?.aborted) break

          const fetchBatch = messageRefs.slice(i, i + FETCH_CONCURRENCY)
          const fullMessages = await Promise.all(
            fetchBatch.map(ref => gmail.getMessage(ref.id))
          )

          const parsed = fullMessages.map(msg => gmail.parseMessage(msg))
          pendingUpserts.push(...parsed)

          // Flush when we reach BATCH_SIZE
          while (pendingUpserts.length >= BATCH_SIZE) {
            const upsertBatch = pendingUpserts.splice(0, BATCH_SIZE)
            for (const msgData of upsertBatch) {
              store.upsertMessage(accountId, msgData)
            }
            done += upsertBatch.length

            // Event-loop yield between batches
            await new Promise(resolve => {
              if (typeof setImmediate !== 'undefined') setImmediate(resolve)
              else setTimeout(resolve, 0)
            })
          }
        }

        // Flush remaining messages (< BATCH_SIZE)
        if (pendingUpserts.length > 0) {
          for (const msgData of pendingUpserts) {
            store.upsertMessage(accountId, msgData)
          }
          done += pendingUpserts.length
          await new Promise(resolve => {
            if (typeof setImmediate !== 'undefined') setImmediate(resolve)
            else setTimeout(resolve, 0)
          })
        }

        // Update cursor + progress
        store.updateAccount(accountId, {
          backfill_cursor: pageToken || null,
          backfill_done: done,
        })

        if (progress) {
          progress({ backfill_done: done, backfill_total: totalEstimate })
        }
      } while (pageToken)

      // Step 4: Done — promote pending_history_id → history_id
      const freshAccount = store.getAccount(accountId)
      store.updateAccount(accountId, {
        history_id: freshAccount.pending_history_id,
        backfill_state: 'done',
        backfill_cursor: null,
        last_sync_at: new Date().toISOString(),
        last_error: null,
      })
    } catch (err) {
      store.updateAccount(accountId, {
        backfill_state: 'error',
        last_error: err.message,
      })
      throw err
    }
  }

  /**
   * Incremental sync — history-based, per §5.
   * Requires backfill done. Uses history.list from stored history_id.
   * HTTP 404 → re-list 7 days + historyId reset from fresh getProfile.
   */
  async function incremental(accountId) {
    const account = store.getAccount(accountId)
    if (!account) throw new Error(`Account ${accountId} not found`)
    if (account.backfill_state !== 'done') {
      throw new Error('Backfill must complete before incremental sync')
    }

    const historyId = account.history_id
    if (!historyId) {
      throw new Error('No history_id — run backfill first')
    }

    try {
      let pageToken = undefined
      let newHistoryId = historyId

      do {
        if (signal?.aborted) break

        let historyResponse
        try {
          historyResponse = await gmail.history(historyId, pageToken)
        } catch (err) {
          if (err.status === 404) {
            // History expired → re-list 7 days + reset historyId
            await _reconcileAfterHistoryExpiry(accountId)
            return
          }
          throw err
        }

        const entries = historyResponse.history || []
        newHistoryId = historyResponse.historyId || newHistoryId
        pageToken = historyResponse.nextPageToken || null

        for (const entry of entries) {
          if (signal?.aborted) break
          await _applyHistoryEntry(accountId, entry)
        }
      } while (pageToken)

      // Update history_id and last_sync_at
      store.updateAccount(accountId, {
        history_id: newHistoryId,
        last_sync_at: new Date().toISOString(),
        last_error: null,
      })
    } catch (err) {
      store.updateAccount(accountId, { last_error: err.message })
      throw err
    }
  }

  /**
   * Apply a single history entry: messagesAdded, messagesDeleted,
   * labelsAdded, labelsRemoved.
   */
  async function _applyHistoryEntry(accountId, entry) {
    // messagesAdded: fetch full message, upsert
    if (entry.messagesAdded) {
      for (const added of entry.messagesAdded) {
        const full = await gmail.getMessage(added.message.id)
        const parsed = gmail.parseMessage(full)
        store.upsertMessage(accountId, parsed)
      }
    }

    // messagesDeleted: delete rows + FTS
    if (entry.messagesDeleted) {
      for (const deleted of entry.messagesDeleted) {
        store.deleteMessageByGmailId(accountId, deleted.message.id)
      }
    }

    // labelsAdded: update label_ids_json, unread, thread rollups
    if (entry.labelsAdded) {
      for (const change of entry.labelsAdded) {
        const addIds = change.labelIds || []
        store.applyLabelChange(accountId, change.message.id, addIds, [])
      }
    }

    // labelsRemoved: update label_ids_json, unread, thread rollups
    if (entry.labelsRemoved) {
      for (const change of entry.labelsRemoved) {
        const removeIds = change.labelIds || []
        store.applyLabelChange(accountId, change.message.id, [], removeIds)
      }
    }
  }

  /**
   * Handle history 404: re-list 7 days + reset historyId from fresh profile.
   */
  async function _reconcileAfterHistoryExpiry(accountId) {
    // Fresh profile to get current historyId
    const profile = await gmail.profile()
    const newHistoryId = profile.historyId

    // Re-list last 7 days
    let pageToken = undefined
    do {
      if (signal?.aborted) break

      const listResponse = await gmail.listMessages('newer_than:7d', pageToken)
      const messageRefs = listResponse.messages || []
      pageToken = listResponse.nextPageToken || null

      for (let i = 0; i < messageRefs.length; i += FETCH_CONCURRENCY) {
        const batch = messageRefs.slice(i, i + FETCH_CONCURRENCY)
        const fullMessages = await Promise.all(
          batch.map(ref => gmail.getMessage(ref.id))
        )
        const parsed = fullMessages.map(msg => gmail.parseMessage(msg))
        for (const msgData of parsed) {
          store.upsertMessage(accountId, msgData)
        }

        await new Promise(resolve => {
          if (typeof setImmediate !== 'undefined') setImmediate(resolve)
          else setTimeout(resolve, 0)
        })
      }
    } while (pageToken)

    // Reset historyId
    store.updateAccount(accountId, {
      history_id: newHistoryId,
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
  }

  return { backfill, incremental }
}
