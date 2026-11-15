import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '~/start'
import {
  createFakeHost,
  createFakeHostRoot,
  createFakeTransport,
  waitForSync,
} from '~/testing/fakeHost'

const createDataDir = () => mkdtempSync(join(tmpdir(), 'start-'))

// The fake transport runs the query script against fixtures under `root`, so a
// Sync never reaches a real Host.
const startService = async (dataDir: string, root = createFakeHostRoot()) => {
  const { app } = await start({
    env: { DATA_DIR: dataDir },
    listen: () => undefined,
    transport: createFakeTransport(root),
  })
  const handle = (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost${path}`, init))
  return Object.assign(handle, {
    sync: async () => {
      await handle('/sync', { method: 'POST' })
      await waitForSync(handle)
    },
    cronSync: () => app.store.cron.sync.trigger(),
  })
}

const fetchPublicKey = async (dataDir: string) => {
  const handle = await startService(dataDir)
  const response = await handle('/pubkey')
  return { status: response.status, body: await response.text() }
}

const health = async (handle: Awaited<ReturnType<typeof startService>>) =>
  (await handle('/health')).json()

describe('GET /pubkey', () => {
  test('returns the ed25519 key generated on first start', async () => {
    const dataDir = join(createDataDir(), 'data')

    const { status, body } = await fetchPublicKey(dataDir)

    expect(status).toBe(200)
    expect(body).toMatch(/^ssh-ed25519 [\w+/]+=* threadslop@nas$/)
  })

  test('returns the same key after a restart', async () => {
    const dataDir = createDataDir()

    const first = await fetchPublicKey(dataDir)
    const second = await fetchPublicKey(dataDir)

    expect(second.body).toBe(first.body)
  })
})

describe('the Host list file', () => {
  test('is created on first start with only comments, listing no Hosts', async () => {
    const dataDir = createDataDir()

    const handle = await startService(dataDir)

    const lines = readFileSync(join(dataDir, 'hosts'), 'utf8')
      .trimEnd()
      .split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.startsWith('#'))).toBe(true)
    expect(await health(handle)).toEqual({ syncing: false, hosts: [] })
  })

  test('is kept as it is on restart', async () => {
    const dataDir = createDataDir()
    writeFileSync(join(dataDir, 'hosts'), 'adwin@hive\n')

    const handle = await startService(dataDir)

    expect(readFileSync(join(dataDir, 'hosts'), 'utf8')).toBe('adwin@hive\n')
    expect(await health(handle)).toEqual({
      syncing: false,
      hosts: [expect.objectContaining({ host: 'hive' })],
    })
  })

  test('is re-read by /health, with blank lines and comments ignored', async () => {
    const dataDir = createDataDir()
    const handle = await startService(dataDir)

    writeFileSync(
      join(dataDir, 'hosts'),
      '# laptops\nadwin@hive\n\n  a.ying@crefil  # work\n',
    )

    expect(await health(handle)).toEqual({
      syncing: false,
      hosts: [
        expect.objectContaining({ host: 'hive' }),
        expect.objectContaining({ host: 'crefil' }),
      ],
    })
  })
})

const addHiveThread = (root: string) =>
  createFakeHost(root, 'hive').addThread({
    id: 'thread-1',
    title: 'Fix login',
    updatedAt: '2026-11-01T00:00:00.000Z',
  })

describe('POST /sync with the Host list file', () => {
  test('syncs a Host added to the file since start', async () => {
    const dataDir = createDataDir()
    const root = createFakeHostRoot()
    addHiveThread(root)
    const handle = await startService(dataDir, root)

    writeFileSync(join(dataDir, 'hosts'), 'adwin@hive\n')
    await handle.sync()

    expect((await handle('/threads/hive/thread-1')).status).toBe(200)
  })

  test('keeps the archive of a Host removed from the file', async () => {
    const dataDir = createDataDir()
    const root = createFakeHostRoot()
    addHiveThread(root)
    writeFileSync(join(dataDir, 'hosts'), 'adwin@hive\n')
    const handle = await startService(dataDir, root)
    await handle.sync()

    writeFileSync(join(dataDir, 'hosts'), '')
    await handle.sync()

    expect(await health(handle)).toEqual({ syncing: false, hosts: [] })
    const thread = await handle('/threads/hive/thread-1')
    expect(thread.status).toBe(200)
  })

  test.each([
    ['a missing user', 'hive', 'line 3: hive must be user@host'],
    [
      'a leading dash (ssh option)',
      '-oProxyCommand=sh@x',
      'line 3: -oProxyCommand=sh@x must be user@host',
    ],
    [
      'a repeated hostname',
      'root@hive',
      'line 3: root@hive repeats the hostname hive',
    ],
    [
      'the hostname reserved for Gemini',
      'adwin@Gemini',
      'line 3: adwin@Gemini uses gemini, reserved for Gemini',
    ],
    [
      'a hostname repeated in another case',
      'adwin@hivE',
      'line 3: adwin@hivE repeats the hostname hive',
    ],
  ])('fails naming the line with %s', async (_, entry, error) => {
    const dataDir = createDataDir()
    const handle = await startService(dataDir)

    writeFileSync(join(dataDir, 'hosts'), `# Hosts\nadwin@hive\n${entry}\n`)
    const response = await handle('/sync', { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.text()).toBe(`${join(dataDir, 'hosts')} ${error}`)
  })
})

describe('the Sync cron job with a malformed Host list file', () => {
  test('logs the error, and the next tick syncs once the file is fixed', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const dataDir = createDataDir()
    const root = createFakeHostRoot()
    addHiveThread(root)
    const handle = await startService(dataDir, root)

    writeFileSync(join(dataDir, 'hosts'), 'hive\n')
    await handle.cronSync()
    writeFileSync(join(dataDir, 'hosts'), 'adwin@hive\n')
    await handle.cronSync()

    expect(error).toHaveBeenCalledWith(
      'Sync failed:',
      new Error(`${join(dataDir, 'hosts')} line 1: hive must be user@host`),
    )
    expect(await health(handle)).toEqual({
      syncing: false,
      hosts: [expect.objectContaining({ host: 'hive', lastError: null })],
    })
    expect((await handle('/threads/hive/thread-1')).status).toBe(200)
    error.mockRestore()
  })
})
