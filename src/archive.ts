import type { Database } from 'bun:sqlite'

// Rows are keyed by (Host, ID): the same Thread ID on two Hosts is two Threads.
const schema = `
  CREATE TABLE IF NOT EXISTS hosts (
    label TEXT PRIMARY KEY,
    environment_id TEXT,
    last_success_at TEXT,
    last_error TEXT,
    last_error_at TEXT
  );

  CREATE TABLE IF NOT EXISTS threads (
    host TEXT NOT NULL REFERENCES hosts (label),
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project_title TEXT,
    workspace_root TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    PRIMARY KEY (host, thread_id)
  );

  -- The integer rowid backs the external-content FTS index.
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL,
    item_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    search_text TEXT NOT NULL,
    UNIQUE (host, item_id),
    FOREIGN KEY (host, thread_id) REFERENCES threads (host, thread_id)
      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS items_thread_idx
    ON items (host, thread_id, ordinal);

  -- The Signature each Host last reported, kept even after its Thread is
  -- removed so it isn't re-pulled.
  CREATE TABLE IF NOT EXISTS signatures (
    host TEXT NOT NULL REFERENCES hosts (label),
    thread_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    PRIMARY KEY (host, thread_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5 (
    search_text,
    content = 'items',
    content_rowid = 'id',
    tokenize = 'trigram remove_diacritics 1'
  );
  CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (rowid, search_text)
      VALUES (new.id, new.search_text);
  END;
  CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, search_text)
      VALUES ('delete', old.id, old.search_text);
  END;
  CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, search_text)
      VALUES ('delete', old.id, old.search_text);
    INSERT INTO items_fts (rowid, search_text)
      VALUES (new.id, new.search_text);
  END;
`

export const migrate = (db: Database) => {
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run(schema)
}

export type Signature = {
  updatedAt: string
  itemCount: number
  deleted: boolean
}

export type ArchivedItem = {
  id: string
  type: string
  status: string
  ordinal: number
  createdAt: string
  completedAt: string | null
  updatedAt: string
  payload: string
  searchText: string
}

export type ArchivedThread = {
  id: string
  title: string
  projectTitle: string | null
  workspaceRoot: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  signature: Signature
  items: ArchivedItem[]
}

