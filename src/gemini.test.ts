import type { ChatFixture, FakeGemini } from '~/testing/fakeGemini'
import { beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createFakeGemini } from '~/testing/fakeGemini'
import { createFakeHost, createTestApp, testNow } from '~/testing/fakeHost'

const sourdough: ChatFixture = {
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
}

let gemini: FakeGemini
let testApp: ReturnType<typeof createTestApp>

beforeEach(() => {
  gemini = createFakeGemini()
  testApp = createTestApp({ hosts: [], fetch: gemini.fetch })
  gemini.storeSession(testApp.root)

  gemini.putChat(sourdough)
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
          id: '8f1e2d3c4b5a6978:r_first:user_message',
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
          id: '8f1e2d3c4b5a6978:r_first:assistant_message',
          role: 'assistant',
          text: 'Feed it **once a day** at room temperature.',
        }),
        expect.objectContaining({
          id: '8f1e2d3c4b5a6978:r_second:user_message',
          text: 'And in the fridge?',
          createdAt: '2026-11-02T09:00:00.000Z',
        }),
        expect.objectContaining({
          id: '8f1e2d3c4b5a6978:r_second:assistant_message',
          text: 'Once a week is enough.',
        }),
      ],
    })
  })
})

test('POST /sync archives a turn Gemini never answered as its prompt alone', async () => {
  gemini.putChat({
    id: '4d5e6f7081920314',
    title: 'Interrupted',
    updatedAt: '2026-11-07T10:00:00.000Z',
    turns: [
      {
        responseId: 'r_stopped',
        prompt: 'Summarise this paper.',
        reply: '',
        at: '2026-11-07T10:00:00.000Z',
      },
    ],
  })

  await sync()

  expect(await getJson('/threads/gemini/4d5e6f7081920314?items=all')).toEqual({
    thread: expect.anything(),
    items: [
      expect.objectContaining({
        id: '4d5e6f7081920314:r_stopped:user_message',
      }),
    ],
  })
})

test('POST /sync keeps two chats apart when their turns share a response ID', async () => {
  gemini.putChat({
    id: '6f708192031425ab',
    title: 'Rye starter',
    updatedAt: '2026-11-09T10:00:00.000Z',
    turns: [{ ...sourdough.turns[0], prompt: 'And a rye starter?' }],
  })

  await sync()

  expect(await messageTexts(sourdough.id)).toContain(
    'How often should I feed a sourdough starter?',
  )
  expect(await messageTexts('6f708192031425ab')).toContain('And a rye starter?')
})

describe('POST /sync with a turn that has reasoning', () => {
  beforeEach(() => {
    gemini.putChat({
      id: '0f9e8d7c6b5a4321',
      title: 'Prime sieve',
      updatedAt: '2026-11-03T10:00:00.000Z',
      turns: [
        {
          responseId: 'r_sieve',
          prompt: 'Fastest way to list primes below a million?',
          reasoning: 'Trial division is too slow; Eratosthenes fits.',
          reply: 'Use the sieve of Eratosthenes.',
          at: '2026-11-03T10:00:00.000Z',
        },
      ],
    })
  })

  test('archives the reasoning between the prompt and the reply', async () => {
    await sync()

    expect(await getJson('/threads/gemini/0f9e8d7c6b5a4321?items=all')).toEqual(
      {
        thread: expect.anything(),
        items: [
          expect.objectContaining({
            id: '0f9e8d7c6b5a4321:r_sieve:user_message',
          }),
          expect.objectContaining({
            id: '0f9e8d7c6b5a4321:r_sieve:reasoning',
            type: 'reasoning',
            role: null,
            text: 'Trial division is too slow; Eratosthenes fits.',
          }),
          expect.objectContaining({
            id: '0f9e8d7c6b5a4321:r_sieve:assistant_message',
          }),
        ],
      },
    )
  })

  test('search finds the reasoning only with items=all', async () => {
    await sync()

    expect(await getJson('/search?q=trial division')).toEqual({ hits: [] })
    expect(await getJson('/search?q=trial division&items=all')).toEqual({
      hits: [expect.objectContaining({ itemType: 'reasoning' })],
    })
  })
})

