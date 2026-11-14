import type { FakeHost } from '~/testing/fakeHost'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import {
  createFakeHost,
  createFakeHostRoot,
  createFakeTransport,
} from '~/testing/fakeHost'

const delegatedThreadId = 'thread:delegated-task:command%3Amcp%3Aabc'

let hive: FakeHost
let crefil: FakeHost
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const root = createFakeHostRoot()
  hive = createFakeHost(root, 'hive')
  crefil = createFakeHost(root, 'crefil')
  app = createApp({
    database: new Database(':memory:', { strict: true }),
    hosts: [
      { label: 'hive', destination: 'adwin@hive' },
      { label: 'crefil', destination: 'a.ying@crefil' },
    ],
    transport: createFakeTransport(root),
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
  crefil.addThread({
    id: delegatedThreadId,
    title: '認証の調査',
    updatedAt: '2026-11-02T00:00:00.000Z',
  })
  crefil.addMessage({
    id: 'turn-item:message:1',
    threadId: delegatedThreadId,
    ordinal: 1,
    role: 'user',
    text: '認証エラーの原因を調べて',
    updatedAt: '2026-11-02T00:00:01.000Z',
  })

  await sync()
})

const sync = () =>
  app.handle(new Request('http://localhost/sync', { method: 'POST' }))

const get = (query: Record<string, string>) =>
  app.handle(
    new Request(`http://localhost/search?${new URLSearchParams(query)}`),
  )

const search = async (query: Record<string, string>) => {
  const response = await get(query)
  expect(response.status).toBe(200)
  const { hits } = (await response.json()) as { hits: unknown[] }
  return hits
}

describe('GET /search', () => {
  test('a hit tells where the Message lives and links to it in T3', async () => {
    expect(await search({ q: 'redirect loop' })).toEqual([
      {
        host: 'hive',
        environmentId: hive.environmentId,
        threadId: 'thread-1',
        threadTitle: 'Fix login',
        project: 'threadslop',
        itemType: 'user_message',
        role: 'user',
        snippet: 'Why does the login «redirect loop»?',
        createdAt: '2026-11-01T00:00:01.000Z',
        archived: false,
        link: `t3-thread://v2/${hive.environmentId}/thread-1`,
      },
    ])
  })

  test('a 2-character Japanese query matches by substring', async () => {
    expect(await search({ q: '認証' })).toEqual([
      expect.objectContaining({
        host: 'crefil',
        threadId: delegatedThreadId,
        snippet: '«認証»エラーの原因を調べて',
      }),
    ])
  })

  test.each(['認証エラー', '認証'])(
    'host= limits %p to that Host',
    async (q) => {
      hive.addMessage({
        id: 'item-2',
        threadId: 'thread-1',
        ordinal: 2,
        role: 'assistant',
        text: 'ログインの認証エラーです',
        updatedAt: '2026-11-03T00:00:00.000Z',
      })
      await sync()

      expect(await search({ q })).toHaveLength(2)
      expect(await search({ q, host: 'hive' })).toEqual([
        expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
      ])
    },
  )

  test('a short query returns the newest hits up to limit=', async () => {
    hive.addMessage({
      id: 'item-2',
      threadId: 'thread-1',
      ordinal: 2,
      role: 'assistant',
      text: `${'前置き'.repeat(20)}認証は通っています${'後書き'.repeat(20)}`,
      updatedAt: '2026-11-03T00:00:00.000Z',
    })
    await sync()

    expect(await search({ q: '認証', limit: '1' })).toEqual([
      expect.objectContaining({
        host: 'hive',
        role: 'assistant',
        snippet: `…${'前置き'.repeat(10)}«認証»は通っています${'後書き'.repeat(7)}後書…`,
      }),
    ])
  })

  test('rejects a limit= over the maximum', async () => {
    expect((await get({ q: 'login', limit: '101' })).status).toBe(422)
  })

  test.each([
    'login OR 認証エラー',
    'redi*',
    '"redirect',
    'NEAR(login loop)',
    '%',
    '_',
  ])('treats %p as literal text', async (q) => {
    expect(await search({ q })).toEqual([])
  })
})
