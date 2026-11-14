import type { createSearch } from '~/search'
import { Elysia, t } from 'elysia'
import { itemScopeSchema } from '~/itemScope'

export const searchRoutes = (search: ReturnType<typeof createSearch>) =>
  new Elysia().get(
    '/search',
    ({ query: { q, ...options } }) => ({ hits: search(q, options) }),
    {
      query: t.Object({
        q: t.String({ minLength: 1 }),
        host: t.Optional(t.String()),
        items: itemScopeSchema,
        limit: t.Numeric({ minimum: 1, maximum: 100, default: 20 }),
      }),
    },
  )
