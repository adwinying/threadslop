import type { FakeGemini } from '~/testing/fakeGemini'
import { beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createFakeGemini } from '~/testing/fakeGemini'
import { createFakeHost, createTestApp, testNow } from '~/testing/fakeHost'

let gemini: FakeGemini
let testApp: ReturnType<typeof createTestApp>

beforeEach(() => {
  gemini = createFakeGemini()
  testApp = createTestApp({ hosts: [], fetch: gemini.fetch })
  gemini.storeSession(testApp.root)

  gemini.putChat({
    id: '8f1e2d3c4b5a6978',
    title: 'Sourdough starter',
    updatedAt: '2026-11-02T09:00:00.000Z',
    turns: [
      {
        responseId: 'r_first',
        prompt: 'How often should I feed a sourdough starter?',
        reply: 'Feed it **once a day** at room temperature.',
        at: '2026-11-01T08:00:00.000Z',
      },
      {
        responseId: 'r_second',
        prompt: 'And in the fridge?',
        reply: 'Once a week is enough.',
        at: '2026-11-02T09:00:00.000Z',
      },
    ],
  })
})

const sync = () => testApp.sync()

const getJson = async (path: string) => {
  const response = await testApp.handle(path)
  expect(response.status).toBe(200)
  return response.json()
}

describe('POST /sync with a Gemini session', () => {
  test('archives each chat as a Gemini Thread of its prompts and replies', async () => {
    await sync()

    expect(await getJson('/threads/gemini/8f1e2d3c4b5a6978')).toEqual({
      thread: {
        host: 'gemini',
        id: '8f1e2d3c4b5a6978',
        title: 'Sourdough starter',
        projectTitle: null,
        workspaceRoot: null,
        createdAt: '2026-11-01T08:00:00.000Z',
        updatedAt: '2026-11-02T09:00:00.000Z',
        archivedAt: null,
        archived: false,
      },
      items: [
        expect.objectContaining({
          id: 'r_first:user_message',
          type: 'user_message',
          role: 'user',
          status: 'completed',
          text: 'How often should I feed a sourdough starter?',
          payload: JSON.stringify({
            text: 'How often should I feed a sourdough starter?',
          }),
          createdAt: '2026-11-01T08:00:00.000Z',
          completedAt: '2026-11-01T08:00:00.000Z',
          updatedAt: '2026-11-01T08:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'r_first:assistant_message',
          role: 'assistant',
          text: 'Feed it **once a day** at room temperature.',
        }),
        expect.objectContaining({
          id: 'r_second:user_message',
          text: 'And in the fridge?',
          createdAt: '2026-11-02T09:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'r_second:assistant_message',
          text: 'Once a week is enough.',
        }),
      ],
    })
  })
})

describe('GET /search after a Gemini Sync', () => {
  test('a hit links to the chat in the Gemini web app', async () => {
    await sync()

    expect(await getJson('/search?q=fridge&host=gemini')).toEqual({
      hits: [
        {
          host: 'gemini',
          environmentId: null,
          threadId: '8f1e2d3c4b5a6978',
          threadTitle: 'Sourdough starter',
          project: null,
          itemType: 'user_message',
          role: 'user',
          snippet: 'And in the «fridge»?',
          createdAt: '2026-11-02T09:00:00.000Z',
          archived: false,
          link: 'https://gemini.google.com/app/8f1e2d3c4b5a6978',
        },
      ],
    })
  })
})

describe('POST /sync again', () => {
  test('re-reads only chats whose listed last update changed', async () => {
    gemini.putChat({
      id: 'a1b2c3d4e5f60718',
      title: 'Tokyo trip',
      updatedAt: '2026-11-03T00:00:00.000Z',
      turns: [
        {
          responseId: 'r_tokyo',
          prompt: 'Best ramen near Shinjuku?',
          reply: 'Try Fuunji for tsukemen.',
          at: '2026-11-03T00:00:00.000Z',
        },
      ],
    })
    await sync()
    gemini.requests.length = 0
    gemini.putChat({
      id: 'a1b2c3d4e5f60718',
      title: 'Tokyo trip',
      updatedAt: '2026-11-04T00:00:00.000Z',
      turns: [
        {
          responseId: 'r_tokyo',
          prompt: 'Best ramen near Shinjuku?',
          reply: 'Try Fuunji for tsukemen.',
          at: '2026-11-03T00:00:00.000Z',
        },
        {
          responseId: 'r_tokyo_2',
          prompt: 'Is it open on Sundays?',
          reply: 'Yes, from 11:00.',
          at: '2026-11-04T00:00:00.000Z',
        },
      ],
    })

    await sync()

    expect(gemini.reads()).toEqual(['a1b2c3d4e5f60718'])
    expect(await getJson('/search?q=sundays')).toEqual({
      hits: [expect.objectContaining({ threadId: 'a1b2c3d4e5f60718' })],
    })
  })

  test('keeps a chat that is no longer listed', async () => {
    await sync()
    gemini.removeChat('8f1e2d3c4b5a6978')

    await sync()

    expect(await getJson('/search?q=fridge')).toEqual({
      hits: [expect.objectContaining({ threadId: '8f1e2d3c4b5a6978' })],
    })
  })
})

