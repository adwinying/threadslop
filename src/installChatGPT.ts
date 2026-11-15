// `threadslop install-chatgpt`, run in the container with `docker exec -it`:
// reads Adwin's ChatGPT session token at a tty prompt that doesn't echo it,
// checks it signs in to ChatGPT, then stores it as the session store.
import type { Terminal } from '~/terminal'
import type { Fetch } from '~/web'
import { mkdirSync } from 'node:fs'
import {
  checkChatGPTSignIn,
  saveChatGPTSession,
  sessionCookie,
} from '~/chatgpt'
import { createEnvironment } from '~/env'
import { hiddenPrompt } from '~/terminal'

type InstallChatGPTOptions = Partial<Terminal> & {
  env?: Record<string, string | undefined>
  /** Replaces the network, so tests can sign in to a fake ChatGPT. */
  fetch?: Fetch
}

/** Runs the command and resolves with its exit code. */
export const installChatGPT = async (
  args: string[],
  {
    env = process.env,
    fetch = globalThis.fetch,
    input = process.stdin,
    output = process.stdout,
  }: InstallChatGPTOptions = {},
) => {
  if (args.length > 0) {
    console.error('Usage: threadslop install-chatgpt')
    return 1
  }
  const prompt = hiddenPrompt({ input, output })
  if (prompt === undefined) {
    console.error(
      'threadslop: install-chatgpt needs a tty; run it with docker exec -it',
    )
    return 1
  }
  const token = await prompt(`${sessionCookie} (join .0 and .1 if split): `)
  if (token === undefined) return 130

  // A failure other than signed out, such as a Cloudflare challenge, is no
  // fault of the token, so it's reported as is.
  let cookiesToStore
  try {
    cookiesToStore = await checkChatGPTSignIn({
      cookies: { [sessionCookie]: token },
      fetch,
    })
  } catch (cause) {
    console.error(
      `threadslop: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return 1
  }
  if (cookiesToStore === undefined) {
    console.error("threadslop: that token doesn't sign in to ChatGPT")
    return 1
  }
  const dataDir = createEnvironment(env).DATA_DIR
  mkdirSync(dataDir, { recursive: true })
  saveChatGPTSession(dataDir, { cookies: cookiesToStore })
  console.log('threadslop: signed in to ChatGPT, the next Sync pulls it')
  return 0
}
