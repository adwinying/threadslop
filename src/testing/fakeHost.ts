import type { AppCollaborators } from '~/app'
import type { HostTransport, QueryOperation } from '~/hosts'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '~/app'

const queryScript = fileURLToPath(
  new URL('../../host/query.mjs', import.meta.url),
)

// The subset of T3's statev2 schema the query script reads, plus decoy tables
// it must never touch.
const schema = `
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY, title TEXT NOT NULL,
    workspace_root TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT);
  CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE orchestration_v2_projection_turn_items (
    turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT,
    ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
    updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, token TEXT);
  CREATE TABLE peer_environment_links (id TEXT PRIMARY KEY, secret TEXT);
`

type ThreadFixture = {
  id: string
  title: string
  updatedAt: string
}

type MessageFixture = {
  id: string
  threadId: string
  ordinal: number
  role: 'user' | 'assistant'
  text: string
  updatedAt: string
}

type ItemFixture = {
  id: string
  threadId: string
  ordinal: number
  type: string
  updatedAt: string
  [field: string]: unknown
}

type RawItemFixture = {
  id: string
  threadId: string
  ordinal: number
  type: string
  updatedAt: string
  payload: string
}

const messagePayload = ({ role, ...message }: MessageFixture) =>
  JSON.stringify({
    ...message,
    type: `${role}_message`,
    status: 'completed',
    startedAt: message.updatedAt,
    completedAt: message.updatedAt,
  })

/** A Host's T3 home directory with a fixture `statev2.sqlite`. */
export const createFakeHost = (root: string, label: string) => {
  const home = join(root, label)
  const userdata = join(home, '.t3', 'userdata')
  mkdirSync(userdata, { recursive: true })
  const environmentId = crypto.randomUUID()
  writeFileSync(join(userdata, 'environment-id'), `${environmentId}\n`)

  const db = new Database(join(userdata, 'statev2.sqlite'), {
    create: true,
    strict: true,
  })
  // Fixtures needn't survive a crash; this keeps bulk inserts fast.
  db.run('PRAGMA synchronous = OFF')
  db.run(schema)
  db.run(
    `INSERT INTO projection_projects VALUES
      ('project-1', 'threadslop', '/home/adwin/dev/threadslop',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
  )

  const insertItem = (item: RawItemFixture) => {
    db.query(
      `INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at,
         payload_json)
       VALUES ($id, $threadId, $ordinal, $type, 'completed', $updatedAt,
         $payload)`,
    ).run(item)
  }

  return {
    label,
    home,
    environmentId,
    addThread: ({ id, title, updatedAt }: ThreadFixture) => {
      db.query(
        `INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, created_at, updated_at)
         VALUES ($id, 'project-1', $title, $updatedAt, $updatedAt)`,
      ).run({ id, title, updatedAt })
    },
    addMessage: (message: MessageFixture) => {
      insertItem({
        id: message.id,
        threadId: message.threadId,
        ordinal: message.ordinal,
        type: `${message.role}_message`,
        updatedAt: message.updatedAt,
        payload: messagePayload(message),
      })
    },
    /** Adds an Item whose payload is stored verbatim, however malformed. */
    addRawItem: insertItem,
    /** Adds an Item of any type; extra fields go into its payload. */
    addItem: ({
      id,
      threadId,
      ordinal,
      type,
      updatedAt,
      ...fields
    }: ItemFixture) => {
      insertItem({
        id,
        threadId,
        ordinal,
        type,
        updatedAt,
        payload: JSON.stringify({
          id,
          threadId,
          ordinal,
          type,
          status: 'completed',
          startedAt: updatedAt,
          completedAt: updatedAt,
          updatedAt,
          ...fields,
        }),
      })
    },
    editMessage: (message: MessageFixture) => {
      db.query(
        `UPDATE orchestration_v2_projection_turn_items
         SET updated_at = $updatedAt, payload_json = $payload
         WHERE turn_item_id = $id`,
      ).run({
        id: message.id,
        updatedAt: message.updatedAt,
        payload: messagePayload(message),
      })
    },
    removeItem: (id: string) => {
      db.query(
        'DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = $id',
      ).run({ id })
    },
    archiveThread: (id: string, archivedAt: string) => {
      db.query(
        `UPDATE orchestration_v2_projection_threads
         SET archived_at = $archivedAt, updated_at = $archivedAt
         WHERE thread_id = $id`,
      ).run({ id, archivedAt })
    },
    deleteThread: (id: string, deletedAt: string) => {
      db.query(
        `UPDATE orchestration_v2_projection_threads
         SET deleted_at = $deletedAt, updated_at = $deletedAt
         WHERE thread_id = $id`,
      ).run({ id, deletedAt })
    },
    /** Drops a Thread outright, as a reinstall that resets T3's DB would. */
    purgeThread: (id: string) => {
      db.query(
        'DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = $id',
      ).run({ id })
      db.query(
        'DELETE FROM orchestration_v2_projection_threads WHERE thread_id = $id',
      ).run({ id })
    },
  }
}

export type FakeHost = ReturnType<typeof createFakeHost>

export const createFakeHostRoot = () => mkdtempSync(join(tmpdir(), 'hosts-'))

/** Runs the real query script under Node, as sshd's forced command would. */
export const runQueryScript = async (
  home: string,
  operation: string,
  stdin = '',
) => {
  const child = Bun.spawn(
    ['node', '--disable-warning=ExperimentalWarning', queryScript],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SSH_ORIGINAL_COMMAND: operation,
      },
      stdin: new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

export const testNow = new Date('2026-11-14T00:00:00Z')

type TestAppOptions = Partial<Omit<AppCollaborators, 'hosts'>> & {
  /** Host labels. Give each a fixture with `createFakeHost(root, label)`. */
  hosts?: string[]
}

/**
 * An app wired to fake Hosts under a fresh root, with an in-memory archive, a
 * fixed clock and paused cron jobs. A Host without a fixture fails like an
 * offline one.
 */
export const createTestApp = ({
  hosts = ['hive'],
  ...collaborators
}: TestAppOptions = {}) => {
  const root = createFakeHostRoot()
  const queries: { label: string; operation: QueryOperation }[] = []
  const app = createApp({
    database: new Database(':memory:', { strict: true }),
    dataDir: root,
    transport: createFakeTransport(root, (label, operation) =>
      queries.push({ label, operation }),
    ),
    clock: () => testNow,
    pauseCrons: true,
    ...collaborators,
    hosts: () =>
      hosts.map((label) => ({ label, destination: `adwin@${label}` })),
  })
  const handle = (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost${path}`, init))

  return {
    app,
    root,
    queries,
    handle,
    sync: () => handle('/sync', { method: 'POST' }),
  }
}

/** A HostTransport that runs the query script against each fake Host. */
export const createFakeTransport = (
  root: string,
  onQuery?: (label: string, operation: QueryOperation) => void,
): HostTransport => {
  return async (host, operation, stdin) => {
    onQuery?.(host.label, operation)
    const { stdout, stderr, exitCode } = await runQueryScript(
      join(root, host.label),
      operation,
      stdin,
    )
    if (exitCode !== 0) throw new Error(stderr.trim())
    return stdout
  }
}
