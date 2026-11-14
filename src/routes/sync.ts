import type { syncAll } from '~/sync'
import { Elysia } from 'elysia'

export const syncRoutes = (sync: () => ReturnType<typeof syncAll>) =>
  new Elysia().post('/sync', () => sync())
