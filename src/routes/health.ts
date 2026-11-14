import type { Archive } from '~/archive'
import { Elysia } from 'elysia'

export const healthRoutes = (
  health: () => { syncing: boolean; hosts: ReturnType<Archive['health']> },
) => new Elysia().get('/health', health)
