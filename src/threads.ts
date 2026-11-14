import type { Database } from 'bun:sqlite'
import type { ItemScope } from '~/itemScope'
import { inScopeSql, roleOf } from '~/itemScope'

type Key = { host: string; threadId: string }

export const createThreadReader = (db: Database) => {
  const threadQuery = db.query<
    {
      host: string
      id: string
      title: string
      projectTitle: string | null
      workspaceRoot: string | null
      createdAt: string
      updatedAt: string
      archivedAt: string | null
    },
    Key
  >(
    `SELECT host, thread_id AS id, title, project_title AS projectTitle,
            workspace_root AS workspaceRoot, created_at AS createdAt,
            updated_at AS updatedAt, archived_at AS archivedAt
     FROM threads WHERE host = $host AND thread_id = $threadId`,
  )
  const itemsQuery = db.query<
    {
      id: string
      type: string
      status: string
      ordinal: number
      createdAt: string
      completedAt: string | null
      updatedAt: string
      text: string
    },
    Key & { all: boolean }
  >(
    `SELECT item_id AS id, type, status, ordinal, created_at AS createdAt,
            completed_at AS completedAt, updated_at AS updatedAt,
            search_text AS text
     FROM items i
     WHERE host = $host AND thread_id = $threadId AND ${inScopeSql}
     ORDER BY ordinal`,
  )

  /** The archived Thread and its Items in ordinal order, if it exists. */
  return (host: string, threadId: string, scope: ItemScope) => {
    const thread = threadQuery.get({ host, threadId })
    return (
      thread && {
        thread,
        items: itemsQuery
          .all({ host, threadId, all: scope === 'all' })
          .map((item) => ({ ...item, role: roleOf(item.type) })),
      }
    )
  }
}
