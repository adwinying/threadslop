import type { createThreadReader } from '~/threads'
import { Elysia, t } from 'elysia'
import { itemScopeSchema } from '~/itemScope'

export const threadRoutes = (
  readThread: ReturnType<typeof createThreadReader>,
) =>
  new Elysia().get(
    '/threads/:host/:threadId',
    ({ params: { host, threadId }, query: { items }, status }) =>
      readThread(host, threadId, items) ?? status(404, 'Thread not found'),
    { query: t.Object({ items: itemScopeSchema }) },
  )
