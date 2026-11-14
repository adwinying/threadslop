import type { Database } from 'bun:sqlite'
import type { Host } from '~/hosts'
import { Elysia } from 'elysia'

export type QueryOperation = 'signatures' | 'threads'

/** Runs a query operation on a Host and resolves with its stdout. */
export type HostTransport = (
  host: Host,
  operation: QueryOperation,
  stdin?: string,
) => Promise<string>

export type AppCollaborators = {
  database: Database
  hosts: Host[]
  transport: HostTransport
  clock: () => Date
}

export const createApp = (_collaborators: AppCollaborators) =>
  new Elysia().get('/health', () => 'ok')
