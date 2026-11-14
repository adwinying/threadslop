import type { Archive } from '~/archive'
import { Elysia } from 'elysia'

export const healthRoutes = (health: () => ReturnType<Archive['health']>) =>
  new Elysia().get('/health', () => ({ hosts: health() }))
