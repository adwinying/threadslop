import type { FakeHost } from '~/testing/fakeHost'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import {
  createFakeHost,
  createFakeHostRoot,
  createFakeTransport,
} from '~/testing/fakeHost'

type Hit = { host: string; threadId: string; snippet: string }

let hive: FakeHost
let app: ReturnType<typeof createApp>

beforeEach(() => {
  const root = createFakeHostRoot()
  hive = createFakeHost(root, 'hive')
  app = createApp({
    database: new Database(':memory:', { strict: true }),
    hosts: [{ label: 'hive', destination: 'adwin@hive' }],
    transport: createFakeTransport(root),
    clock: () => new Date('2026-11-14T00:00:00Z'),
  })

  hive.addThread({
    id: 'thread-1',
    title: 'Deploy nas',
    updatedAt: '2026-11-01T00:00:00.000Z',
  })
  hive.addMessage({
    id: 'item-1',
    threadId: 'thread-1',
    ordinal: 10,
    role: 'user',
    text: 'Check the disk usage on nas',
    updatedAt: '2026-11-01T00:00:01.000Z',
  })
  hive.addItem({
    id: 'item-2',
    threadId: 'thread-1',
    ordinal: 20,
    type: 'command_execution',
    updatedAt: '2026-11-01T00:00:02.000Z',
    input: 'df -h /volume1',
    output: 'Filesystem Size Used Avail\n/dev/md2 7.3T 5.1T 2.2T',
    exitCode: 0,
  })
})

const get = (path: string) => app.handle(new Request(`http://localhost${path}`))

const sync = () =>
  app.handle(new Request('http://localhost/sync', { method: 'POST' }))

const search = async (q: string, items?: 'messages' | 'all') => {
  const params = new URLSearchParams({ q, ...(items && { items }) })
  const response = await get(`/search?${params}`)
  expect(response.status).toBe(200)
  const { hits } = (await response.json()) as { hits: Hit[] }
  return hits
}

