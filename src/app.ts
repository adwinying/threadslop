import type { Database } from 'bun:sqlite'
import type { Host, HostTransport } from '~/hosts'
import { cron } from '@elysiajs/cron'
import { Elysia } from 'elysia'
import { createArchive, migrate } from '~/archive'
import { searchRoutes } from '~/routes/search'
import { syncRoutes } from '~/routes/sync'
import { threadRoutes } from '~/routes/threads'
import { createSearch } from '~/search'
import { snapshot } from '~/snapshot'
import { syncAll } from '~/sync'
import { createThreadReader } from '~/threads'

const logFailure = (job: string) => (error: unknown) => {
  console.error(`${job} failed:`, error)
}

export type AppCollaborators = {
  /** Opened with `{ strict: true }`, so queries bind `$name` params by name. */
  database: Database
  hosts: Host[]
  transport: HostTransport
  clock: () => Date
}

export const createApp = ({
  database,
  hosts,
  transport,
  clock,
}: AppCollaborators) => {
  migrate(database)
  const archive = createArchive(database)
  const labels = hosts.map(({ label }) => label)

  // Syncs never overlap: callers arriving mid-Sync share its result.
  let running: ReturnType<typeof syncAll> | undefined
  const sync = () =>
    (running ??= syncAll(archive, transport, hosts, clock).finally(() => {
      running = undefined
    }))

  return new Elysia()
    .use(
      cron({
        name: 'sync',
        pattern: '*/5 * * * *',
        run: sync,
        catch: logFailure('Sync'),
      }),
    )
    .use(
      cron({
        name: 'snapshot',
        // After docker-update recreates containers at 05:00 and before kopia's
        // 06:00 run.
        pattern: '45 5 * * *',
        timezone: 'Asia/Tokyo',
        run: () => snapshot(database),
        catch: logFailure('Snapshot'),
      }),
    )
    .get('/health', () => ({ hosts: archive.health(labels) }))
    .use(syncRoutes(sync))
    .use(searchRoutes(createSearch(database)))
    .use(threadRoutes(createThreadReader(database)))
}
