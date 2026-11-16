import type { ChatFixture, FakeChatGPT } from '~/testing/fakeChatGPT'
import type { Fetch } from '~/web'
import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createFakeChatGPT } from '~/testing/fakeChatGPT'
import { createFakeGemini } from '~/testing/fakeGemini'
import { createFakeHost, createTestApp, testNow } from '~/testing/fakeHost'

const sourdough: ChatFixture = {
  id: '6738a1f0-1c2d-8003-9e4f-5a6b7c8d9e0f',
  title: 'Sourdough hydration',
  createdAt: '2026-11-01T08:00:00.000Z',
  // The list's times carry microseconds.
  updatedAt: '2026-11-02T09:00:00.123456Z',
  nodes: [
    {
      id: 'a1f0c2d3-0001-4e5f-8a9b-0c1d2e3f4a5b',
      role: 'user',
      text: 'What hydration suits a first sourdough loaf?',
      at: '2026-11-01T08:00:00.000Z',
    },
    {
      id: 'a1f0c2d3-0002-4e5f-8a9b-0c1d2e3f4a5b',
      role: 'assistant',
      text: 'Start around **70%** hydration.',
      at: '2026-11-01T08:00:05.000Z',
    },
    {
      id: 'a1f0c2d3-0003-4e5f-8a9b-0c1d2e3f4a5b',
      role: 'user',
      text: 'And for a rye loaf?',
      at: '2026-11-02T09:00:00.000Z',
    },
    {
      id: 'a1f0c2d3-0004-4e5f-8a9b-0c1d2e3f4a5b',
      role: 'assistant',
      text: 'Rye takes more water: try 80%.',
      at: '2026-11-02T09:00:04.000Z',
    },
  ],
}

let chatgpt: FakeChatGPT
let testApp: ReturnType<typeof createTestApp>

beforeEach(() => {
  chatgpt = createFakeChatGPT()
  testApp = createTestApp({ hosts: [], fetch: chatgpt.fetch })
  chatgpt.storeSession(testApp.root)

  chatgpt.putChat(sourdough)
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
  test('archives each chat as a ChatGPT Thread of its prompts and replies', async () => {
    await sync()

    expect(await getJson(`/threads/chatgpt/${sourdough.id}?items=all`)).toEqual(
      {
        thread: {
          host: 'chatgpt',
          id: sourdough.id,
          title: 'Sourdough hydration',
          projectTitle: null,
          workspaceRoot: null,
          createdAt: '2026-11-01T08:00:00.000Z',
          updatedAt: '2026-11-02T09:00:00.123Z',
          archivedAt: null,
          archived: false,
        },
        items: [
          {
            id: `${sourdough.id}:a1f0c2d3-0001-4e5f-8a9b-0c1d2e3f4a5b:user_message`,
            type: 'user_message',
            role: 'user',
            status: 'completed',
            ordinal: 0,
            text: 'What hydration suits a first sourdough loaf?',
            payload: JSON.stringify({
              text: 'What hydration suits a first sourdough loaf?',
            }),
            createdAt: '2026-11-01T08:00:00.000Z',
            completedAt: '2026-11-01T08:00:00.000Z',
            updatedAt: '2026-11-01T08:00:00.000Z',
          },
          expect.objectContaining({
            id: `${sourdough.id}:a1f0c2d3-0002-4e5f-8a9b-0c1d2e3f4a5b:assistant_message`,
            type: 'assistant_message',
            role: 'assistant',
            text: 'Start around **70%** hydration.',
            createdAt: '2026-11-01T08:00:05.000Z',
          }),
          expect.objectContaining({
            id: `${sourdough.id}:a1f0c2d3-0003-4e5f-8a9b-0c1d2e3f4a5b:user_message`,
            text: 'And for a rye loaf?',
          }),
          expect.objectContaining({
            id: `${sourdough.id}:a1f0c2d3-0004-4e5f-8a9b-0c1d2e3f4a5b:assistant_message`,
            text: 'Rye takes more water: try 80%.',
          }),
        ],
      },
    )
  })

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
})

const messageTexts = async (threadId: string) =>
  z
    .object({ items: z.array(z.object({ text: z.string() }).loose()) })
    .parse(await getJson(`/threads/chatgpt/${threadId}?items=all`))
    .items.map(({ text }) => text)