const health = () => getJson('/health')

const geminiRow = async () =>
  z
    .object({ hosts: z.array(z.object({ host: z.string() }).loose()) })
    .parse(await health())
    .hosts.find(({ host }) => host === 'gemini')

describe('GET /health', () => {
  test('lists gemini after the Hosts with its last success', async () => {
    testApp = createTestApp({ hosts: ['hive'], fetch: gemini.fetch })
    gemini.storeSession(testApp.root)
    createFakeHost(testApp.root, 'hive')

    await sync()

    expect(await health()).toEqual({
      syncing: false,
      hosts: [
        expect.objectContaining({ host: 'hive' }),
        {
          host: 'gemini',
          environmentId: null,
          lastSuccessAt: testNow.toISOString(),
          lastError: null,
          lastErrorAt: null,
        },
      ],
    })
  })

  test('omits gemini and Gemini is never reached without a session', async () => {
    testApp = createTestApp({ hosts: [], fetch: gemini.fetch })

    await sync()

    expect(await health()).toEqual({ syncing: false, hosts: [] })
    expect(gemini.requests).toEqual([])
  })
})

const minutesBeforeNow = (minutes: number) =>
  new Date(+testNow - minutes * 60_000)

describe('POST /sync and the Google session', () => {
  test('rotates the cookies when the last rotation is 10 minutes old', async () => {
    gemini.storeSession(testApp.root, { rotatedAt: minutesBeforeNow(10) })

    await sync()

    expect(gemini.rotations()).toBe(1)
  })

  test("doesn't rotate within 10 minutes of the last rotation", async () => {
    gemini.storeSession(testApp.root, { rotatedAt: minutesBeforeNow(9.99) })

    await sync()

    expect(gemini.rotations()).toBe(0)
  })

  test('uses rotated cookies for the next request and the next Sync', async () => {
    await sync()
    await sync()

    expect(gemini.rotations()).toBe(1)
    expect(await geminiRow()).toEqual(
      expect.objectContaining({ lastError: null }),
    )
  })

  test('keeps cookies any Google response sets', async () => {
    gemini.storeSession(testApp.root, { rotatedAt: testNow })
    gemini.issueCookie('__Secure-1PSIDTS', 'refreshed-by-app-page')

    await sync()
    await sync()

    expect(gemini.rotations()).toBe(0)
    expect(await geminiRow()).toEqual(
      expect.objectContaining({ lastError: null }),
    )
  })

  test('Syncs on when Google refuses a rotation', async () => {
    gemini.refuseRotations()

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({ lastError: null }),
    )
    expect(await getJson('/search?q=fridge')).toEqual({
      hits: [expect.objectContaining({ threadId: '8f1e2d3c4b5a6978' })],
    })
  })

  test('keeps the session store readable by its owner only', async () => {
    chmodSync(join(testApp.root, 'gemini-session.json'), 0o644)

    await sync()

    expect(gemini.rotations()).toBe(1)
    expect(
      statSync(join(testApp.root, 'gemini-session.json')).mode & 0o777,
    ).toBe(0o600)
  })
})

describe('POST /sync when Gemini fails', () => {
  test('records a signed-out session as a failure', async () => {
    gemini.signOut()

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastSuccessAt: null,
        lastError: 'signed out; run install-gemini',
        lastErrorAt: testNow.toISOString(),
      }),
    )
  })

  test('records a throttled answer as a failure and keeps archived Items', async () => {
    await sync()
    gemini.putChat({
      id: '8f1e2d3c4b5a6978',
      title: 'Sourdough starter',
      updatedAt: '2026-11-05T00:00:00.000Z',
      turns: [],
    })
    gemini.throttle()

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastError: 'Gemini answered MaZiqc without a result; throttled?',
      }),
    )
    expect(await getJson('/search?q=fridge')).toEqual({
      hits: [expect.objectContaining({ threadId: '8f1e2d3c4b5a6978' })],
    })
  })

  test('still syncs the Hosts', async () => {
    testApp = createTestApp({ hosts: ['hive'], fetch: gemini.fetch })
    gemini.storeSession(testApp.root)
    const hive = createFakeHost(testApp.root, 'hive')
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
    gemini.signOut()

    await sync()

    expect(await getJson('/search?q=redirect')).toEqual({
      hits: [expect.objectContaining({ host: 'hive' })],
    })
    expect(await health()).toEqual({
      syncing: false,
      hosts: [
        expect.objectContaining({ host: 'hive', lastError: null }),
        expect.objectContaining({ host: 'gemini', lastSuccessAt: null }),
      ],
    })
  })
})
