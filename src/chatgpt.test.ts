import type { FakeChatGPT } from '~/testing/fakeChatGPT'
import type { Fetch } from '~/web'
import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createFakeChatGPT } from '~/testing/fakeChatGPT'
import { createFakeGemini } from '~/testing/fakeGemini'
import { createFakeHost, createTestApp, testNow } from '~/testing/fakeHost'

let chatgpt: FakeChatGPT
let testApp: ReturnType<typeof createTestApp>

beforeEach(() => {
  chatgpt = createFakeChatGPT()
  testApp = createTestApp({ hosts: [], fetch: chatgpt.fetch })
  chatgpt.storeSession(testApp.root)

  chatgpt.putChat({
    id: '6738a1f0-1c2d-8003-9e4f-5a6b7c8d9e0f',
    title: 'Sourdough hydration',
    updatedAt: '2026-11-02T09:00:00.000Z',
  })
})

const sync = () => testApp.sync()

const getJson = async (path: string) => {
  const response = await testApp.handle(path)
  expect(response.status).toBe(200)
  return response.json()
}

const health = () => getJson('/health')

const chatgptRow = async () =>
  z
    .object({ hosts: z.array(z.object({ host: z.string() }).loose()) })
    .parse(await health())
    .hosts.find(({ host }) => host === 'chatgpt')

/** Routes each request to the fake that owns its origin. */
const routeByOrigin =
  (fakes: Record<string, { fetch: Fetch }>): Fetch =>
  (url, init) => {
    const fake = fakes[new URL(url).origin]
    if (!fake) throw new Error(`no fake for ${url}`)
    return fake.fetch(url, init)
  }

describe('POST /sync with a ChatGPT session', () => {
  test('lists the chats with the access token the session exchanges for', async () => {
    await sync()

    expect(await chatgptRow()).toEqual(
      expect.objectContaining({
        lastSuccessAt: testNow.toISOString(),
        lastError: null,
      }),
    )
    expect(chatgpt.listRequests).toEqual([
      { offset: 0, limit: 100, order: 'updated', archived: false },
      { offset: 0, limit: 100, order: 'updated', archived: true },
    ])
  })

  test('pages the active chats, then the archived ones', async () => {
    for (let index = 0; index < 150; index += 1) {
      chatgpt.putChat({
        id: `active-${index}`,
        title: `Active ${index}`,
        updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      })
    }
    chatgpt.putChat({
      id: 'archived-1',
      title: 'Archived',
      updatedAt: '2026-10-01T00:00:00.000Z',
      archived: true,
    })
    chatgpt.putChat({
      id: 'gizmo-1',
      title: 'With a custom GPT',
      updatedAt: '2026-10-02T00:00:00.000Z',
      gizmoId: 'g-p-fake',
    })

    await sync()

    expect(chatgpt.listRequests).toEqual([
      { offset: 0, limit: 100, order: 'updated', archived: false },
      { offset: 100, limit: 100, order: 'updated', archived: false },
      { offset: 0, limit: 100, order: 'updated', archived: true },
    ])
    expect(await chatgptRow()).toEqual(
      expect.objectContaining({ lastError: null }),
    )
  })

  test('saves no Threads', async () => {
    await sync()

    expect(await getJson('/search?q=sourdough')).toEqual({ hits: [] })
    const response = await testApp.handle(
      '/threads/chatgpt/6738a1f0-1c2d-8003-9e4f-5a6b7c8d9e0f',
    )
    expect(response.status).toBe(404)
  })
})

describe('GET /health', () => {
  test('lists chatgpt after gemini with its last success', async () => {
    const gemini = createFakeGemini()
    testApp = createTestApp({
      hosts: ['hive'],
      fetch: routeByOrigin({
        'https://gemini.google.com': gemini,
        'https://accounts.google.com': gemini,
        'https://chatgpt.com': chatgpt,
      }),
    })
    createFakeHost(testApp.root, 'hive')
    gemini.storeSession(testApp.root)
    chatgpt.storeSession(testApp.root)

    await sync()

    expect(await health()).toEqual({
      syncing: false,
      hosts: [
        expect.objectContaining({ host: 'hive' }),
        expect.objectContaining({ host: 'gemini' }),
        {
          host: 'chatgpt',
          environmentId: null,
          lastSuccessAt: testNow.toISOString(),
          lastError: null,
          lastErrorAt: null,
        },
      ],
    })
  })

  test('omits chatgpt and ChatGPT is never contacted without a session', async () => {
    const requests: string[] = []
    testApp = createTestApp({
      hosts: [],
      fetch: (url, init) => {
        requests.push(url)
        return chatgpt.fetch(url, init)
      },
    })

    await sync()

    expect(await health()).toEqual({ syncing: false, hosts: [] })
    expect(requests).toEqual([])
  })
})