test('POST /sync archives only the branch the ChatGPT UI shows, oldest first', async () => {
  chatgpt.putChat({
    id: '6739b2c1-2d3e-8004-af50-6b7c8d9e0f1a',
    title: 'Packing list',
    updatedAt: '2026-11-03T10:00:00.000000Z',
    nodes: [
      {
        id: 'n-ask',
        role: 'user',
        text: 'Pack for a wet weekend in Hakone?',
        at: '2026-11-03T09:00:00.000Z',
      },
      {
        id: 'n-first',
        role: 'assistant',
        text: 'Bring sunscreen.',
        at: '2026-11-03T09:00:05.000Z',
      },
      // A regeneration of the first reply, which the UI shows.
      {
        id: 'n-regen',
        parent: 'n-ask',
        role: 'assistant',
        text: 'Bring a rain shell.',
        at: '2026-11-03T09:01:00.000Z',
      },
      {
        id: 'n-follow',
        role: 'user',
        text: 'Umbrella too?',
        at: '2026-11-03T09:02:00.000Z',
      },
      {
        id: 'n-answer',
        role: 'assistant',
        text: 'A compact one, yes.',
        at: '2026-11-03T09:02:05.000Z',
      },
      // An edited follow-up the UI no longer shows.
      {
        id: 'n-edited',
        parent: 'n-regen',
        role: 'user',
        text: 'Boots too?',
        at: '2026-11-03T09:03:00.000Z',
      },
    ],
    currentNode: 'n-answer',
  })

  await sync()

  expect(await messageTexts('6739b2c1-2d3e-8004-af50-6b7c8d9e0f1a')).toEqual([
    'Pack for a wet weekend in Hakone?',
    'Bring a rain shell.',
    'Umbrella too?',
    'A compact one, yes.',
  ])
})

test('POST /sync leaves out hidden, system, memory and context messages', async () => {
  chatgpt.putChat({
    id: '673ac3d2-3e4f-8005-b061-7c8d9e0f1a2b',
    title: 'Hidden context',
    updatedAt: '2026-11-04T10:00:00.000000Z',
    nodes: [
      {
        id: 'n-system',
        role: 'system',
        text: '',
        metadata: { is_visually_hidden_from_conversation: true },
        at: '2026-11-04T09:00:00.000Z',
      },
      {
        id: 'n-instructions',
        role: 'user',
        content: {
          content_type: 'user_editable_context',
          user_profile: 'Adwin bakes bread on weekends.',
          user_instructions: 'Answer briefly.',
        },
        metadata: {
          is_visually_hidden_from_conversation: true,
          is_user_system_message: true,
        },
        at: '2026-11-04T09:00:00.000Z',
      },
      {
        id: 'n-context',
        role: 'assistant',
        content: {
          content_type: 'model_editable_context',
          model_set_context: '1. Adwin bakes bread.',
        },
        at: '2026-11-04T09:00:00.000Z',
      },
      {
        id: 'n-ask',
        role: 'user',
        text: 'Remember that I prefer rye.',
        at: '2026-11-04T09:00:01.000Z',
      },
      {
        id: 'n-memory',
        role: 'assistant',
        recipient: 'bio',
        text: 'Prefers rye bread.',
        at: '2026-11-04T09:00:02.000Z',
      },
      {
        id: 'n-memory-result',
        role: 'tool',
        text: 'Model set context updated.',
        at: '2026-11-04T09:00:03.000Z',
      },
      {
        id: 'n-reply',
        role: 'assistant',
        text: 'Noted: rye it is.',
        at: '2026-11-04T09:00:04.000Z',
      },
      {
        id: 'n-canvas-comment',
        role: 'user',
        text: 'Comment on the selected text.',
        metadata: { is_visually_hidden_from_conversation: true },
        at: '2026-11-04T09:00:05.000Z',
      },
      {
        id: 'n-empty',
        role: 'assistant',
        text: '',
        at: '2026-11-04T09:00:06.000Z',
      },
    ],
  })

  await sync()

  expect(await messageTexts('673ac3d2-3e4f-8005-b061-7c8d9e0f1a2b')).toEqual([
    'Remember that I prefer rye.',
    'Noted: rye it is.',
  ])
})

/** The Thread's Messages, by type and text. */
const messages = async (threadId: string) =>
  z
    .object({
      items: z.array(z.object({ type: z.string(), text: z.string() })),
    })
    .parse(await getJson(`/threads/chatgpt/${threadId}`))
    .items.map(({ type, text }) => ({ type, text }))

const image = (assetPointer: string) => ({
  content_type: 'image_asset_pointer',
  asset_pointer: assetPointer,
  size_bytes: 23491,
  width: 448,
  height: 448,
  fovea: null,
  metadata: { dalle: null, sanitized: true },
})

