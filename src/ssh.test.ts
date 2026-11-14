import { describe, expect, test } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSshTransport } from '~/ssh'
import { createFakeHost, createFakeHostRoot } from '~/testing/fakeHost'

const queryScript = fileURLToPath(new URL('../host/query.mjs', import.meta.url))
const hive = { label: 'hive', destination: 'adwin@hive' }

// Stands in for ssh plus the Host's sshd: records its arguments, then runs the
// forced command with the requested operation in SSH_ORIGINAL_COMMAND.
const createFakeSsh = (root: string, home: string) => {
  const ssh = join(root, 'ssh')
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
eval "operation=\\\${$#}"
HOME='${home}' SSH_ORIGINAL_COMMAND="$operation" exec node --disable-warning=ExperimentalWarning '${queryScript}'
`,
  )
  chmodSync(ssh, 0o755)
  return {
    ssh,
    args: () => readFileSync(`${ssh}.args`, 'utf8').trimEnd().split('\n'),
  }
}

describe('ssh Host transport', () => {
  test('runs the operation on the Host with the key and known_hosts from the data directory', async () => {
    const root = createFakeHostRoot()
    const host = createFakeHost(root, 'hive')
    host.addThread({
      id: 'thread-1',
      title: 'Fix login',
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    const { ssh, args } = createFakeSsh(root, host.home)
    const transport = createSshTransport({ dataDir: '/data', ssh })

    const stdout = await transport(hive, 'threads', '["thread-1"]')

    expect(JSON.parse(stdout).threads).toMatchObject([
      { id: 'thread-1', title: 'Fix login' },
    ])
    expect(args()).toEqual([
      '-F',
      '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'UserKnownHostsFile=/data/known_hosts',
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      '/data/id_ed25519',
      'adwin@hive',
      'threads',
    ])
  })

  test('rejects with what ssh printed when it fails', async () => {
    const root = createFakeHostRoot()
    const ssh = join(root, 'ssh')
    writeFileSync(
      ssh,
      "#!/bin/sh\necho 'Host key verification failed.' >&2\nexit 255\n",
    )
    chmodSync(ssh, 0o755)
    const transport = createSshTransport({ dataDir: '/data', ssh })

    // bun-types types `rejects` matchers as sync, but they return a Promise.
    // oxlint-disable-next-line typescript/await-thenable -- without await the test ends before the assertion
    await expect(transport(hive, 'signatures')).rejects.toThrow(
      'Host key verification failed.',
    )
  })
})
