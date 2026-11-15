import { describe, expect, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installHost, installScript } from '~/installHost'

const queryScript = readFileSync(
  fileURLToPath(new URL('../host/query.mjs', import.meta.url)),
  'utf8',
)
const forcedCommand =
  '~/.nix-profile/bin/node --disable-warning=ExperimentalWarning ~/.local/share/threadslop/query.mjs'

// Stands in for ssh plus the Host's sshd: records its arguments, then runs the
// script it gets on stdin in a temp HOME, as `sh -s` would on the Host.
const setup = (sshBody?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'install-host-'))
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(home)
  const ssh = join(root, 'ssh')
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
${sshBody ?? `HOME='${home}' exec sh -s`}
`,
  )
  chmodSync(ssh, 0o755)

  const read = (path: string) => readFileSync(join(home, path), 'utf8')
  return {
    dataDir,
    home,
    read,
    mode: (path: string) => statSync(join(home, path)).mode & 0o777,
    hostsFile: () => readFileSync(join(dataDir, 'hosts'), 'utf8'),
    authorizedLine: () =>
      `restrict,command="${forcedCommand}" ${readFileSync(join(dataDir, 'id_ed25519.pub'), 'utf8').trim()}`,
    sshArgs: () =>
      existsSync(`${ssh}.args`)
        ? readFileSync(`${ssh}.args`, 'utf8').trimEnd().split('\n')
        : undefined,
    install: (...args: string[]) =>
      installHost(args, { env: { DATA_DIR: dataDir }, ssh }),
  }
}

describe('threadslop install-host', () => {
  test('installs the query script, authorizes the key for it only and lists the Host', async () => {
    const host = setup()

    const exitCode = await host.install('adwin@hive')

    expect(exitCode).toBe(0)
    expect(host.read('.local/share/threadslop/query.mjs')).toBe(queryScript)
    expect(host.read('.ssh/authorized_keys')).toBe(`${host.authorizedLine()}\n`)
    expect(host.mode('.ssh')).toBe(0o700)
    expect(host.mode('.ssh/authorized_keys')).toBe(0o600)
    expect(host.hostsFile()).toEndWith('\nadwin@hive\n')
  })

  test('logs in with the password, never a key, trusting the Host key on first use', async () => {
    const host = setup()

    await host.install('adwin@hive')

    expect(host.sshArgs()).toEqual([
      '-F',
      '/dev/null',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${join(host.dataDir, 'known_hosts')}`,
      'adwin@hive',
      'sh -s',
    ])
  })

  test('re-runs update the script without duplicating the key or the entry', async () => {
    const host = setup()

    await host.install('adwin@hive')
    writeFileSync(join(host.home, '.local/share/threadslop/query.mjs'), 'stale')
    const exitCode = await host.install('adwin@hive')

    expect(exitCode).toBe(0)
    expect(host.read('.local/share/threadslop/query.mjs')).toBe(queryScript)
    expect(host.read('.ssh/authorized_keys')).toBe(`${host.authorizedLine()}\n`)
    expect(host.hostsFile().match(/adwin@hive/g)).toHaveLength(1)
  })

  test('reads the hostname case-insensitively, so it matches the listed Host', async () => {
    const host = setup()
    mkdirSync(host.dataDir)
    writeFileSync(join(host.dataDir, 'hosts'), 'adwin@hive\n')

    const exitCode = await host.install('adwin@hivE')

    expect(exitCode).toBe(0)
    expect(host.sshArgs()).toContain('adwin@hive')
    expect(host.hostsFile()).toBe('adwin@hive\n')
  })

  test("replaces an earlier threadslop key's line, so an old key or command doesn't linger", async () => {
    const host = setup()
    const ssh = join(host.home, '.ssh')
    mkdirSync(ssh, { mode: 0o700 })
    writeFileSync(
      join(ssh, 'authorized_keys'),
      'ssh-ed25519 AAAA me\nrestrict,command="old" ssh-ed25519 BBBB threadslop@nas\nssh-ed25519 CCCC other\n',
      { mode: 0o600 },
    )

    await host.install('adwin@hive')

    expect(host.read('.ssh/authorized_keys')).toBe(
      `ssh-ed25519 AAAA me\nssh-ed25519 CCCC other\n${host.authorizedLine()}\n`,
    )
    expect(host.mode('.ssh/authorized_keys')).toBe(0o600)
  })

  test('keeps existing keys and their permissions', async () => {
    const host = setup()
    const ssh = join(host.home, '.ssh')
    mkdirSync(ssh, { mode: 0o755 })
    writeFileSync(join(ssh, 'authorized_keys'), 'ssh-ed25519 AAAA me', {
      mode: 0o644,
    })

    await host.install('adwin@hive')

    expect(host.read('.ssh/authorized_keys')).toBe(
      `ssh-ed25519 AAAA me\n${host.authorizedLine()}\n`,
    )
    expect(host.mode('.ssh')).toBe(0o755)
    expect(host.mode('.ssh/authorized_keys')).toBe(0o644)
  })

  test('appends to a Host list without a trailing newline', async () => {
    const host = setup()
    mkdirSync(host.dataDir)
    writeFileSync(join(host.dataDir, 'hosts'), 'a.ying@crefil')

    await host.install('adwin@hive')

    expect(host.hostsFile()).toBe('a.ying@crefil\nadwin@hive\n')
  })

  test('rejects a hostname already listed under another user before connecting', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const host = setup()
    mkdirSync(host.dataDir)
    writeFileSync(join(host.dataDir, 'hosts'), 'adwin@hive\n')

    const exitCode = await host.install('root@hive')

    expect(exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('hive is already listed as adwin@hive'),
    )
    expect(host.sshArgs()).toBeUndefined()
    expect(host.hostsFile()).toBe('adwin@hive\n')
    error.mockRestore()
  })

  test('leaves the Host list alone when ssh fails', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const host = setup('echo "Permission denied" >&2; exit 255')

    const exitCode = await host.install('adwin@hive')

    expect(exitCode).toBe(255)
    expect(host.hostsFile()).not.toContain('adwin@hive')
    error.mockRestore()
  })

  test.each([
    ['no arguments', []],
    ['--help', ['--help']],
    ['an entry that is not user@host', ['hive']],
    ['an ssh option', ['-oProxyCommand=sh@hive']],
    ['two entries', ['adwin@hive', 'adwin@crefil']],
    ['the hostname reserved for Gemini', ['adwin@gemini']],
  ])('prints usage given %s', async (_, args) => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const host = setup()

    const exitCode = await host.install(...args)

    expect(exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      'Usage: threadslop install-host <user@host>',
    )
    expect(host.sshArgs()).toBeUndefined()
    error.mockRestore()
  })
})

describe('installScript', () => {
  const publicKey =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBiJhP2ZDdNVtUqx4yKcgnWa5f+gH6l0x0x0x0x0x0x threadslop@nas'

  test.each([
    ['an RSA key', 'ssh-rsa AAAAB3NzaC1yc2E threadslop@nas'],
    ['extra options', `command="sh" ${publicKey}`],
    ['a second line', `${publicKey}\nssh-ed25519 AAAA evil`],
  ])('rejects a public key with %s', (_, key) => {
    expect(() => installScript({ publicKey: key, queryScript: '' })).toThrow(
      'not an ed25519 public key',
    )
  })
})
