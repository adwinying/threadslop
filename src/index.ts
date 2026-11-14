import { installHost } from '~/installHost'
import { start } from '~/start'

const [command, ...args] = Bun.argv.slice(2)

if (command === undefined) {
  await start()
} else if (command === 'install-host') {
  process.exit(await installHost(args))
} else {
  console.error('Usage: threadslop [install-host <user@host>]')
  process.exit(1)
}
