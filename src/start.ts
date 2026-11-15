import type { AnyElysia } from 'elysia'
import type { Fetch } from '~/gemini'
import type { HostTransport } from '~/hosts'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '~/app'
import { createEnvironment } from '~/env'
import { ensureHostsFile, readHosts } from '~/hosts'
import { pubkeyRoutes } from '~/routes/pubkey'
import { createSshTransport, ensureSshKey } from '~/ssh'

type Listen = (app: AnyElysia, port: number) => void

const listen: Listen = (app, port) => {
  app.listen(port)
  console.log(`threadslop is listening on ${app.server?.url}`)
}

export type StartOptions = {
  env?: Record<string, string | undefined>
  listen?: Listen
  /** Replaces ssh, so tests can Sync fake Hosts. */
  transport?: HostTransport
  /** Replaces the network, so tests can Sync a fake Gemini. */
  fetch?: Fetch
}

export const start = async ({
  env = process.env,
  listen: startListening = listen,
  transport,
  fetch = globalThis.fetch,
}: StartOptions = {}) => {
  const config = createEnvironment(env)
  mkdirSync(config.DATA_DIR, { recursive: true })
  const { publicKey } = await ensureSshKey(config.DATA_DIR)
  ensureHostsFile(config.DATA_DIR)

  const app = createApp({
    database: new Database(join(config.DATA_DIR, 'threadslop.sqlite'), {
      create: true,
      strict: true,
    }),
    dataDir: config.DATA_DIR,
    hosts: () => readHosts(config.DATA_DIR),
    transport: transport ?? createSshTransport({ dataDir: config.DATA_DIR }),
    fetch,
    clock: () => new Date(),
  }).use(pubkeyRoutes(publicKey))

  startListening(app, 3000)

  return { app }
}
