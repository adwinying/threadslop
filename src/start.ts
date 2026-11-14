import type { AnyElysia } from 'elysia'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '~/app'
import { createEnvironment } from '~/env'
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
  port?: number
}

export const start = async ({
  env = process.env,
  listen: startListening = listen,
  port = 3000,
}: StartOptions = {}) => {
  const config = createEnvironment(env)
  mkdirSync(config.DATA_DIR, { recursive: true })
  const { publicKey } = await ensureSshKey(config.DATA_DIR)

  const app = createApp({
    database: new Database(join(config.DATA_DIR, 'threadslop.sqlite'), {
      create: true,
      strict: true,
    }),
    hosts: config.HOSTS,
    transport: createSshTransport({ dataDir: config.DATA_DIR }),
    clock: () => new Date(),
  }).use(pubkeyRoutes(publicKey))

  startListening(app, port)

  return { app }
}
