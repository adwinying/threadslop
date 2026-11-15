import type { FakeHost } from '~/testing/fakeHost'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFakeHost,
  createTestApp,
  testNow,
  waitForSync,
} from '~/testing/fakeHost'

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
    await sync()

    const search = await handle('/search?q=redirect')
    expect(await search.json()).toEqual({
      hits: [expect.objectContaining({ host: 'hive', threadId: 'thread-1' })],
    })

    const health = await handle('/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      syncing: false,
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

  test('clears the failure once the Host syncs', async () => {
    await sync()
    createFakeHost(testApp.root, 'mayonaca')

    await sync()

    const health = await handle('/health')
    expect(await health.json()).toEqual(
      expect.objectContaining({
        hosts: expect.arrayContaining([
          expect.objectContaining({
            host: 'mayonaca',
            lastSuccessAt: testNow.toISOString(),
            lastError: null,
            lastErrorAt: null,
          }),
        ]),
      }),
    )
  })
})

describe('two POST /sync calls during one Sync', () => {
  test('start it, then report it running, and run it once', async () => {
    const post = () => testApp.handle('/sync', { method: 'POST' })

    const first = await post()
    const second = await post()
    await waitForSync(testApp.handle)

    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ status: 'started' })
    expect(second.status).toBe(202)
    expect(await second.json()).toEqual({ status: 'running' })
    expect(
      testApp.queries.filter(({ operation }) => operation === 'signatures'),
    ).toEqual([
      { label: 'mayonaca', operation: 'signatures' },
      { label: 'hive', operation: 'signatures' },
    ])
  })
})

describe('/health during a Sync', () => {
  test('reports syncing until the Sync is done', async () => {
    await testApp.handle('/sync', { method: 'POST' })

    const during = await (await handle('/health')).json()
    await waitForSync(testApp.handle)
    const after = await (await handle('/health')).json()

    expect(during).toEqual(expect.objectContaining({ syncing: true }))
    expect(after).toEqual(expect.objectContaining({ syncing: false }))
  })
})

describe('POST /sync when the Sync itself fails', () => {
  test('logs the failure and ends the Sync', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    testApp = createTestApp({
      clock: () => {
        throw new Error('clock broke')
      },
    })

    const response = await sync()

    expect(response.status).toBe(202)
    expect(error).toHaveBeenCalledWith('Sync failed:', new Error('clock broke'))
    error.mockRestore()
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

    expect(response.status).toBe(202)
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