describe('POST /sync and the ChatGPT session', () => {
  test('keeps cookies any chatgpt.com response sets, for the next request and Sync', async () => {
    chatgpt.issueCookie('__Secure-next-auth.session-token', 'rolled-token')
    chatgpt.issueCookie('__cf_bm', 'cloudflare-bot-cookie')

    await sync()
    await sync()

    expect(chatgpt.listRequests).toHaveLength(4)
    expect(await chatgptRow()).toEqual(
      expect.objectContaining({ lastError: null }),
    )
  })
})

describe('POST /sync when ChatGPT fails', () => {
  test('records a signed-out session as a failure', async () => {
    chatgpt.signOut()

    await sync()

    expect(await chatgptRow()).toEqual(
      expect.objectContaining({
        lastSuccessAt: null,
        lastError: 'signed out; run install-chatgpt',
        lastErrorAt: testNow.toISOString(),
      }),
    )
  })

  test.each([
    [
      '/api/auth/session',
      'Cloudflare challenged /api/auth/session with HTTP 403',
    ],
    [
      '/backend-api/conversations',
      'Cloudflare challenged /backend-api/conversations with HTTP 403',
    ],
  ])(
    'records a Cloudflare challenge of %p as distinct from signed out',
    async (path, lastError) => {
      chatgpt.challenge(path)

      await sync()

      expect(await chatgptRow()).toEqual(
        expect.objectContaining({ lastSuccessAt: null, lastError }),
      )
    },
  )

  test('records a challenge page without its header as a challenge', async () => {
    chatgpt.challenge('/', { header: false })

    await sync()

    expect(await chatgptRow()).toEqual(
      expect.objectContaining({
        lastError: 'Cloudflare challenged /api/auth/session with HTTP 403',
      }),
    )
  })

  test('records another failed answer with its status', async () => {
    chatgpt.failSession(503)

    await sync()

    expect(await chatgptRow()).toEqual(
      expect.objectContaining({
        lastError: 'ChatGPT answered /api/auth/session with HTTP 503',
      }),
    )
  })

  test('still syncs the Hosts and Gemini', async () => {
    const gemini = createFakeGemini()
    gemini.putChat({
      id: '8f1e2d3c4b5a6978',
      title: 'Sourdough starter',
      updatedAt: '2026-11-02T09:00:00.000Z',
      turns: [
        {
          responseId: 'r_first',
          prompt: 'How often should I feed a sourdough starter?',
          reply: 'Once a day.',
          at: '2026-11-02T09:00:00.000Z',
        },
      ],
    })
    testApp = createTestApp({
      hosts: ['hive'],
      fetch: routeByOrigin({
        'https://gemini.google.com': gemini,
        'https://accounts.google.com': gemini,
        'https://chatgpt.com': chatgpt,
      }),
    })
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
    gemini.storeSession(testApp.root)
    chatgpt.storeSession(testApp.root)
    chatgpt.challenge()

    await sync()

    expect(await getJson('/search?q=redirect')).toEqual({
      hits: [expect.objectContaining({ host: 'hive' })],
    })
    expect(await getJson('/search?q=starter')).toEqual({
      hits: [expect.objectContaining({ host: 'gemini' })],
    })
    expect(await health()).toEqual({
      syncing: false,
      hosts: [
        expect.objectContaining({ host: 'hive', lastError: null }),
        expect.objectContaining({ host: 'gemini', lastError: null }),
        expect.objectContaining({ host: 'chatgpt', lastSuccessAt: null }),
      ],
    })
  })
})

describe('POST /sync pacing', () => {
  test('spaces requests to chatgpt.com by the configured pace', async () => {
    const sentAt: number[] = []
    testApp = createTestApp({
      hosts: [],
      fetch: (url, init) => {
        sentAt.push(performance.now())
        return chatgpt.fetch(url, init)
      },
      chatgptPace: 50,
    })
    chatgpt.storeSession(testApp.root)

    await sync()

    // The session exchange and one page of each list.
    expect(sentAt).toHaveLength(3)
    const gaps = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? at))
    // Timers can fire a little early under load; unpaced gaps are near 0.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(40)
  })
})
