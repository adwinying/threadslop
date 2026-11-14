import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// `threadslop install-host <user@host>`, run in the container with
// `docker exec -it`: logs in to the Host with its password once, authorizes
// threadslop's key there for the query script only (ADR 0001), then adds the
// Host to the Host list.
// oxlint-disable-next-line import/default -- a text import, typed by query.d.mts
import hostQueryScript from '~/../host/query.mjs' with { type: 'text' }
import { createEnvironment } from '~/env'
import {
  appendHost,
  ensureHostsFile,
  hostSchema,
  hostsFile,
  readHosts,
} from '~/hosts'
import { ensureSshKey } from '~/ssh'

const publicKeyPattern = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2}) [\w.@-]+$/

const forcedCommand =
  '~/.nix-profile/bin/node --disable-warning=ExperimentalWarning ~/.local/share/threadslop/query.mjs'

/**
 * A POSIX sh script for the Host that installs the query script and appends
 * the key's `authorized_keys` line unless the key is already there.
 */
export const installScript = ({
  publicKey,
  queryScript,
}: {
  publicKey: string
  queryScript: string
}) => {
  const keyBlob = publicKeyPattern.exec(publicKey)?.[1]
  if (keyBlob === undefined) {
    throw new Error(`not an ed25519 public key: ${publicKey}`)
  }
  // The pattern admits no quotes, so single-quoting below is safe.
  const line = `restrict,command="${forcedCommand}" ${publicKey}`

  return `set -eu
dir="$HOME/.local/share/threadslop"
mkdir -p "$dir"
printf '%s' '${Buffer.from(queryScript).toString('base64')}' | base64 -d > "$dir/query.mjs.tmp"
mv "$dir/query.mjs.tmp" "$dir/query.mjs"

umask 077
[ -d "$HOME/.ssh" ] || mkdir "$HOME/.ssh"
keys="$HOME/.ssh/authorized_keys"
[ -e "$keys" ] || : > "$keys"
if grep -qF '${keyBlob}' "$keys"; then
  echo 'threadslop: key already authorized, query script updated'
  exit 0
fi
if [ -s "$keys" ] && [ -n "$(tail -c 1 "$keys")" ]; then
  echo >> "$keys"
fi
printf '%s\\n' '${line}' >> "$keys"
echo 'threadslop: key authorized, query script installed'
`
}

type InstallHostOptions = {
  env?: Record<string, string | undefined>
  /** The ssh binary. Tests swap in a stand-in. */
  ssh?: string
}

/** Runs the command with its arguments and resolves with its exit code. */
export const installHost = async (
  args: string[],
  { env = process.env, ssh = 'ssh' }: InstallHostOptions = {},
) => {
  const host = hostSchema.safeParse(args.length === 1 ? args[0] : undefined)
  if (!host.success) {
    console.error('Usage: threadslop install-host <user@host>')
    return 1
  }
  const dataDir = createEnvironment(env).DATA_DIR
  mkdirSync(dataDir, { recursive: true })
  const { publicKey } = await ensureSshKey(dataDir)
  ensureHostsFile(dataDir)

  const listed = readHosts(dataDir).find(
    ({ label }) => label === host.data.label,
  )
  if (listed !== undefined && listed.destination !== host.data.destination) {
    console.error(
      `threadslop: ${listed.label} is already listed as ${listed.destination} in ${hostsFile(dataDir)}`,
    )
    return 1
  }

  const child = Bun.spawn(
    [
      ssh,
      '-F',
      '/dev/null',
      // threadslop's own key, once authorized, would hit the forced command
      // instead of running this script, so log in with the password.
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${join(dataDir, 'known_hosts')}`,
      host.data.destination,
      'sh -s',
    ],
    {
      // ssh reads the password from the tty, so stdin carries the script.
      stdin: new TextEncoder().encode(
        installScript({ publicKey, queryScript: hostQueryScript }),
      ),
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  const exitCode = await child.exited
  if (exitCode !== 0) return exitCode

  if (listed === undefined) {
    appendHost(dataDir, host.data)
    console.log(
      `threadslop: listed ${host.data.destination}, the next Sync pulls it`,
    )
  }
  return 0
}