describe('POST /sync with images', () => {
  test('keeps uploaded images in the prompt as file-ID placeholders', async () => {
    chatgpt.putChat({
      id: '673df605-6172-8008-e394-0f1a2b3c4d5e',
      title: 'Plant ID',
      updatedAt: '2026-11-05T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-upload',
          role: 'user',
          content: {
            content_type: 'multimodal_text',
            parts: [
              image('file-service://file-Fake0Leaf1Upload2Id3'),
              image('sediment://file_00000000fake0pot1paste2id3'),
              'What plant is this?',
            ],
          },
          at: '2026-11-05T10:00:00.000Z',
        },
        {
          id: 'n-reply',
          role: 'assistant',
          text: 'A pothos.',
          at: '2026-11-05T10:00:05.000Z',
        },
        {
          id: 'n-screenshot',
          role: 'user',
          content: {
            content_type: 'multimodal_text',
            parts: [image('sediment://file_00000000fake0shot1id2')],
          },
          at: '2026-11-05T10:01:00.000Z',
        },
      ],
    })

    await sync()

    expect(await messages('673df605-6172-8008-e394-0f1a2b3c4d5e')).toEqual([
      {
        type: 'user_message',
        text:
          '![image](chatgpt-file:file-Fake0Leaf1Upload2Id3)\n' +
          '![image](chatgpt-file:file_00000000fake0pot1paste2id3)\n' +
          'What plant is this?',
      },
      { type: 'assistant_message', text: 'A pothos.' },
      {
        type: 'user_message',
        text: '![image](chatgpt-file:file_00000000fake0shot1id2)',
      },
    ])
  })

  test('keeps a generated image as a reply holding its file-ID placeholder', async () => {
    const imageGen = 't2uay3k.sj1i4kz'
    chatgpt.putChat({
      id: '673e0716-7283-8009-f4a5-1a2b3c4d5e6f',
      title: 'Cat poster',
      updatedAt: '2026-11-06T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-ask',
          role: 'user',
          text: 'Draw a cat in a spacesuit.',
          at: '2026-11-06T10:00:00.000Z',
        },
        {
          id: 'n-call',
          role: 'assistant',
          recipient: imageGen,
          text: '{"prompt":"A cat in a spacesuit","size":"1024x1536"}',
          at: '2026-11-06T10:00:01.000Z',
        },
        {
          id: 'n-progress',
          role: 'tool',
          name: imageGen,
          text: 'Processing image',
          metadata: { is_visually_hidden_from_conversation: true },
          at: '2026-11-06T10:00:02.000Z',
        },
        {
          id: 'n-image',
          role: 'tool',
          name: imageGen,
          content: {
            content_type: 'multimodal_text',
            parts: [image('sediment://file_00000000fake0cat1poster2id3')],
          },
          at: '2026-11-06T10:00:30.000Z',
        },
        {
          id: 'n-note',
          role: 'tool',
          name: imageGen,
          recipient: 'assistant',
          text: 'GPT-4o returned 1 images.',
          at: '2026-11-06T10:00:31.000Z',
        },
        {
          id: 'n-empty',
          role: 'assistant',
          text: '',
          at: '2026-11-06T10:00:32.000Z',
        },
      ],
    })

    await sync()

    expect(await messages('673e0716-7283-8009-f4a5-1a2b3c4d5e6f')).toEqual([
      { type: 'user_message', text: 'Draw a cat in a spacesuit.' },
      {
        type: 'assistant_message',
        text: '![image](chatgpt-file:file_00000000fake0cat1poster2id3)',
      },
    ])
  })

  test('drops a part it does not know and still archives newer chats', async () => {
    chatgpt.putChat({
      id: '6736f1e2-0a1b-8002-8d3e-4f5a6b7c8d9e',
      title: 'Voice note',
      updatedAt: '2026-10-30T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-voice',
          role: 'user',
          content: {
            content_type: 'multimodal_text',
            parts: [
              { content_type: 'audio_asset_pointer', asset_pointer: 'x' },
              'Transcribe my shopping list.',
            ],
          },
          at: '2026-10-30T10:00:00.000Z',
        },
      ],
    })

    await sync()

    expect(await messages('6736f1e2-0a1b-8002-8d3e-4f5a6b7c8d9e')).toEqual([
      { type: 'user_message', text: 'Transcribe my shopping list.' },
    ])
    expect(await messageTexts(sourdough.id)).toHaveLength(4)
  })
})

const search = async (q: string, items?: 'all') => {
  const params = new URLSearchParams({
    q,
    host: 'chatgpt',
    ...(items && { items }),
  })
  return z
    .object({ hits: z.array(z.object({ itemType: z.string() }).loose()) })
    .parse(await getJson(`/search?${params}`))
    .hits.map(({ itemType }) => itemType)
}