describe('GET /search?items=', () => {
  test('searches Messages only by default and every Item with items=all', async () => {
    await sync()

    expect(await search('/dev/md2')).toEqual([])
    expect(await search('/dev/md2', 'messages')).toEqual([])
    expect(await search('/dev/md2', 'all')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
    expect(await search('disk usage', 'all')).toEqual([
      expect.objectContaining({ host: 'hive', threadId: 'thread-1' }),
    ])
  })
})

describe('GET /search?items=all by Item type', () => {
  beforeEach(() => {
    const item = { threadId: 'thread-1', updatedAt: '2026-11-01T00:00:03.000Z' }
    hive.addItem({
      ...item,
      id: 'reasoning-1',
      ordinal: 30,
      type: 'reasoning',
      text: 'Considering the kopia schedule',
      streaming: false,
    })
    hive.addItem({
      ...item,
      id: 'tool-1',
      ordinal: 40,
      type: 'dynamic_tool',
      toolName: 'mcp__kody__execute',
      input: { code: 'kody.listSecrets()' },
      output: { content: [{ type: 'text', text: 'three secrets found' }] },
    })
    hive.addItem({
      ...item,
      id: 'file-1',
      ordinal: 50,
      type: 'file_change',
      fileName: 'src/archive.ts',
      changes: [{ operation: 'add', path: 'src/snapshot.ts' }],
      diffStr: '+  db.run(`VACUUM INTO ${target}`)',
    })
    hive.addItem({
      ...item,
      id: 'web-1',
      ordinal: 60,
      type: 'web_search',
      patterns: ['bun sqlite backup api'],
      results: [{ url: 'https://example.com', title: 'Unrelated result' }],
    })
    hive.addThread({
      id: 'thread-2',
      title: 'Checkpoints',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    hive.addItem({
      ...item,
      threadId: 'thread-2',
      id: 'unknown-1',
      ordinal: 10,
      type: 'hologram',
      files: [{ path: 'src/zebra.ts', kind: 'modified' }],
    })
  })

  test.each([
    ['a command', 'df -h /volume1'],
    ['command output', '5.1T 2.2T'],
    ['reasoning', 'kopia schedule'],
    ['a tool name', 'mcp__kody__execute'],
    ['tool input', 'kody.listSecrets()'],
    ['tool output', 'three secrets found'],
    ['a changed file', 'src/snapshot.ts'],
    ['a diff', 'VACUUM INTO'],
    ['a web search query', 'sqlite backup api'],
  ])('finds %s', async (_, keyword) => {
    await sync()

    expect(await search(keyword, 'all')).toEqual([
      expect.objectContaining({ threadId: 'thread-1' }),
    ])
  })

  test('skips web search results', async () => {
    await sync()

    expect(await search('Unrelated result', 'all')).toEqual([])
  })

  test('finds an unknown Item type through its raw payload', async () => {
    await sync()

    expect(await search('src/zebra.ts', 'all')).toEqual([
      expect.objectContaining({ threadId: 'thread-2' }),
    ])
    expect(await search('"startedAt"', 'all')).toEqual([
      expect.objectContaining({ threadId: 'thread-2' }),
    ])
  })
})

describe('GET /search on a large Item', () => {
  test('finds a keyword near the end of a 100KB command output', async () => {
    hive.addItem({
      id: 'item-large',
      threadId: 'thread-1',
      ordinal: 30,
      type: 'command_execution',
      updatedAt: '2026-11-01T00:00:03.000Z',
      input: 'journalctl -u threadslop',
      output: `${'nothing to see here\n'.repeat(5000)}panic: database is locked\n`,
    })

    await sync()

    expect(await search('database is locked', 'all')).toEqual([
      expect.objectContaining({ threadId: 'thread-1' }),
    ])
  })
})

const getThread = (host: string, id: string, items?: 'messages' | 'all') =>
  get(
    `/threads/${host}/${encodeURIComponent(id)}${items ? `?items=${items}` : ''}`,
  )

describe('GET /threads/:host/:threadId', () => {
  const threadId = 'thread:delegated-task:command%3Amcp%3Aabc'

  beforeEach(() => {
    hive.addThread({
      id: threadId,
      title: 'Investigate auth',
      updatedAt: '2026-11-02T00:00:00.000Z',
    })
    // Inserted out of order; ordinals are sparse.
    hive.addMessage({
      id: 'reply',
      threadId,
      ordinal: 72_000_010,
      role: 'assistant',
      text: 'The token expired.',
      updatedAt: '2026-11-02T00:00:03.000Z',
    })
    hive.addItem({
      id: 'command',
      threadId,
      ordinal: 5_000,
      type: 'command_execution',
      updatedAt: '2026-11-02T00:00:02.000Z',
      input: 'cat auth.log',
      output: 'token expired at 12:00',
    })
    hive.addMessage({
      id: 'question',
      threadId,
      ordinal: 1,
      role: 'user',
      text: 'Why did auth fail?',
      updatedAt: '2026-11-02T00:00:01.000Z',
    })
  })

  test('returns the Thread and its Messages in ordinal order by default', async () => {
    await sync()

    const response = await getThread('hive', threadId)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      thread: expect.objectContaining({
        host: 'hive',
        id: threadId,
        title: 'Investigate auth',
        projectTitle: 'threadslop',
        archivedAt: null,
      }),
      items: [
        expect.objectContaining({
          id: 'question',
          type: 'user_message',
          role: 'user',
          text: 'Why did auth fail?',
        }),
        expect.objectContaining({
          id: 'reply',
          type: 'assistant_message',
          role: 'assistant',
          text: 'The token expired.',
        }),
      ],
    })
  })

  test('returns every Item in ordinal order with items=all', async () => {
    await sync()

    const response = await getThread('hive', threadId, 'all')

    const { items } = (await response.json()) as {
      items: { id: string; role: string | null; text: string }[]
    }
    expect(items.map(({ id }) => id)).toEqual(['question', 'command', 'reply'])
    expect(items[1]).toEqual(
      expect.objectContaining({
        role: null,
        text: 'cat auth.log\ntoken expired at 12:00',
      }),
    )
  })

  test('responds 404 for an unknown Thread', async () => {
    await sync()

    expect((await getThread('hive', 'no-such-thread')).status).toBe(404)
    expect((await getThread('crefil', threadId)).status).toBe(404)
  })

  test('responds 404 once the Thread is deleted on its Host', async () => {
    await sync()
    hive.deleteThread(threadId, '2026-11-03T00:00:00.000Z')

    await sync()

    expect((await getThread('hive', threadId)).status).toBe(404)
  })
})
