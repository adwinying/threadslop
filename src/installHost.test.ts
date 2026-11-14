import { describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installScript } from '~/installHost'

const publicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBiJhP2ZDdNVtUqx4yKcgnWa5f+gH6l0x0x0x0x0x0x threadslop@nas'
const authorizedLine = `restrict,command="~/.nix-profile/bin/node --disable-warning=ExperimentalWarning ~/.local/share/threadslop/query.mjs" ${publicKey}`

// Runs the script as `ssh <host> sh -s` would on the Host.
const runOnHost = (home: string, queryScript = 'console.log("v1")\n') => {
  const { exitCode, stderr } = Bun.spawnSync(['sh', '-s'], {
    env: { HOME: home, PATH: process.env.PATH },
    stdin: new TextEncoder().encode(installScript({ publicKey, queryScript })),
  })
  if (exitCode !== 0) throw new Error(stderr.toString())
}

const read = (home: string, path: string) =>
  readFileSync(join(home, path), 'utf8')
const mode = (home: string, path: string) =>
  statSync(join(home, path)).mode & 0o777

describe('install-host', () => {
  test('installs the query script and authorizes the key for it only', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))

    runOnHost(home)

    expect(read(home, '.local/share/threadslop/query.mjs')).toBe(
      'console.log("v1")\n',
    )
    expect(read(home, '.ssh/authorized_keys')).toBe(`${authorizedLine}\n`)
    expect(mode(home, '.ssh')).toBe(0o700)
    expect(mode(home, '.ssh/authorized_keys')).toBe(0o600)
  })

  test('re-runs update the script without duplicating the key', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))

    runOnHost(home)
    runOnHost(home, 'console.log("v2")\n')

    expect(read(home, '.local/share/threadslop/query.mjs')).toBe(
      'console.log("v2")\n',
    )
    expect(read(home, '.ssh/authorized_keys')).toBe(`${authorizedLine}\n`)
  })

  test('keeps existing keys and their permissions', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    mkdirSync(join(home, '.ssh'), { mode: 0o755 })
    writeFileSync(join(home, '.ssh/authorized_keys'), 'ssh-ed25519 AAAA me', {
      mode: 0o644,
    })

    runOnHost(home)

    expect(read(home, '.ssh/authorized_keys')).toBe(
      `ssh-ed25519 AAAA me\n${authorizedLine}\n`,
    )
    expect(mode(home, '.ssh')).toBe(0o755)
    expect(mode(home, '.ssh/authorized_keys')).toBe(0o644)
  })

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
