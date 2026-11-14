import type { FakeHost } from '~/testing/fakeHost'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createFakeHost, createTestApp } from '~/testing/fakeHost'

type Hit = { host: string; threadId: string; snippet: string }

let hive: FakeHost
let crefil: FakeHost
let testApp: ReturnType<typeof createTestApp>

beforeEach(() => {
  testApp = createTestApp({ hosts: ['hive', 'crefil'] })
  hive = createFakeHost(testApp.root, 'hive')
  crefil = createFakeHost(testApp.root, 'crefil')

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
  crefil.addThread({
    id: 'thread:delegated-task:command%3Amcp%3Aabc',
    title: '認証の調査',
    updatedAt: '2026-11-02T00:00:00.000Z',
  })
  crefil.addMessage({
    id: 'turn-item:message:1',
    threadId: 'thread:delegated-task:command%3Amcp%3Aabc',
    ordinal: 1,
    role: 'user',
    text: '認証エラーの原因を調べて',
    updatedAt: '2026-11-02T00:00:01.000Z',
  })
})

const sync = () => testApp.sync()

const search = async (q: string) => {
  const response = await testApp.handle(`/search?q=${encodeURIComponent(q)}`)
  expect(response.status).toBe(200)
  const { hits } = (await response.json()) as { hits: Hit[] }
  return hits
}

const threadFetches = () =>
  testApp.queries.filter(({ operation }) => operation === 'threads')

describe('POST /sync', () => {
  test('a first Sync archives every Message so /search finds them', async () => {
    const response = await sync()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hosts: [
        { host: 'hive', ok: true, threadsPulled: 1, threadsSkipped: 0 },
        { host: 'crefil', ok: true, threadsPulled: 1, threadsSkipped: 0 },
      ],
    })
    expect(await search('redirect loop')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
    expect(await search('samesite')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
    expect(await search('認証エラー')).toEqual([
      expect.objectContaining({
        host: 'crefil',
        threadId: 'thread:delegated-task:command%3Amcp%3Aabc',
      }),
    ])
  })
})

describe('POST /sync again', () => {
  test('fetches no Threads when nothing changed', async () => {
    await sync()
    testApp.queries.length = 0

    const response = await sync()

    expect(await response.json()).toEqual({
      hosts: [
        { host: 'hive', ok: true, threadsPulled: 0, threadsSkipped: 0 },
        { host: 'crefil', ok: true, threadsPulled: 0, threadsSkipped: 0 },
      ],
    })
    expect(threadFetches()).toEqual([])
  })
})

describe('POST /sync after a Host changes', () => {
  test('re-pulls an edited Thread so search reflects the edit', async () => {
    await sync()
    testApp.queries.length = 0
    hive.editMessage({
      id: 'item-2',
      threadId: 'thread-1',
      ordinal: 2,
      role: 'assistant',
      text: 'The session cookie expired too early.',
      updatedAt: '2026-11-03T00:00:00.000Z',
    })

    await sync()

    expect(threadFetches()).toEqual([{ label: 'hive', operation: 'threads' }])
    expect(await search('samesite')).toEqual([])
    expect(await search('expired too early')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
  })

  test('re-pulls a fork that adds Items with old timestamps', async () => {
    await sync()
    testApp.queries.length = 0
    hive.addMessage({
      id: 'item-forked',
      threadId: 'thread-1',
      ordinal: 3,
      role: 'user',
      text: 'Imported from the parent Thread',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    await sync()

    expect(threadFetches()).toEqual([{ label: 'hive', operation: 'threads' }])
    expect(await search('parent thread')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
  })
})

describe('POST /sync on a large Host', () => {
  test('fetches changed Threads in batches', async () => {
    for (const n of [2, 3, 4]) {
      const threadId = `thread-${n}`
      hive.addThread({
        id: threadId,
        title: `Long Thread ${n}`,
        updatedAt: '2026-11-01T00:00:00.000Z',
      })
      for (let ordinal = 1; ordinal <= 400; ordinal++) {
        hive.addMessage({
          id: `${threadId}-item-${ordinal}`,
          threadId,
          ordinal,
          role: 'assistant',
          text: `Step ${ordinal} of thread number ${n}`,
          updatedAt: '2026-11-01T00:00:00.000Z',
        })
      }
    }

    await sync()

    const hiveFetches = threadFetches().filter(({ label }) => label === 'hive')
    expect(hiveFetches.length).toBeGreaterThan(1)
    for (const n of [2, 3, 4]) {
      expect(await search(`Step 400 of thread number ${n}`)).toEqual([
        expect.objectContaining({ threadId: `thread-${n}` }),
      ])
    }
  })
})

describe('POST /sync with an unsafe Thread ID', () => {
  test('skips that Thread and syncs the rest of its Host', async () => {
    hive.addThread({
      id: 'thread 2',
      title: 'Unsafe',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    hive.addMessage({
      id: 'item-unsafe',
      threadId: 'thread 2',
      ordinal: 1,
      role: 'user',
      text: 'Never fetched',
      updatedAt: '2026-11-01T00:00:01.000Z',
    })

    const response = await sync()

    expect(await response.json()).toEqual({
      hosts: [
        { host: 'hive', ok: true, threadsPulled: 1, threadsSkipped: 1 },
        { host: 'crefil', ok: true, threadsPulled: 1, threadsSkipped: 0 },
      ],
    })
    expect(await search('redirect loop')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
    expect(await search('never fetched')).toEqual([])
  })
})
