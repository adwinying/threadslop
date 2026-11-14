import type { FakeHost } from '~/testing/fakeHost'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeHost, createTestApp, testNow } from '~/testing/fakeHost'

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

const createHive = (root: string) => {
  const host = createFakeHost(root, 'hive')
  host.addThread({
    id: 'thread-1',
    title: 'Fix login',
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  host.addMessage({
    id: 'item-1',
    threadId: 'thread-1',
    ordinal: 1,
    role: 'user',
    text: 'Why does the login redirect loop?',
    updatedAt: '2026-11-01T00:00:01.000Z',
  })
  return host
}

let hive: FakeHost
let testApp: ReturnType<typeof createTestApp>

beforeEach(() => {
  // mayonaca has no fixture, so its query script fails like an offline Host.
  testApp = createTestApp({ hosts: ['mayonaca', 'hive'] })
  hive = createHive(testApp.root)
})

const handle = (path: string) => testApp.handle(path)

const sync = () => testApp.sync()

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
          lastErrorAt: testNow.toISOString(),
        },
        {
          host: 'hive',
          environmentId: hive.environmentId,
          lastSuccessAt: testNow.toISOString(),
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
      testApp.queries.filter(({ operation }) => operation === 'signatures'),
    ).toEqual([
      { label: 'mayonaca', operation: 'signatures' },
      { label: 'hive', operation: 'signatures' },
    ])
    expect(await second.json()).toEqual(await first.json())
  })
})

describe('the Sync cron job', () => {
  test('runs every 5 minutes', () => {
    expect(testApp.app.store.cron.sync.getPattern()).toBe('*/5 * * * *')
  })

  test('joins a Sync already started by POST /sync', async () => {
    const [response] = await Promise.all([
      sync(),
      testApp.app.store.cron.sync.trigger(),
    ])

    expect(response.status).toBe(200)
    expect(
      testApp.queries.filter(({ operation }) => operation === 'signatures'),
    ).toHaveLength(2)
  })
})

describe('cron jobs in a test app', () => {
  test('never fire on their own', () => {
    const jobs = Object.values(testApp.app.store.cron)

    expect(jobs.map((job) => job.isRunning())).toEqual([false, false])
  })
})

describe('the Snapshot cron job', () => {
  test('runs daily at 05:45 Asia/Tokyo', () => {
    const { snapshot } = testApp.app.store.cron

    expect(snapshot.getPattern()).toBe('45 5 * * *')
    expect(snapshot.options.timezone).toBe('Asia/Tokyo')
  })

  test('writes a readable Snapshot with the same row counts to the data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'data-'))
    const database = new Database(':memory:', { strict: true })
    testApp = createTestApp({ database, dataDir })
    createHive(testApp.root)
    await sync()

    await testApp.app.store.cron.snapshot.trigger()

    const snapshotDb = new Database(join(dataDir, 'threadslop.backup.sqlite'), {
      readonly: true,
    })
    expect(rowCounts(snapshotDb)).toEqual(rowCounts(database))
    expect(rowCounts(snapshotDb)).toContainEqual(['items', 1])
    expect(readdirSync(dataDir)).toEqual(['threadslop.backup.sqlite'])
  })
})
