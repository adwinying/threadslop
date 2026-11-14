import type { Database } from 'bun:sqlite'

/** Quotes a query as one FTS5 phrase so its operators match literally. */
const toPhrase = (query: string) => `"${query.replaceAll('"', '""')}"`

export const createSearch = (db: Database) => {
  const messagesQuery = db.query<
    {
      host: string
      threadId: string
      threadTitle: string
      archived: number
      snippet: string
    },
    { phrase: string; limit: number }
  >(
    `SELECT i.host, i.thread_id AS threadId, t.title AS threadTitle,
            t.archived_at IS NOT NULL AS archived,
            snippet(items_fts, 0, '«', '»', '…', 32) AS snippet
     FROM items_fts
     JOIN items i ON i.id = items_fts.rowid
     JOIN threads t ON t.host = i.host AND t.thread_id = i.thread_id
     WHERE items_fts MATCH $phrase
       AND i.type IN ('user_message', 'assistant_message')
     ORDER BY bm25(items_fts)
     LIMIT $limit`,
  )

  return (query: string, limit: number) =>
    messagesQuery
      .all({ phrase: toPhrase(query), limit })
      .map((hit) => ({ ...hit, archived: hit.archived === 1 }))
}