describe('POST /sync with tool calls', () => {
  const threadId = '673fa1b2-7283-8009-f4a5-1a2b3c4d5e6f'

  const threadItems = async () =>
    z
      .object({
        items: z.array(
          z.object({ type: z.string(), payload: z.string() }).loose(),
        ),
      })
      .parse(await getJson(`/threads/chatgpt/${threadId}?items=all`))
      .items.map(({ type, payload }) => ({
        type,
        payload: JSON.parse(payload),
      }))

  test('archives a code interpreter run as a command execution', async () => {
    chatgpt.putChat({
      id: threadId,
      title: 'Loaf costs',
      updatedAt: '2026-11-05T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-ask',
          role: 'user',
          text: 'What does one loaf cost?',
          at: '2026-11-05T09:00:00.000Z',
        },
        {
          id: 'n-code',
          role: 'assistant',
          recipient: 'python',
          content: {
            content_type: 'code',
            language: 'unknown',
            response_format_name: null,
            text: 'flour_yen = 500 * 0.4\nflour_yen + 35',
          },
          at: '2026-11-05T09:00:02.000Z',
        },
        {
          id: 'n-output',
          role: 'tool',
          name: 'python',
          content: { content_type: 'execution_output', text: '235.0' },
          metadata: { aggregate_result: { status: 'success' } },
          at: '2026-11-05T09:00:03.000Z',
        },
        {
          id: 'n-reply',
          role: 'assistant',
          text: 'About 235 yen.',
          at: '2026-11-05T09:00:04.000Z',
        },
      ],
    })

    await sync()

    expect(await threadItems()).toEqual([
      { type: 'user_message', payload: { text: 'What does one loaf cost?' } },
      {
        type: 'command_execution',
        payload: {
          input: 'flour_yen = 500 * 0.4\nflour_yen + 35',
          output: '235.0',
        },
      },
      { type: 'assistant_message', payload: { text: 'About 235 yen.' } },
    ])
    expect(await search('flour_yen')).toEqual([])
    expect(await search('flour_yen', 'all')).toEqual(['command_execution'])
    expect(await search('235.0', 'all')).toEqual(['command_execution'])
  })

  test('archives browsing, image generation and other tool calls as dynamic tools', async () => {
    chatgpt.putChat({
      id: threadId,
      title: 'Bakery logo',
      updatedAt: '2026-11-05T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-ask',
          role: 'user',
          text: 'Find a bakery font and draw a logo.',
          at: '2026-11-05T09:00:00.000Z',
        },
        // Browsing: a web call that leaves its text empty, then the search.
        {
          id: 'n-web',
          role: 'assistant',
          recipient: 'web',
          at: '2026-11-05T09:00:01.000Z',
        },
        {
          id: 'n-web-run',
          role: 'assistant',
          recipient: 'web.run',
          metadata: {
            search_queries: [
              { type: 'search', q: 'rounded serif bakery font' },
              { type: 'search', q: 'free bakery logo fonts' },
            ],
          },
          at: '2026-11-05T09:00:02.000Z',
        },
        {
          id: 'n-web-result',
          role: 'tool',
          name: 'web.run',
          metadata: {
            search_result_groups: [
              {
                type: 'search_result_group',
                domain: 'example.com',
                entries: [
                  {
                    type: 'search_result',
                    url: 'https://example.com/fonts',
                    title: 'Bakery fonts',
                    snippet: 'Rounded serifs for bakeries.',
                  },
                ],
              },
            ],
          },
          at: '2026-11-05T09:00:03.000Z',
        },
        {
          id: 'n-image-call',
          role: 'assistant',
          recipient: 't2uay3k.sj1i4kz',
          content: {
            content_type: 'code',
            language: 'unknown',
            response_format_name: null,
            text: '{"prompt":"A rye loaf logo in a rounded serif"}',
          },
          at: '2026-11-05T09:00:04.000Z',
        },
        {
          id: 'n-image-progress',
          role: 'tool',
          name: 't2uay3k.sj1i4kz',
          text: 'Processing image',
          metadata: { is_visually_hidden_from_conversation: true },
          at: '2026-11-05T09:00:05.000Z',
        },
        {
          id: 'n-image',
          role: 'tool',
          name: 't2uay3k.sj1i4kz',
          content: {
            content_type: 'multimodal_text',
            parts: [
              {
                content_type: 'image_asset_pointer',
                asset_pointer: 'sediment://file_00000000fake0logo',
                width: 1024,
                height: 1024,
              },
            ],
          },
          at: '2026-11-05T09:00:20.000Z',
        },
        {
          id: 'n-image-done',
          role: 'tool',
          name: 't2uay3k.sj1i4kz',
          recipient: 'assistant',
          text: 'GPT-4o returned 1 images.',
          at: '2026-11-05T09:00:21.000Z',
        },
        {
          id: 'n-connector-call',
          role: 'assistant',
          recipient: 'api_tool.call_tool',
          text: '{"path":"/Shopping research/start","args":"{\\"query\\":\\"bread lame\\"}"}',
          at: '2026-11-05T09:00:22.000Z',
        },
        {
          id: 'n-connector-ack',
          role: 'tool',
          name: 'api_tool.call_tool',
          content: {
            content_type: 'code',
            language: 'unknown',
            response_format_name: null,
            text: '{}',
          },
          at: '2026-11-05T09:00:23.000Z',
        },
        {
          id: 'n-connector-result',
          role: 'tool',
          name: 'api_tool',
          text: '{"products":["Walnut bread lame"]}',
          at: '2026-11-05T09:00:24.000Z',
        },
        {
          id: 'n-reply',
          role: 'assistant',
          text: 'Here is your logo.',
          at: '2026-11-05T09:00:25.000Z',
        },
      ],
    })

    await sync()

    expect(await threadItems()).toEqual([
      expect.objectContaining({ type: 'user_message' }),
      {
        type: 'dynamic_tool',
        payload: { toolName: 'web', input: '', output: null },
      },
      {
        type: 'dynamic_tool',
        payload: {
          toolName: 'web.run',
          input: 'rounded serif bakery font\nfree bakery logo fonts',
          output: null,
        },
      },
      {
        type: 'dynamic_tool',
        payload: {
          toolName: 't2uay3k.sj1i4kz',
          input: '{"prompt":"A rye loaf logo in a rounded serif"}',
          output: 'GPT-4o returned 1 images.',
        },
      },
      {
        type: 'assistant_message',
        payload: { text: '![image](chatgpt-file:file_00000000fake0logo)' },
      },
      {
        type: 'dynamic_tool',
        payload: {
          toolName: 'api_tool.call_tool',
          input:
            '{"path":"/Shopping research/start","args":"{\\"query\\":\\"bread lame\\"}"}',
          output: '{}\n{"products":["Walnut bread lame"]}',
        },
      },
      expect.objectContaining({ type: 'assistant_message' }),
    ])
    expect(await search('rounded serif')).toEqual([])
    expect(await search('rounded serif bakery', 'all')).toEqual([
      'dynamic_tool',
    ])
    expect(await search('rye loaf logo', 'all')).toEqual(['dynamic_tool'])
    expect(await search('Walnut', 'all')).toEqual(['dynamic_tool'])
  })
})