describe('POST /sync with a reply that cites sources', () => {
  beforeEach(() => {
    gemini.putChat({
      id: '1a2b3c4d5e6f7081',
      title: 'Bread hydration',
      updatedAt: '2026-11-04T10:00:00.000Z',
      turns: [
        {
          responseId: 'r_hydration',
          prompt: 'What hydration suits a beginner loaf?',
          reasoning: 'Lower hydration is easier to shape.',
          reply: 'Start around 70%.',
          sources: [
            {
              url: 'https://www.kingarthurbaking.com/blog/hydration',
              title: 'Baker’s percentages explained',
            },
            { url: 'https://example.org/untitled-crumb-guide' },
          ],
          at: '2026-11-04T10:00:00.000Z',
        },
      ],
    })
  })

  test('archives the sources after the reply', async () => {
    await sync()

    expect(await getJson('/threads/gemini/1a2b3c4d5e6f7081?items=all')).toEqual(
      {
        thread: expect.anything(),
        items: [
          expect.objectContaining({ type: 'user_message' }),
          expect.objectContaining({ type: 'reasoning' }),
          expect.objectContaining({ type: 'assistant_message' }),
          expect.objectContaining({
            id: '1a2b3c4d5e6f7081:r_hydration:web_sources',
            type: 'web_sources',
            role: null,
            payload: JSON.stringify({
              sources: [
                {
                  url: 'https://www.kingarthurbaking.com/blog/hydration',
                  title: 'Baker’s percentages explained',
                },
                { url: 'https://example.org/untitled-crumb-guide' },
              ],
            }),
          }),
        ],
      },
    )
  })

  test('search finds sources by title and URL only with items=all', async () => {
    await sync()

    expect(await getJson('/search?q=percentages')).toEqual({ hits: [] })
    expect(await getJson('/search?q=percentages&items=all')).toEqual({
      hits: [expect.objectContaining({ itemType: 'web_sources' })],
    })
    expect(await getJson('/search?q=crumb-guide&items=all')).toEqual({
      hits: [expect.objectContaining({ itemType: 'web_sources' })],
    })
  })
})

const messageTexts = async (threadId: string) =>
  z
    .object({ items: z.array(z.object({ text: z.string() }).loose()) })
    .parse(await getJson(`/threads/gemini/${threadId}`))
    .items.map(({ text }) => text)

