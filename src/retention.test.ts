import type { QueryOperation } from '~/hosts'
import type { FakeHost } from '~/testing/fakeHost'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import {
  createFakeHost,
  createFakeHostRoot,
  createFakeTransport,
} from '~/testing/fakeHost'

type Hit = { host: string; threadId: string; archived: boolean }

let hive: FakeHost
let crefil: FakeHost
let queries: { label: string; operation: QueryOperation }[]
let app: ReturnType<typeof createApp>

beforeEach(() => {
  const root = createFakeHostRoot()
  hive = createFakeHost(root, 'hive')
  crefil = createFakeHost(root, 'crefil')
  queries = []
  app = createApp({
    database: new Database(':memory:', { strict: true }),
    hosts: [
      { label: 'hive', destination: 'adwin@hive' },
      { label: 'crefil', destination: 'a.ying@crefil' },
    ],
    transport: createFakeTransport(root, (label, operation) =>
      queries.push({ label, operation }),
    ),
    clock: () => new Date('2026-11-14T00:00:00Z'),
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
  hive.addMessage({
    id: 'item-2',
    threadId: 'thread-1',
    ordinal: 2,
    role: 'assistant',
    text: 'The session cookie is missing SameSite.',
    updatedAt: '2026-11-01T00:00:02.000Z',
  })
})

const sync = () =>
  app.handle(new Request('http://localhost/sync', { method: 'POST' }))

const search = async (q: string) => {
  const response = await app.handle(
    new Request(`http://localhost/search?q=${encodeURIComponent(q)}`),
  )
  expect(response.status).toBe(200)
  const { hits } = (await response.json()) as { hits: Hit[] }
  return hits
}

const threadFetches = () =>
  queries.filter(({ operation }) => operation === 'threads')

describe('a soft-deleted Thread', () => {
  test('disappears after the next Sync and is not re-pulled', async () => {
    await sync()
    hive.deleteThread('thread-1', '2026-11-05T00:00:00.000Z')

    await sync()

    expect(await search('redirect loop')).toEqual([])

    queries = []
    await sync()

    expect(threadFetches()).toEqual([])
    expect(await search('redirect loop')).toEqual([])
  })
})

describe('a Thread missing from its Host list', () => {
  test('stays searchable', async () => {
    await sync()
    hive.purgeThread('thread-1')

    await sync()

    expect(await search('redirect loop')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
  })
})

describe('an archived Thread', () => {
  test('stays searchable and is flagged', async () => {
    await sync()
    hive.archiveThread('thread-1', '2026-11-05T00:00:00.000Z')

    await sync()

    expect(await search('redirect loop')).toEqual([
      expect.objectContaining({ threadId: 'thread-1', archived: true }),
    ])
  })
})

describe('one Thread ID on two Hosts', () => {
  test('is archived as two independent Threads', async () => {
    crefil.addThread({
      id: 'thread-1',
      title: 'Fix login (transferred)',
      updatedAt: '2026-11-02T00:00:00.000Z',
    })
    crefil.addMessage({
      id: 'item-1',
      threadId: 'thread-1',
      ordinal: 1,
      role: 'user',
      text: 'Why does the login redirect loop on crefil?',
      updatedAt: '2026-11-02T00:00:01.000Z',
    })
    await sync()

    const hits = await search('redirect loop')
    expect(hits).toHaveLength(2)
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
        expect.objectContaining({ host: 'crefil', threadId: 'thread-1' }),
      ]),
    )

    hive.deleteThread('thread-1', '2026-11-05T00:00:00.000Z')
    await sync()

    expect(await search('redirect loop')).toEqual([
      expect.objectContaining({ host: 'crefil', threadId: 'thread-1' }),
    ])
  })
})

describe('a re-pulled Thread', () => {
  test('drops Items its Host no longer reports', async () => {
    await sync()
    hive.removeItem('item-2')
    hive.addMessage({
      id: 'item-3',
      threadId: 'thread-1',
      ordinal: 2,
      role: 'assistant',
      text: 'Rewound and answered again.',
      updatedAt: '2026-11-05T00:00:00.000Z',
    })

    await sync()

    expect(await search('samesite')).toEqual([])
    expect(await search('answered again')).toEqual([
      expect.objectContaining({ threadId: 'thread-1' }),
    ])
  })
})