describe('POST /sync with a reply that has reasoning', () => {
  const sieveId = '673d0a1b-2c3d-8008-e394-0f1a2b3c4d5e'

  beforeEach(() => {
    chatgpt.putChat({
      id: sieveId,
      title: 'Prime sieve',
      updatedAt: '2026-11-03T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-ask',
          role: 'user',
          text: 'Fastest way to list primes below a million?',
          at: '2026-11-03T10:00:00.000Z',
        },
        {
          id: 'n-thoughts',
          role: 'assistant',
          content: {
            content_type: 'thoughts',
            thoughts: [
              {
                summary: 'Weighing approaches',
                content: 'Trial division is too slow.',
                chunks: [],
                finished: true,
              },
              {
                summary: 'Picking a sieve',
                content: 'Eratosthenes fits a million.',
                chunks: [],
                finished: true,
              },
            ],
          },
          at: '2026-11-03T10:00:01.000Z',
        },
        {
          id: 'n-recap',
          role: 'assistant',
          content: {
            content_type: 'reasoning_recap',
            content: 'Thought for a few seconds',
          },
          at: '2026-11-03T10:00:02.000Z',
        },
        {
          id: 'n-reply',
          role: 'assistant',
          text: 'Use the sieve of Eratosthenes.',
          at: '2026-11-03T10:00:03.000Z',
        },
      ],
    })
  })

  test('archives the thoughts as reasoning between the prompt and the reply', async () => {
    await sync()

    expect(await getJson(`/threads/chatgpt/${sieveId}?items=all`)).toEqual({
      thread: expect.anything(),
      items: [
        expect.objectContaining({ id: `${sieveId}:n-ask:user_message` }),
        expect.objectContaining({
          id: `${sieveId}:n-thoughts:reasoning`,
          type: 'reasoning',
          role: null,
          text: [
            '**Weighing approaches**',
            'Trial division is too slow.',
            '**Picking a sieve**',
            'Eratosthenes fits a million.',
          ].join('\n\n'),
        }),
        expect.objectContaining({ id: `${sieveId}:n-reply:assistant_message` }),
      ],
    })
  })

  test('search finds the reasoning only with items=all', async () => {
    await sync()

    expect(await getJson('/search?q=trial division')).toEqual({ hits: [] })
    expect(await getJson('/search?q=trial division&items=all')).toEqual({
      hits: [expect.objectContaining({ itemType: 'reasoning' })],
    })
  })
})

/** A citation marker as ChatGPT writes it, in private-use characters. */
const cite = (...refs: string[]) =>
  `\uE200cite\uE202${refs.join('\uE202')}\uE201`

