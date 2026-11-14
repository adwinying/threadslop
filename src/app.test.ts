import type { HostTransport } from '~/hosts'
import { describe, expect, test } from 'bun:test'
import { createTestApp } from '~/testing/fakeHost'

const unreachableTransport: HostTransport = async () => {
  throw new Error('no Host should be contacted')
}

describe('GET /health', () => {
  test('responds 200', async () => {
    const { handle } = createTestApp({ transport: unreachableTransport })

    const response = await handle('/health')

    expect(response.status).toBe(200)
  })
})
