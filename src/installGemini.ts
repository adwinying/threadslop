// `threadslop install-gemini`, run in the container with `docker exec -it`:
// reads Adwin's Google session cookies at a tty prompt that doesn't echo them,
// checks they sign in to Gemini, then stores them as the session store.
import type { Terminal } from '~/terminal'
import type { Fetch } from '~/web'
import { mkdirSync } from 'node:fs'
import { createEnvironment } from '~/env'
import { checkGeminiSignIn, saveGeminiSession } from '~/gemini'
import { hiddenPrompt } from '~/terminal'

// Firefox's: Chromium's device-bound sessions cut its cookies to a few hours.
// All of them: since Google's 2026-11-19 build, `__Secure-1PSID` and
// `__Secure-1PSIDTS` alone redirect to sign-in.
const question = 'Cookie header of a gemini.google.com/app request (Firefox): '

/** `a=1; b=2`, with or without a leading `Cookie:`, as name → value. */
const parseCookieHeader = (header: string) =>
  Object.fromEntries(
    header
      .replace(/^cookie:/i, '')
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes('='))
      .map((pair) => {
        const index = pair.indexOf('=')
        return [pair.slice(0, index), pair.slice(index + 1)]
      }),
  )

type InstallGeminiOptions = Partial<Terminal> & {
  env?: Record<string, string | undefined>
  /** Replaces the network, so tests can sign in to a fake Gemini. */
  fetch?: Fetch
}

/** Runs the command and resolves with its exit code. */
export const installGemini = async (
  args: string[],
  {
    env = process.env,
    fetch = globalThis.fetch,
    input = process.stdin,
    output = process.stdout,
  }: InstallGeminiOptions = {},
) => {
  if (args.length > 0) {
    console.error('Usage: threadslop install-gemini')
    return 1
  }
  const prompt = hiddenPrompt({ input, output })
  if (prompt === undefined) {
    console.error(
      'threadslop: install-gemini needs a tty; run it with docker exec -it',
    )
    return 1
  }
  const header = await prompt(question)
  if (header === undefined) return 130
  // Firefox cuts a long header short with `…` unless Raw is on. Sent as is, the
  // `…` would fail fetch with an error that prints every cookie.
  if (!/^[\x20-\x7e]*$/.test(header)) {
    console.error(
      "threadslop: that header isn't whole; copy it with Raw on in Firefox's Headers panel",
    )
    return 1
  }
  const cookies = parseCookieHeader(header)

  // A failure other than signed out, such as Google answering 503, is no fault
  // of the cookies, so it's reported as is.
  let cookiesToStore
  try {
    cookiesToStore = await checkGeminiSignIn({ cookies, fetch })
  } catch (cause) {
    console.error(
      `threadslop: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return 1
  }
  if (cookiesToStore === undefined) {
    console.error("threadslop: those cookies don't sign in to Gemini")
    return 1
  }
  const dataDir = createEnvironment(env).DATA_DIR
  mkdirSync(dataDir, { recursive: true })
  saveGeminiSession(dataDir, { cookies: cookiesToStore })
  console.log('threadslop: signed in to Gemini, the next Sync pulls it')
  return 0
}