describe('POST /sync with a reply that cites sources', () => {
  const hydrationId = '673e1b2c-3d4e-8009-f4a5-1a2b3c4d5e6f'
  const entity = '\uE200entity\uE202["bakery","Tartine"]\uE201'
  const product =
    '\uE200product\uE202{"product_name":"Cane-lined basket"}\uE201'
  const attribution = 'Tartine bakes at 78%.'
  const [first, second] = [cite('turn0search0'), cite('turn0search1')]
  const reply = `【重要】Start around 70%\uE203.${first} ${entity} uses 75%.${second} ${attribution}${product}`

  beforeEach(() => {
    chatgpt.putChat({
      id: hydrationId,
      title: 'Bread hydration',
      updatedAt: '2026-11-04T10:00:00.000000Z',
      nodes: [
        {
          id: 'n-ask',
          role: 'user',
          text: '【質問】What hydration suits a beginner loaf?',
          at: '2026-11-04T10:00:00.000Z',
        },
        {
          id: 'n-reply',
          role: 'assistant',
          text: reply,
          metadata: {
            content_references: [
              { type: 'hidden', matched_text: '\uE203', alt: null },
              {
                type: 'grouped_webpages',
                matched_text: first,
                items: [
                  {
                    title: 'Baker’s percentages explained',
                    url: 'https://www.kingarthurbaking.com/blog/hydration?utm_source=chatgpt.com',
                    snippet: 'Hydration is water over flour.',
                    attribution: 'King Arthur Baking',
                  },
                ],
              },
              {
                type: 'entity',
                matched_text: entity,
                alt: 'Tartine',
              },
              {
                type: 'product',
                // ChatGPT may list a no-break hyphen or space where the reply
                // has a plain one.
                matched_text: product.replace('-', '\u2011'),
                alt: null,
              },
              {
                type: 'attribution',
                matched_text: attribution,
                alt: attribution,
              },
              {
                type: 'grouped_webpages',
                matched_text: second,
                items: [
                  {
                    title: 'Untitled crumb guide',
                    url: 'https://example.org/crumb-guide',
                    snippet: '',
                    attribution: 'example.org',
                  },
                ],
              },
              {
                type: 'sources_footnote',
                matched_text: ' ',
                sources: [
                  {
                    title: 'Baker’s percentages explained',
                    url: 'https://www.kingarthurbaking.com/blog/hydration?utm_source=chatgpt.com',
                    attribution: 'King Arthur Baking',
                  },
                  {
                    title: 'Tartine country loaf',
                    url: 'https://example.com/tartine',
                    attribution: 'example.com',
                  },
                ],
              },
            ],
          },
          at: '2026-11-04T10:00:05.000Z',
        },
      ],
    })
  })

  test('archives the sources after the reply, with its markup shown as the UI does', async () => {
    await sync()

    expect(await getJson(`/threads/chatgpt/${hydrationId}?items=all`)).toEqual({
      thread: expect.anything(),
      items: [
        expect.objectContaining({
          text: '【質問】What hydration suits a beginner loaf?',
        }),
        expect.objectContaining({
          id: `${hydrationId}:n-reply:assistant_message`,
          // 【…】 is real text. An entity shows as its name, a product card as
          // nothing.
          text: '【重要】Start around 70%. Tartine uses 75%. Tartine bakes at 78%.',
        }),
        expect.objectContaining({
          id: `${hydrationId}:n-reply:web_sources`,
          type: 'web_sources',
          role: null,
          payload: JSON.stringify({
            sources: [
              {
                url: 'https://www.kingarthurbaking.com/blog/hydration?utm_source=chatgpt.com',
                title: 'Baker’s percentages explained',
              },
              {
                url: 'https://example.org/crumb-guide',
                title: 'Untitled crumb guide',
              },
              {
                url: 'https://example.com/tartine',
                title: 'Tartine country loaf',
              },
            ],
          }),
        }),
      ],
    })
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

test('POST /sync archives the sources an older reply searched, as it cites none by URL', async () => {
  const baseId = '672f2c3d-4e5f-800a-a5b6-2b3c4d5e6f70'
  chatgpt.putChat({
    id: baseId,
    title: 'Base64 images',
    updatedAt: '2024-11-05T10:00:00.000000Z',
    nodes: [
      {
        id: 'n-ask',
        role: 'user',
        text: 'Convert a PNG to base64 in JavaScript?',
        at: '2024-11-05T10:00:00.000Z',
      },
      {
        id: 'n-reply',
        role: 'assistant',
        text: 'Use the FileReader API.',
        metadata: {
          citations: [
            { start_ix: 23, end_ix: 24, invalid_reason: 'Unsupported' },
          ],
          content_references: [{ type: 'hidden', matched_text: '' }],
          search_result_groups: [
            {
              type: 'search_result_group',
              domain: 'developer.mozilla.org',
              entries: [
                {
                  type: 'search_result',
                  url: 'https://developer.mozilla.org/docs/Web/API/FileReader',
                  title: 'FileReader - Web APIs',
                  snippet: 'Reads the contents of files.',
                },
              ],
            },
          ],
        },
        at: '2024-11-05T10:00:05.000Z',
      },
    ],
  })

  await sync()

  expect(await getJson(`/threads/chatgpt/${baseId}?items=all`)).toEqual({
    thread: expect.anything(),
    items: [
      expect.objectContaining({ type: 'user_message' }),
      expect.objectContaining({ text: 'Use the FileReader API.' }),
      expect.objectContaining({
        type: 'web_sources',
        payload: JSON.stringify({
          sources: [
            {
              url: 'https://developer.mozilla.org/docs/Web/API/FileReader',
              title: 'FileReader - Web APIs',
            },
          ],
        }),
      }),
    ],
  })
})

const promptAndReply = (id: string, prompt: string, at: string) => [
  { id: `${id}-ask`, role: 'user' as const, text: prompt, at },
  { id: `${id}-reply`, role: 'assistant' as const, text: 'Sure.', at },
]

test('POST /sync archives archived and custom GPT chats too', async () => {
  chatgpt.putChat({
    id: '673bd4e3-4f50-8006-c172-8d9e0f1a2b3c',
    title: 'Old trip',
    updatedAt: '2026-10-01T00:00:00.000000Z',
    archived: true,
    nodes: promptAndReply(
      'archived',
      'Plan a day in Nikko.',
      '2026-10-01T00:00:00.000Z',
    ),
  })
  chatgpt.putChat({
    id: '673ce5f4-5061-8007-d283-9e0f1a2b3c4d',
    title: 'Recipe GPT',
    updatedAt: '2026-10-02T00:00:00.000000Z',
    gizmoId: 'g-fake0recipe',
    nodes: promptAndReply(
      'gizmo',
      'Scale this focaccia to two trays.',
      '2026-10-02T00:00:00.000Z',
    ),
  })

  await sync()

  expect(await messageTexts('673bd4e3-4f50-8006-c172-8d9e0f1a2b3c')).toEqual([
    'Plan a day in Nikko.',
    'Sure.',
  ])
  expect(await messageTexts('673ce5f4-5061-8007-d283-9e0f1a2b3c4d')).toEqual([
    'Scale this focaccia to two trays.',
    'Sure.',
  ])
})

describe('GET /search after a ChatGPT Sync', () => {
  test('a hit links to the chat on chatgpt.com', async () => {
    await sync()

    expect(await getJson('/search?q=rye loaf&host=chatgpt')).toEqual({
      hits: [
        {
          host: 'chatgpt',
          environmentId: null,
          threadId: sourdough.id,
          threadTitle: 'Sourdough hydration',
          project: null,
          itemType: 'user_message',
          role: 'user',
          snippet: 'And for a «rye loaf»?',
          createdAt: '2026-11-02T09:00:00.000Z',
          archived: false,
          link: `https://chatgpt.com/c/${sourdough.id}`,
        },
      ],
    })
  })

  test('host=chatgpt limits hits to ChatGPT Threads', async () => {
    testApp = createTestApp({ hosts: ['hive'], fetch: chatgpt.fetch })
    chatgpt.storeSession(testApp.root)
    const hive = createFakeHost(testApp.root, 'hive')
    hive.addThread({
      id: 'thread-1',
      title: 'Bakery site',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    hive.addMessage({
      id: 'item-1',
      threadId: 'thread-1',
      ordinal: 1,
      role: 'user',
      text: 'List the rye loaf on the menu page.',
      updatedAt: '2026-11-01T00:00:01.000Z',
    })
    await sync()

    expect(await getJson('/search?q=rye loaf')).toEqual({
      hits: expect.arrayContaining([
        expect.objectContaining({ host: 'chatgpt' }),
        expect.objectContaining({ host: 'hive' }),
      ]),
    })
    expect(await getJson('/search?q=rye loaf&host=chatgpt')).toEqual({
      hits: [expect.objectContaining({ host: 'chatgpt' })],
    })
  })
})

describe('POST /sync again', () => {
  test('re-reads only chats whose listed last update changed', async () => {
    chatgpt.putChat({
      id: '673df605-6172-8008-e394-0f1a2b3c4d5e',
      title: 'Tokyo trip',
      updatedAt: '2026-11-03T00:00:00.000000Z',
      nodes: promptAndReply(
        'tokyo',
        'Best ramen near Shinjuku?',
        '2026-11-03T00:00:00.000Z',
      ),
    })
    await sync()
    chatgpt.reads.length = 0
    chatgpt.putChat({
      id: '673df605-6172-8008-e394-0f1a2b3c4d5e',
      title: 'Tokyo trip',
      updatedAt: '2026-11-04T00:00:00.000000Z',
      nodes: [
        ...promptAndReply(
          'tokyo',
          'Best ramen near Shinjuku?',
          '2026-11-03T00:00:00.000Z',
        ),
        ...promptAndReply(
          'tokyo-2',
          'Is it open on Sundays?',
          '2026-11-04T00:00:00.000Z',
        ),
      ],
    })

    await sync()

    expect(chatgpt.reads).toEqual(['673df605-6172-8008-e394-0f1a2b3c4d5e'])
    expect(await getJson('/search?q=sundays')).toEqual({
      hits: [
        expect.objectContaining({
          threadId: '673df605-6172-8008-e394-0f1a2b3c4d5e',
        }),
      ],
    })
  })

  test('keeps a chat that is no longer listed', async () => {
    await sync()
    chatgpt.removeChat(sourdough.id)

    await sync()

    expect(await getJson('/search?q=rye loaf')).toEqual({
      hits: [expect.objectContaining({ threadId: sourdough.id })],
    })
  })

  test("keeps an unlisted chat's Signature, so it isn't re-read when listed again", async () => {
    await sync()
    chatgpt.removeChat(sourdough.id)
    await sync()
    chatgpt.reads.length = 0
    chatgpt.putChat({ ...sourdough, archived: true })

    await sync()

    expect(chatgpt.reads).toEqual([])
  })
})

/** Puts `count` chats of one prompt and reply, oldest first, and gives their IDs in that order. */
const putChats = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const id = `chat-${String(index).padStart(3, '0')}`
    const at = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()
    chatgpt.putChat({
      id,
      title: `Chat ${index}`,
      updatedAt: at,
      nodes: promptAndReply(id, `Question ${index}`, at),
    })
    return id
  })

describe('POST /sync with a backlog', () => {
  test('reads the 30 oldest changed chats per Sync until every page is archived', async () => {
    chatgpt.removeChat(sourdough.id)
    const ids = putChats(250)

    await sync()

    expect(chatgpt.reads).toEqual(ids.slice(0, 30))

    // 250 chats at 30 per Sync take 9 Syncs.
    for (let syncs = 1; syncs < 9; syncs++) await sync()
    chatgpt.reads.length = 0
    await sync()

    expect(chatgpt.reads).toEqual([])
    for (const id of [ids[0], ids[249]]) {
      expect(await testApp.handle(`/threads/chatgpt/${id}`)).toHaveProperty(
        'status',
        200,
      )
    }
  })

  test('once caught up, lists only until the first page without a change', async () => {
    chatgpt.removeChat(sourdough.id)
    putChats(150)
    for (let syncs = 0; syncs < 5; syncs++) await sync()
    chatgpt.listRequests.length = 0

    await sync()

    expect(
      chatgpt.listRequests.map(({ offset, archived }) => ({
        offset,
        archived,
      })),
    ).toEqual([
      { offset: 0, archived: false },
      { offset: 0, archived: true },
    ])

    chatgpt.listRequests.length = 0
    chatgpt.reads.length = 0
    chatgpt.putChat({
      id: 'fresh',
      title: 'Fresh chat',
      updatedAt: '2026-11-10T00:00:00.000000Z',
      nodes: promptAndReply(
        'fresh',
        'Anything new?',
        '2026-11-10T00:00:00.000Z',
      ),
    })

    await sync()

    expect(
      chatgpt.listRequests.map(({ offset, archived }) => ({
        offset,
        archived,
      })),
    ).toEqual([
      { offset: 0, archived: false },
      { offset: 100, archived: false },
      { offset: 0, archived: true },
    ])
    expect(chatgpt.reads).toEqual(['fresh'])
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

describe('POST /sync when reading a chat fails', () => {
  test('re-reads only the chats that did not land', async () => {
    chatgpt.putChat({
      id: '673e0716-7283-8009-f4a5-1a2b3c4d5e6f',
      title: 'Newer',
      updatedAt: '2026-11-05T00:00:00.000000Z',
      nodes: promptAndReply(
        'newer',
        'A newer question',
        '2026-11-05T00:00:00.000Z',
      ),
    })
    chatgpt.failRead('673e0716-7283-8009-f4a5-1a2b3c4d5e6f', 500)

    await sync()

    expect(await chatgptRow()).toEqual(
      expect.objectContaining({
        lastError:
          'ChatGPT answered /backend-api/conversation/673e0716-7283-8009-f4a5-1a2b3c4d5e6f with HTTP 500',
      }),
    )
    expect(chatgpt.reads).toEqual([
      sourdough.id,
      '673e0716-7283-8009-f4a5-1a2b3c4d5e6f',
    ])

    chatgpt.reads.length = 0
    await sync()

    expect(chatgpt.reads).toEqual(['673e0716-7283-8009-f4a5-1a2b3c4d5e6f'])
    expect(await chatgptRow()).toEqual(
      expect.objectContaining({ lastError: null }),
    )
  })

  test('records a chat that does not parse and keeps its archived Items', async () => {
    await sync()
    chatgpt.putChat({
      ...sourdough,
      updatedAt: '2026-11-06T00:00:00.000000Z',
      currentNode: 'node-gone',
    })

    await sync()

    expect(await chatgptRow()).toEqual(
      expect.objectContaining({
        lastError: `ChatGPT chat ${sourdough.id} didn't parse: its branch breaks at node node-gone`,
      }),
    )
    expect(await messageTexts(sourdough.id)).toHaveLength(4)
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

    // The session exchange, one page of each list and the chat read.
    expect(sentAt).toHaveLength(4)
    const gaps = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? at))
    // Timers can fire a little early under load; unpaced gaps are near 0.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(40)
  })
})
