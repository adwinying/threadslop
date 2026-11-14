import type { createSearch } from '~/search'
import { Elysia, t } from 'elysia'

export const searchRoutes = (search: ReturnType<typeof createSearch>) =>
  new Elysia().get(
    '/search',
    ({ query: { q, limit } }) => ({ hits: search(q, limit) }),
    {
      query: t.Object({
        q: t.String({ minLength: 1 }),
        limit: t.Numeric({ minimum: 1, maximum: 100, default: 20 }),
      }),
    },
  )
