import type { FakeGemini } from '~/testing/fakeGemini'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createFakeGemini } from '~/testing/fakeGemini'
import { createTestApp } from '~/testing/fakeHost'

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
