import type { Database } from 'bun:sqlite'
import type { Host } from '~/hosts'
import { Elysia } from 'elysia'
import { createArchive, migrate } from '~/archive'
import { searchRoutes } from '~/routes/search'
import { syncRoutes } from '~/routes/sync'
import { createSearch } from '~/search'
import { syncAll } from '~/sync'

export type QueryOperation = 'signatures' | 'threads'

/** Runs a query operation on a Host and resolves with its stdout. */
export type HostTransport = (
  host: Host,
  operation: QueryOperation,
  stdin?: string,
) => Promise<string>

export type AppCollaborators = {
  /** Opened with `{ strict: true }`, so queries bind `$name` params by name. */
  database: Database
  hosts: Host[]
  transport: HostTransport
  clock: () => Date
}

export const createApp = ({ database, hosts, transport }: AppCollaborators) => {
  migrate(database)
  const archive = createArchive(database)

  return new Elysia()
    .get('/health', () => 'ok')
    .use(syncRoutes(() => syncAll(archive, transport, hosts)))
    .use(searchRoutes(createSearch(database)))
}
