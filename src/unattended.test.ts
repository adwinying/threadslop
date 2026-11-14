import type { QueryOperation } from '~/app'
import type { FakeHost } from '~/testing/fakeHost'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from '~/app'
import {
  createFakeHost,
  createFakeHostRoot,
  createFakeTransport,
} from '~/testing/fakeHost'

const now = new Date('2026-11-14T00:00:00Z')

const rowCounts = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map(({ name }) => [
      name,
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name}"`).get()
        ?.n,
    ])

let hive: FakeHost
let queries: { label: string; operation: QueryOperation }[]
let app: ReturnType<typeof createApp>

beforeEach(() => {
  const root = createFakeHostRoot()
  hive = createFakeHost(root, 'hive')
  queries = []
  // mayonaca has no fixture, so its query script fails like an offline Host.
  app = createApp({
    database: new Database(':memory:', { strict: true }),
    hosts: [
      { label: 'mayonaca', destination: 'adwin@mayonaca' },
      { label: 'hive', destination: 'adwin@hive' },
    ],
    transport: createFakeTransport(root, (label, operation) =>
      queries.push({ label, operation }),
    ),
    clock: () => now,
  })

  hive.addThread({
    id: 'thread-1',
    title: 'Fix login',
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  hive.addMessage({
    id: 'item-1',
    threadId: 'thread-1',
    ordinal: 1,
    role: 'user',
    text: 'Why does the login redirect loop?',
    updatedAt: '2026-11-01T00:00:01.000Z',
  })
})

const handle = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init))

const sync = () => handle('/sync', { method: 'POST' })

describe('POST /sync with a failing Host', () => {
  test('syncs the other Hosts and /health shows the failure', async () => {
    const response = await sync()

    expect(await response.json()).toEqual({
      hosts: [
        { host: 'mayonaca', ok: false, error: expect.any(String) },
        { host: 'hive', ok: true, threadsPulled: 1 },
      ],
    })
    const search = await handle('/search?q=redirect')
    expect(await search.json()).toEqual({
      hits: [expect.objectContaining({ host: 'hive', threadId: 'thread-1' })],
    })

    const health = await handle('/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      hosts: [
        {
          host: 'mayonaca',
          environmentId: null,
          lastSuccessAt: null,
          lastError: expect.stringContaining('no such file'),
          lastErrorAt: now.toISOString(),
        },
        {
          host: 'hive',
          environmentId: hive.environmentId,
          lastSuccessAt: now.toISOString(),
          lastError: null,
          lastErrorAt: null,
        },
      ],
    })
  })
})

describe('two concurrent POST /sync calls', () => {
  test('run one Sync and both return its result', async () => {
    const [first, second] = await Promise.all([sync(), sync()])

    expect(
      queries.filter(({ operation }) => operation === 'signatures'),
    ).toEqual([
      { label: 'mayonaca', operation: 'signatures' },
      { label: 'hive', operation: 'signatures' },
    ])
    expect(await second.json()).toEqual(await first.json())
  })
})

describe('the Sync cron job', () => {
  test('runs every 5 minutes', () => {
    expect(app.store.cron.sync.getPattern()).toBe('*/5 * * * *')
  })

  test('joins a Sync already started by POST /sync', async () => {
    const [response] = await Promise.all([
      sync(),
      app.store.cron.sync.trigger(),
    ])

    expect(response.status).toBe(200)
    expect(
      queries.filter(({ operation }) => operation === 'signatures'),
    ).toHaveLength(2)
  })
})

describe('the Snapshot cron job', () => {
  test('runs daily at 05:45 Asia/Tokyo', () => {
    const { snapshot } = app.store.cron

    expect(snapshot.getPattern()).toBe('45 5 * * *')
    expect(snapshot.options.timezone).toBe('Asia/Tokyo')
  })

  test('writes a readable backup with the same row counts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'data-'))
    const database = new Database(join(dataDir, 'threadslop.sqlite'), {
      create: true,
      strict: true,
    })
    app = createApp({
      database,
      hosts: [{ label: 'hive', destination: 'adwin@hive' }],
      transport: createFakeTransport(dirname(hive.home)),
      clock: () => now,
    })
    await sync()

    await app.store.cron.snapshot.trigger()

    const backup = new Database(join(dataDir, 'threadslop.backup.sqlite'), {
      readonly: true,
    })
    expect(rowCounts(backup)).toEqual(rowCounts(database))
    expect(rowCounts(backup)).toContainEqual(['items', 1])
    expect(readdirSync(dataDir)).not.toContain('threadslop.backup.sqlite.tmp')
  })
})
