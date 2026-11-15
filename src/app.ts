import type { Database } from 'bun:sqlite'
import type { Host, HostTransport } from '~/hosts'
import type { Fetch } from '~/web'
import { cron } from '@elysiajs/cron'
import { Elysia } from 'elysia'
import { createArchive, migrate } from '~/archive'
import { chatgptLabel, hasChatGPTSession } from '~/chatgpt'
import { syncChatGPT } from '~/chatgptSync'
import { geminiLabel, hasGeminiSession } from '~/gemini'
import { syncGemini } from '~/geminiSync'
import { healthRoutes } from '~/routes/health'
import { searchRoutes } from '~/routes/search'
import { syncRoutes } from '~/routes/sync'
import { threadRoutes } from '~/routes/threads'
import { createSearch } from '~/search'
import { snapshot } from '~/snapshot'
import { syncAll, syncHost } from '~/sync'
import { createThreadReader } from '~/threads'

const logFailure = (job: string) => (error: unknown) => {
  console.error(`${job} failed:`, error)
}

export type AppCollaborators = {
  /** Opened with `{ strict: true }`, so queries bind `$name` params by name. */
  database: Database
  /** Where the Snapshot is written and the Gemini and ChatGPT sessions are stored. */
  dataDir: string
  /** Read at the start of every Sync and `/health`; throws if invalid. */
  hosts: () => Host[]
  transport: HostTransport
  /** Reaches Google for Gemini and chatgpt.com for ChatGPT. */
  fetch: Fetch
  /** Milliseconds between requests to Google. */
  geminiPace: number
  /** Milliseconds between requests to chatgpt.com. */
  chatgptPace: number
  clock: () => Date
  /** Registers the cron jobs without letting them fire; tests trigger them. */
  pauseCrons?: boolean
}

export const createApp = ({
  database,
  dataDir,
  hosts,
  transport,
  fetch,
  geminiPace,
  chatgptPace,
  clock,
  pauseCrons = false,
}: AppCollaborators) => {
  migrate(database)
  const archive = createArchive(database)

  // The Hosts, then Gemini and ChatGPT while their session stores exist.
  const sources = () => [
    ...hosts().map((host) => ({
      label: host.label,
      sync: () => syncHost(archive, transport, host),
    })),
    ...(hasGeminiSession(dataDir)
      ? [
          {
            label: geminiLabel,
            sync: () =>
              syncGemini(archive, { dataDir, fetch, clock, pace: geminiPace }),
          },
        ]
      : []),
    ...(hasChatGPTSession(dataDir)
      ? [
          {
            label: chatgptLabel,
            sync: () => syncChatGPT({ dataDir, fetch, pace: chatgptPace }),
          },
        ]
      : []),
  ]

  // Syncs never overlap: callers arriving mid-Sync join it. A Sync never
  // rejects; its failure is logged here and per-Host results land in /health.
  let running: Promise<void> | undefined
  const sync = () => {
    if (running !== undefined) return { started: false, done: running }
    // Read up front, so POST /sync answers a malformed Host list with its error.
    running = syncAll(archive, sources(), clock)
      .catch(logFailure('Sync'))
      .finally(() => {
        running = undefined
      })
    return { started: true, done: running }
  }

  return new Elysia()
    .use(
      cron({
        name: 'sync',
        pattern: '*/5 * * * *',
        run: () => sync().done,
        paused: pauseCrons,
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
        run: () => snapshot(database, dataDir),
        paused: pauseCrons,
        catch: logFailure('Snapshot'),
      }),
    )
    .use(
      healthRoutes(() => ({
        syncing: running !== undefined,
        hosts: archive.health(sources().map(({ label }) => label)),
      })),
    )
    .use(syncRoutes(() => sync().started))
    .use(searchRoutes(createSearch(database)))
    .use(threadRoutes(createThreadReader(database)))
}
