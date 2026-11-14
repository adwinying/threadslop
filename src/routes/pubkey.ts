import { Elysia } from 'elysia'

/** Serves the service's SSH public key. */
export const pubkeyRoutes = (publicKey: string) =>
  new Elysia().get('/pubkey', () => publicKey)
