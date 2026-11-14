import type { FakeHost } from '~/testing/fakeHost'
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  createFakeHost,
  createFakeHostRoot,
  runQueryScript,
} from '~/testing/fakeHost'

let host: FakeHost

beforeEach(() => {
  host = createFakeHost(createFakeHostRoot(), 'hive')
})

describe('Host query script', () => {
  test.each(['', 'sh', 'signatures; rm -rf ~', '__proto__'])(
    'refuses unknown operation %p',
    async (operation) => {
      const { stdout, stderr, exitCode } = await runQueryScript(
        host.home,
        operation,
      )

      expect(exitCode).not.toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toContain('unknown operation')
    },
  )

  test.each([
    ['not JSON', 'thread-1'],
    ['not an array', '"thread-1"'],
    ['a non-string ID', '[1]'],
    ['an empty ID', '[""]'],
    ['quotes', `["thread-1' OR 1=1 --"]`],
    ['a slash', '["../thread-1"]'],
    ['whitespace', '["thread 1"]'],
  ])('refuses Thread IDs with %s', async (_, stdin) => {
    const { stdout, stderr, exitCode } = await runQueryScript(
      host.home,
      'threads',
      stdin,
    )

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).not.toBe('')
  })

  test('accepts non-UUID Thread IDs that T3 uses', async () => {
    const id = 'thread:delegated-task:command%3Amcp%3Aabc.def_1'
    host.addThread({
      id,
      title: 'Delegated',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })

    const { stdout, exitCode } = await runQueryScript(
      host.home,
      'threads',
      JSON.stringify([id, 'mcp:launch:0f3a']),
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      threads: [expect.objectContaining({ id, title: 'Delegated' })],
    })
  })
})
