import { Elysia } from 'elysia'

/** Starts a Sync unless one is running, and answers without waiting for it. */
export const syncRoutes = (startSync: () => boolean) =>
  new Elysia().post('/sync', ({ status }) =>
    status(202, { status: startSync() ? 'started' : 'running' }),
  )