export const createArchive = (db: Database) => {
  const upsertHostQuery = db.query(
    `INSERT INTO hosts (label, environment_id) VALUES ($host, $environmentId)
     ON CONFLICT (label) DO UPDATE SET environment_id = excluded.environment_id`,
  )
  const recordSuccessQuery = db.query(
    `INSERT INTO hosts (label, last_success_at) VALUES ($host, $at)
     ON CONFLICT (label) DO UPDATE SET last_success_at = excluded.last_success_at`,
  )
  const recordFailureQuery = db.query(
    `INSERT INTO hosts (label, last_error, last_error_at)
     VALUES ($host, $error, $at)
     ON CONFLICT (label) DO UPDATE SET
       last_error = excluded.last_error,
       last_error_at = excluded.last_error_at`,
  )
  const hostsQuery = db.query<
    {
      host: string
      environmentId: string | null
      lastSuccessAt: string | null
      lastError: string | null
      lastErrorAt: string | null
    },
    []
  >(
    `SELECT label AS host, environment_id AS environmentId,
            last_success_at AS lastSuccessAt, last_error AS lastError,
            last_error_at AS lastErrorAt
     FROM hosts`,
  )
  const signaturesQuery = db.query<
    { threadId: string; updatedAt: string; itemCount: number; deleted: number },
    { host: string }
  >(
    `SELECT thread_id AS threadId, updated_at AS updatedAt,
            item_count AS itemCount, deleted
     FROM signatures WHERE host = $host`,
  )
  const upsertThreadQuery = db.query(
    `INSERT INTO threads (host, thread_id, title, project_title, workspace_root,
       created_at, updated_at, archived_at)
     VALUES ($host, $id, $title, $projectTitle, $workspaceRoot, $createdAt,
       $updatedAt, $archivedAt)
     ON CONFLICT (host, thread_id) DO UPDATE SET
       title = excluded.title,
       project_title = excluded.project_title,
       workspace_root = excluded.workspace_root,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       archived_at = excluded.archived_at`,
  )
  // ON CONFLICT DO UPDATE fires the update trigger. INSERT OR REPLACE would
  // corrupt the external-content FTS index.
  const upsertItemQuery = db.query(
    `INSERT INTO items (host, item_id, thread_id, type, status, ordinal,
       created_at, completed_at, updated_at, payload, search_text)
     VALUES ($host, $id, $threadId, $type, $status, $ordinal, $createdAt,
       $completedAt, $updatedAt, $payload, $searchText)
     ON CONFLICT (host, item_id) DO UPDATE SET
       thread_id = excluded.thread_id,
       type = excluded.type,
       status = excluded.status,
       ordinal = excluded.ordinal,
       created_at = excluded.created_at,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at,
       payload = excluded.payload,
       search_text = excluded.search_text`,
  )
  const upsertSignatureQuery = db.query(
    `INSERT INTO signatures (host, thread_id, updated_at, item_count, deleted)
     VALUES ($host, $threadId, $updatedAt, $itemCount, $deleted)
     ON CONFLICT (host, thread_id) DO UPDATE SET
       updated_at = excluded.updated_at,
       item_count = excluded.item_count,
       deleted = excluded.deleted`,
  )

  const deleteStaleItemsQuery = db.query(
    `DELETE FROM items
     WHERE host = $host AND thread_id = $threadId
       AND item_id NOT IN (SELECT value FROM json_each($itemIds))`,
  )
  const deleteThreadQuery = db.query(
    'DELETE FROM threads WHERE host = $host AND thread_id = $threadId',
  )

  const saveSignature = (
    host: string,
    threadId: string,
    signature: Signature,
  ) => {
    upsertSignatureQuery.run({
      host,
      threadId,
      ...signature,
      deleted: signature.deleted ? 1 : 0,
    })
  }

  return {
    recordHost: (host: string, environmentId: string) => {
      upsertHostQuery.run({ host, environmentId })
    },

    recordSuccess: (host: string, at: Date) => {
      recordSuccessQuery.run({ host, at: at.toISOString() })
    },

    recordFailure: (host: string, error: string, at: Date) => {
      recordFailureQuery.run({ host, error, at: at.toISOString() })
    },

    /** Each Host's Sync status, in the order of `hosts`. */
    health: (hosts: string[]) => {
      const rows = new Map(hostsQuery.all().map((row) => [row.host, row]))
      return hosts.map(
        (host) =>
          rows.get(host) ?? {
            host,
            environmentId: null,
            lastSuccessAt: null,
            lastError: null,
            lastErrorAt: null,
          },
      )
    },

    /** The Signatures each Host last reported, by Thread ID. */
    signatures: (host: string) =>
      new Map(
        signaturesQuery
          .all({ host })
          .map(({ threadId, deleted, ...signature }) => [
            threadId,
            { ...signature, deleted: deleted === 1 },
          ]),
      ),

    /**
     * Upserts Threads, their Items and their new Signatures atomically, and
     * drops Items the Host no longer reports.
     */
    saveThreads: db.transaction((host: string, threads: ArchivedThread[]) => {
      for (const { items, signature, ...thread } of threads) {
        upsertThreadQuery.run({ host, ...thread })
        deleteStaleItemsQuery.run({
          host,
          threadId: thread.id,
          itemIds: JSON.stringify(items.map(({ id }) => id)),
        })
        for (const item of items) {
          upsertItemQuery.run({ host, threadId: thread.id, ...item })
        }
        saveSignature(host, thread.id, signature)
      }
    }),

    /**
     * Removes deleted Threads with their Items, keeping their Signatures so
     * they aren't re-pulled.
     */
    removeThreads: db.transaction(
      (host: string, deleted: Map<string, Signature>) => {
        for (const [threadId, signature] of deleted) {
          deleteThreadQuery.run({ host, threadId })
          saveSignature(host, threadId, signature)
        }
      },
    ),
  }
}

export type Archive = ReturnType<typeof createArchive>
