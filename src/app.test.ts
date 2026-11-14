import type { HostTransport } from '~/hosts'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createApp } from '~/app'

const unreachableTransport: HostTransport = async () => {
  throw new Error('no Host should be contacted')
}

const createTestApp = () =>
  createApp({
    database: new Database(':memory:', { strict: true }),
    hosts: [{ label: 'hive', destination: 'adwin@hive' }],
    transport: unreachableTransport,
    clock: () => new Date('2026-11-14T00:00:00Z'),
  })

const request = (path: string) =>
  createTestApp().handle(new Request(`http://localhost${path}`))

describe('GET /health', () => {
  test('responds 200', async () => {
    const response = await request('/health')

    expect(response.status).toBe(200)
  })
})
