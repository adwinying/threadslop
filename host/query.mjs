// threadslop's forced command on each Host. sshd runs it with the requested
// operation in SSH_ORIGINAL_COMMAND. It reads T3's database read-only and
// writes pure JSON to stdout. This is the only file that knows T3's schema.
//
//   signatures  The environment ID, each Thread's Signature, and how many
//               Threads were skipped for an unsafe ID.
//   threads     Thread IDs as a JSON array on stdin; those Threads and Items.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Not a UUID pattern: T3 also has IDs like `thread:delegated-task:…%3A…`.
const threadIdPattern = /^[A-Za-z0-9:%._-]{1,512}$/

const userdata = join(homedir(), '.t3', 'userdata')

const openDatabase = () =>
  new DatabaseSync(join(userdata, 'statev2.sqlite'), { readOnly: true })

const signatures = () => {
  const environmentId = readFileSync(
    join(userdata, 'environment-id'),
    'utf8',
  ).trim()
  const rows = openDatabase()
    .prepare(
      `SELECT t.thread_id AS id,
              max(t.updated_at, coalesce(max(i.updated_at), '')) AS updatedAt,
              count(i.turn_item_id) AS itemCount,
              t.deleted_at IS NOT NULL AS deleted
       FROM orchestration_v2_projection_threads t
       LEFT JOIN orchestration_v2_projection_turn_items i
         ON i.thread_id = t.thread_id
       GROUP BY t.thread_id`,
    )
    .all()
  // `threads` would refuse an unsafe ID, stalling the whole Host, so those
  // Threads are left out and only counted.
  const safe = rows.filter(({ id }) => threadIdPattern.test(id))
  return {
    environmentId,
    threads: safe.map((row) => ({ ...row, deleted: row.deleted === 1 })),
    skipped: rows.length - safe.length,
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const parseThreadIds = (input) => {
  const ids = parseJson(input)
  if (!Array.isArray(ids)) {
    throw new Error('stdin must be a JSON array of Thread IDs')
  }
  const invalid = ids.find(
    (id) => typeof id !== 'string' || !threadIdPattern.test(id),
  )
  if (invalid !== undefined) {
    throw new Error(`invalid Thread ID: ${JSON.stringify(invalid)}`)
  }
  return ids
}

const textOrNull = (value) => (typeof value === 'string' ? value : null)

// T3 keeps Item times only in the payload. One missing or malformed must not
// fail the Sync, so the start falls back to the Item's update time.
const withTimes = (item) => {
  const payload = parseJson(item.payload)
  return {
    ...item,
    createdAt: textOrNull(payload?.startedAt) ?? item.updatedAt,
    completedAt: textOrNull(payload?.completedAt),
  }
}

const threads = () => {
  const ids = JSON.stringify(parseThreadIds(readFileSync(0, 'utf8')))
  const db = openDatabase()
  const threadRows = db
    .prepare(
      `SELECT t.thread_id AS id, t.title, p.title AS projectTitle,
              p.workspace_root AS workspaceRoot, t.created_at AS createdAt,
              t.updated_at AS updatedAt, t.archived_at AS archivedAt,
              t.deleted_at AS deletedAt
       FROM orchestration_v2_projection_threads t
       LEFT JOIN projection_projects p ON p.project_id = t.project_id
       WHERE t.thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids)
  const itemRows = db
    .prepare(
      `SELECT turn_item_id AS id, thread_id AS threadId, type, status, ordinal,
              updated_at AS updatedAt, payload_json AS payload
       FROM orchestration_v2_projection_turn_items
       WHERE thread_id IN (SELECT value FROM json_each(?))
       ORDER BY thread_id, ordinal`,
    )
    .all(ids)

  const itemsByThread = Map.groupBy(
    itemRows.map(withTimes),
    ({ threadId }) => threadId,
  )
  return {
    threads: threadRows.map((thread) => ({
      ...thread,
      items: itemsByThread.get(thread.id) ?? [],
    })),
  }
}

const operations = { signatures, threads }

try {
  const operation = process.env.SSH_ORIGINAL_COMMAND ?? ''
  if (!Object.hasOwn(operations, operation)) {
    throw new Error(`unknown operation: ${JSON.stringify(operation)}`)
  }
  process.stdout.write(JSON.stringify(operations[operation]()))
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
