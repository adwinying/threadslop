import type { HostTransport } from '~/hosts'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const identityFileName = 'id_ed25519'

const run = async (command: string[], stdin?: string) => {
  const child = Bun.spawn(command, {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command[0]} exited with ${exitCode}`)
  }
  return stdout
}

/** The service's SSH identity, generated in the data directory once. */
export const ensureSshKey = async (dataDir: string) => {
  const identityFile = join(dataDir, identityFileName)
  if (!existsSync(identityFile)) {
    await run([
      'ssh-keygen',
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'threadslop@nas',
      '-f',
      identityFile,
    ])
  }
  const publicKey = (await readFile(`${identityFile}.pub`, 'utf8')).trim()
  return { publicKey }
}

type SshTransportOptions = {
  dataDir: string
  /** The ssh binary. Tests swap in a stand-in. */
  ssh?: string
}

/**
 * Runs query operations over ssh. The Host's forced command ignores the
 * requested command except as SSH_ORIGINAL_COMMAND (ADR 0001).
 */
export const createSshTransport =
  ({ dataDir, ssh = 'ssh' }: SshTransportOptions): HostTransport =>
  (host, operation, stdin) =>
    run(
      [
        ssh,
        // Ignore any ssh_config, so behavior doesn't depend on the machine.
        '-F',
        '/dev/null',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        // Fail within ~45s if a Host goes to sleep mid-Sync, so it can't block the others.
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${join(dataDir, 'known_hosts')}`,
        // Never offer agent keys: an unrestricted key would get a shell.
        '-o',
        'IdentitiesOnly=yes',
        '-i',
        join(dataDir, identityFileName),
        host.destination,
        operation,
      ],
      stdin,
    )
