import type { Database } from 'bun:sqlite'
import type { ItemScope } from '~/itemScope'
import { geminiChatUrl, geminiLabel } from '~/gemini'
import { inScopeSql, roleOf } from '~/itemScope'

type HitRow = {
  host: string
  environmentId: string | null
  threadId: string
  threadTitle: string
  project: string | null
  itemType: string
  snippet: string
  createdAt: string
  archived: number
}

type Filters = { host: string | null; all: boolean; limit: number }

export type SearchOptions = { host?: string; items: ItemScope; limit: number }

const hitColumns = `
  i.host, h.environment_id AS environmentId, i.thread_id AS threadId,
  t.title AS threadTitle, t.project_title AS project, i.type AS itemType,
  i.created_at AS createdAt, t.archived_at IS NOT NULL AS archived`

const hitJoins = `
  JOIN threads t ON t.host = i.host AND t.thread_id = i.thread_id
  JOIN hosts h ON h.label = i.host`

const toHit = ({ archived, ...row }: HitRow) => ({
  ...row,
  role: roleOf(row.itemType),
  archived: archived === 1,
  link:
    row.host === geminiLabel
      ? geminiChatUrl(row.threadId)
      : `t3-thread://v2/${row.environmentId}/${row.threadId}`,
})

/** Quotes a query as one FTS5 phrase so its operators match literally. */
const toPhrase = (query: string) => `"${query.replaceAll('"', '""')}"`

/** Escapes LIKE wildcards so a query matches as a literal substring. */
const toPattern = (query: string) =>
  `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export const createSearch = (db: Database) => {
  const itemsQuery = db.query<HitRow, { phrase: string } & Filters>(
    `SELECT ${hitColumns},
            snippet(items_fts, 0, '«', '»', '…', 32) AS snippet
     FROM items_fts
     JOIN items i ON i.id = items_fts.rowid
     ${hitJoins}
     WHERE items_fts MATCH $phrase
       AND ${inScopeSql}
       AND ($host IS NULL OR i.host = $host)
     ORDER BY bm25(items_fts)
     LIMIT $limit`,
  )

  // The trigram index can't match under 3 characters, so short queries scan
  // the content table. LIKE and lower() both fold ASCII case only.
  const shortItemsQuery = db.query<
    HitRow,
    { pattern: string; query: string } & Filters
  >(
    `SELECT ${hitColumns},
            iif(pos > 31, '…', '')
              || substr(i.search_text, max(1, pos - 30), min(pos, 31) - 1)
              || '«' || substr(i.search_text, pos, length($query)) || '»'
              || substr(i.search_text, pos + length($query), 30)
              || iif(length(i.search_text) - pos - length($query) >= 30,
                     '…', '') AS snippet
     FROM (SELECT *, instr(lower(search_text), lower($query)) AS pos
           FROM items) i
     ${hitJoins}
     WHERE i.search_text LIKE $pattern ESCAPE '\\'
       AND ${inScopeSql}
       AND ($host IS NULL OR i.host = $host)
     ORDER BY i.created_at DESC
     LIMIT $limit`,
  )

  return (query: string, { host, items, limit }: SearchOptions) => {
    const filters = { host: host ?? null, all: items === 'all', limit }
    // Spread counts code points, as SQLite's trigram tokenizer does.
    // oxlint-disable-next-line typescript/no-misused-spread -- graphemes would miscount
    const isShort = [...query].length < 3
    return (
      isShort
        ? shortItemsQuery.all({ pattern: toPattern(query), query, ...filters })
        : itemsQuery.all({ phrase: toPhrase(query), ...filters })
    ).map(toHit)
  }
}
