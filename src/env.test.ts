import { describe, expect, spyOn, test } from 'bun:test'
import { createEnvironment } from '~/env'

describe('HOSTS', () => {
  test('parses user@host entries into Hosts labelled by hostname', () => {
    const { HOSTS } = createEnvironment({
      HOSTS: 'adwin@hive, a.ying@crefil,adwin@mayonaca',
    })

    expect(HOSTS).toEqual([
      { label: 'hive', destination: 'adwin@hive' },
      { label: 'crefil', destination: 'a.ying@crefil' },
      { label: 'mayonaca', destination: 'adwin@mayonaca' },
    ])
  })

  test.each([
    ['missing', undefined],
    ['without a user', 'hive'],
    ['with an empty user', '@hive'],
    ['with an empty hostname', 'adwin@'],
    ['with two @', 'adwin@hive@crefil'],
    ['with whitespace inside', 'adwin@hive crefil'],
    ['with an empty entry', 'adwin@hive,,adwin@crefil'],
    ['starting with a dash (ssh option)', '-oProxyCommand=sh@hive'],
    ['repeating a hostname', 'adwin@hive,root@hive'],
  ])('rejects a Host list %s', (_, HOSTS) => {
    spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => createEnvironment({ HOSTS })).toThrow(
      'Invalid environment variables',
    )
  })
})
