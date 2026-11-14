import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '~/start'

const startService = (dataDir: string) =>
  start({
    // A Sync tick must never reach a real Host.
    env: { HOSTS: 'threadslop@host.invalid', DATA_DIR: dataDir },
    listen: () => undefined,
  })

const fetchPublicKey = async (dataDir: string) => {
  const { app } = await startService(dataDir)
  const response = await app.handle(new Request('http://localhost/pubkey'))
  return { status: response.status, body: await response.text() }
}

describe('GET /pubkey', () => {
  test('returns the ed25519 key generated on first start', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'start-')), 'data')

    const { status, body } = await fetchPublicKey(dataDir)

    expect(status).toBe(200)
    expect(body).toMatch(/^ssh-ed25519 [\w+/]+=* threadslop@nas$/)
  })

  test('returns the same key after a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'start-'))

    const first = await fetchPublicKey(dataDir)
    const second = await fetchPublicKey(dataDir)

    expect(second.body).toBe(first.body)
  })
})