describe('POST /sync with images', () => {
  test('appends uploaded images to the prompt as Markdown images', async () => {
    gemini.putChat({
      id: '2b3c4d5e6f708192',
      title: 'Plant ID',
      updatedAt: '2026-11-05T10:00:00.000Z',
      turns: [
        {
          responseId: 'r_plant',
          prompt: 'What plant is this?',
          uploads: [
            {
              filename: 'leaf.jpg',
              url: 'https://lh3.googleusercontent.com/gg/leaf-token',
            },
            {
              filename: 'pot.png',
              url: 'https://lh3.googleusercontent.com/gg/pot-token',
              slot: 4,
            },
          ],
          reply: 'A pothos.',
          at: '2026-11-05T10:00:00.000Z',
        },
      ],
    })

    await sync()

    expect(await messageTexts('2b3c4d5e6f708192')).toEqual([
      'What plant is this?\n\n' +
        '![leaf.jpg](https://lh3.googleusercontent.com/gg/leaf-token)\n' +
        '![pot.png](https://lh3.googleusercontent.com/gg/pot-token)',
      'A pothos.',
    ])
  })

  test('keeps the prompt of a turn whose upload entry holds no image', async () => {
    gemini.putChat({
      id: '0aea7f7c8466dc9c',
      title: 'Lost upload',
      updatedAt: '2026-04-29T13:14:32.000Z',
      turns: [
        {
          responseId: 'r_lost',
          prompt: 'What does this say?',
          uploads: [null],
          reply: 'I can’t see an attachment.',
          at: '2026-04-29T13:14:32.000Z',
        },
      ],
    })

    await sync()

    expect(await messageTexts('0aea7f7c8466dc9c')).toEqual([
      'What does this say?',
      'I can’t see an attachment.',
    ])
  })

  test('names an uploaded file that is not an image', async () => {
    gemini.putChat({
      id: '3e95b801154ef468',
      title: 'Flashing logs',
      updatedAt: '2026-05-02T13:57:22.000Z',
      turns: [
        {
          responseId: 'r_logs',
          prompt: 'here are the full logs',
          uploads: [
            { filename: 'esp-web-tools-logs.txt', url: null, slot: 4 },
            {
              filename: 'image_20dabe.png',
              url: 'https://lh3.googleusercontent.com/gg/log-token',
            },
          ],
          reply: 'The chip never enters download mode.',
          at: '2026-05-02T13:57:22.000Z',
        },
      ],
    })

    await sync()

    expect(await messageTexts('3e95b801154ef468')).toEqual([
      'here are the full logs\n\n' +
        'esp-web-tools-logs.txt\n' +
        '![image_20dabe.png](https://lh3.googleusercontent.com/gg/log-token)',
      'The chip never enters download mode.',
    ])
  })

  test('replaces generated-image placeholders in the reply with Markdown images', async () => {
    gemini.putChat({
      id: '3c4d5e6f70819203',
      title: 'Cat poster',
      updatedAt: '2026-11-06T10:00:00.000Z',
      turns: [
        {
          responseId: 'r_poster',
          prompt: 'Draw a cat in a spacesuit.',
          reply:
            'Here it is:\n\nhttp://googleusercontent.com/image_generation_content/0\n\nWant another?',
          generated: [
            {
              placeholder:
                'http://googleusercontent.com/image_generation_content/0',
              filename: 'cat_astronaut.png',
              url: 'https://lh3.googleusercontent.com/gg/cat-token',
            },
          ],
          at: '2026-11-06T10:00:00.000Z',
        },
      ],
    })

    await sync()

    expect(await messageTexts('3c4d5e6f70819203')).toEqual([
      'Draw a cat in a spacesuit.',
      'Here it is:\n\n' +
        '![cat_astronaut.png](https://lh3.googleusercontent.com/gg/cat-token)' +
        '\n\nWant another?',
    ])
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

  test('host=gemini limits hits to Gemini Threads', async () => {
    testApp = createTestApp({ hosts: ['hive'], fetch: gemini.fetch })
    gemini.storeSession(testApp.root)
    const hive = createFakeHost(testApp.root, 'hive')
    hive.addThread({
      id: 'thread-1',
      title: 'Meal prep',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    hive.addMessage({
      id: 'item-1',
      threadId: 'thread-1',
      ordinal: 1,
      role: 'user',
      text: 'How long does rice keep in the fridge?',
      updatedAt: '2026-11-01T00:00:01.000Z',
    })
    await sync()

    expect(await getJson('/search?q=fridge')).toEqual({
      hits: [
        expect.objectContaining({ host: 'gemini' }),
        expect.objectContaining({ host: 'hive' }),
      ],
    })
    expect(await getJson('/search?q=fridge&host=gemini')).toEqual({
      hits: [expect.objectContaining({ host: 'gemini' })],
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

  test("keeps an unlisted chat's Signature, so it isn't re-read when listed again", async () => {
    await sync()
    gemini.removeChat(sourdough.id)
    await sync()
    gemini.requests.length = 0
    gemini.putChat(sourdough)

    await sync()

    expect(gemini.reads()).toEqual([])
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

  test('records a redirect answered with HTTP 503 as that, not as signed out', async () => {
    gemini.failServiceLogin(503)

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastError:
          'Gemini answered https://accounts.google.com/ServiceLogin with HTTP 503',
      }),
    )
  })

  test('records a session Google sends in circles as signed out', async () => {
    gemini.staleTimestamp()
    gemini.refuseRotations()

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({ lastError: 'signed out; run install-gemini' }),
    )
  })

  test.each([503, 429])(
    'records an app page answered with HTTP %p as that, not as signed out',
    async (status) => {
      gemini.failAppPage(status)

      await sync()

      expect(await geminiRow()).toEqual(
        expect.objectContaining({
          lastError: `Gemini answered the app page with HTTP ${status}`,
        }),
      )
    },
  )

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

  test("records Google's error frame when it refuses the first page", async () => {
    gemini.putChat({
      id: 'b40ce7e9a1d2f3c4',
      title: 'Broken',
      updatedAt: '2026-11-05T00:00:00.000Z',
      turns: [],
      broken: true,
    })

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastError: expect.stringContaining(
          `Gemini answered MaZiqc without a result: ["wrb.fr","MaZiqc",null,null,null,[13,null,[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1096,null,"Couldn't load conversation.`,
        ),
      }),
    )
  })

  test('records the start of a response that holds no frames', async () => {
    testApp = createTestApp({
      hosts: [],
      fetch: async (url, init) =>
        url.includes('/batchexecute')
          ? new Response(`<html>Sorry${'.'.repeat(300)}</html>`)
          : gemini.fetch(url, init),
    })
    gemini.storeSession(testApp.root)

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastError: `Gemini answered MaZiqc without a result: <html>Sorry${'.'.repeat(189)}`,
      }),
    )
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

describe('POST /sync with a chat longer than one read returns', () => {
  test('pages its turns, archiving all of them and the newer chats', async () => {
    const turns = Array.from({ length: 201 }, (_, index) => ({
      responseId: `r_long${index}`,
      prompt: `Turn ${index}`,
      reply: '',
      at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    }))
    // Older than the sourdough chat, so read first.
    gemini.putChat({
      id: '5e6f708192031425',
      title: 'Long',
      updatedAt: '2026-10-01T03:20:00.000Z',
      turns,
    })

    await sync()

    expect(gemini.reads()).toEqual([
      '5e6f708192031425',
      '5e6f708192031425',
      sourdough.id,
    ])
    const { items } = z
      .object({ items: z.array(z.object({ text: z.string() }).loose()) })
      .parse(await getJson('/threads/gemini/5e6f708192031425?items=all'))
    expect(items.map(({ text }) => text)).toEqual(
      turns.map(({ prompt }) => prompt),
    )
    expect(
      (await testApp.handle(`/threads/gemini/${sourdough.id}`)).status,
    ).toBe(200)
  })
})

/** `count` one-turn chats, chat 0 the oldest, a minute apart. */
const putChats = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const id = `backlog${String(index).padStart(4, '0')}`
    const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    gemini.putChat({
      id,
      title: `Chat ${index}`,
      updatedAt: at,
      turns: [
        { responseId: `r_${id}`, prompt: `Question ${index}`, reply: '', at },
      ],
    })
    return id
  })

describe('POST /sync with a backlog', () => {
  test('reads the 30 oldest changed chats per Sync until every page is archived', async () => {
    gemini.removeChat(sourdough.id)
    const ids = putChats(250)

    await sync()

    expect(gemini.reads()).toEqual(ids.slice(0, 30))

    // 250 chats at 30 per Sync take 9 Syncs.
    for (let syncs = 1; syncs < 9; syncs++) await sync()
    gemini.requests.length = 0
    await sync()

    expect(gemini.reads()).toEqual([])
    for (const id of [ids[0], ids[249]]) {
      expect(await testApp.handle(`/threads/gemini/${id}`)).toHaveProperty(
        'status',
        200,
      )
    }
  })

  test('once caught up, lists only until the first page without a change', async () => {
    gemini.removeChat(sourdough.id)
    putChats(150)
    for (let syncs = 0; syncs < 5; syncs++) await sync()
    gemini.requests.length = 0

    await sync()

    expect(gemini.requests.map(({ rpc }) => rpc)).toEqual(['MaZiqc'])

    gemini.requests.length = 0
    gemini.putChat({
      id: 'fresh',
      title: 'Fresh chat',
      updatedAt: '2026-11-10T00:00:00.000Z',
      turns: [],
    })

    await sync()

    expect(gemini.requests.map(({ rpc }) => rpc)).toEqual([
      'MaZiqc',
      'MaZiqc',
      'hNvQHb',
    ])
  })
})

describe('POST /sync with a chat Google cannot load', () => {
  test('ends the list at the later page Google refuses', async () => {
    gemini.removeChat(sourdough.id)
    const ids = putChats(150)
    // Older than every other chat, so on page 2.
    gemini.putChat({
      id: 'b40ce7e9a1d2f3c4',
      title: 'Broken',
      updatedAt: '2025-01-01T00:00:00.000Z',
      turns: [],
      broken: true,
    })

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastSuccessAt: expect.any(String),
        lastError: null,
      }),
    )
    // The oldest changed chats of page 1, the newest 100.
    expect(gemini.reads()).toEqual(ids.slice(50, 80))
  })

  test('fails on a later page Google refuses for another reason', async () => {
    putChats(150)
    let calls = 0
    testApp = createTestApp({
      hosts: [],
      fetch: async (url, init) =>
        url.includes('/batchexecute') && ++calls === 2
          ? new Response(
              `)]}'\n\n${JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, [7], 'generic']])}\n`,
            )
          : gemini.fetch(url, init),
    })
    gemini.storeSession(testApp.root)

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastSuccessAt: null,
        lastError:
          'Gemini answered MaZiqc without a result: ["wrb.fr","MaZiqc",null,null,null,[7],"generic"]',
      }),
    )
  })
})

describe('POST /sync throttled while paging', () => {
  test('fails instead of treating the empty page as the last', async () => {
    putChats(150)
    gemini.throttle(1)

    await sync()

    expect(await geminiRow()).toEqual(
      expect.objectContaining({
        lastError: 'Gemini answered MaZiqc without a result; throttled?',
      }),
    )
    expect(gemini.reads()).toEqual([])
  })
})

describe('POST /sync pacing', () => {
  test('spaces requests to Google by the configured pace', async () => {
    const sentAt: number[] = []
    testApp = createTestApp({
      hosts: [],
      fetch: (url, init) => {
        sentAt.push(performance.now())
        return gemini.fetch(url, init)
      },
      geminiPace: 50,
    })
    gemini.storeSession(testApp.root)

    await sync()

    // Rotation, the app page, its redirects to an OSID and back, the list and
    // one read.
    expect(sentAt).toHaveLength(7)
    const gaps = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? at))
    // Timers can fire a little early under load; unpaced gaps are near 0.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(40)
  })
})
