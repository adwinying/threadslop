// `bun run install-host <user@host>`: authorizes threadslop's key on a Host
// for the query script only (ADR 0001). Run it from a machine that can already
// ssh to the Host, never from inside the container.
import { fileURLToPath } from 'node:url'
import { hostListSchema } from '~/hosts'

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

const main = async () => {
  const hosts = hostListSchema.safeParse(Bun.argv[2] ?? '')
  if (!hosts.success || hosts.data.length !== 1) {
    console.error('Usage: bun run install-host <user@host>')
    process.exit(1)
  }
  const serviceUrl = process.env.THREADSLOP_URL ?? 'http://nas:3005'

  const response = await fetch(new URL('/pubkey', serviceUrl))
  if (!response.ok) {
    throw new Error(`GET ${response.url} responded ${response.status}`)
  }
  const script = installScript({
    publicKey: (await response.text()).trim(),
    queryScript: await Bun.file(
      fileURLToPath(new URL('../host/query.mjs', import.meta.url)),
    ).text(),
  })

  const ssh = Bun.spawn(['ssh', hosts.data[0].destination, 'sh -s'], {
    stdin: new TextEncoder().encode(script),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await ssh.exited)
}

if (import.meta.main) await main()
