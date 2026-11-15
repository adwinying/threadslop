// `threadslop install-gemini`, run in the container with `docker exec -it`:
// reads Adwin's Google session cookies at a tty prompt that doesn't echo them,
// checks they sign in to Gemini, then stores them as the session store.
import type { Fetch } from '~/gemini'
import { mkdirSync } from 'node:fs'
import { createEnvironment } from '~/env'
import { checkGeminiSignIn, saveGeminiSession } from '~/gemini'

/** The tty the cookies are typed at. Tests swap in a stand-in. */
type Terminal = {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
  }
  output: NodeJS.WritableStream
}

// Firefox's: Chromium's device-bound sessions cut its cookies to a few hours.
const cookieNames = ['__Secure-1PSID', '__Secure-1PSIDTS']

const enter = new Set(['\r', '\n'])
const cancel = new Set(['\u0003', '\u0004']) // Ctrl-C, Ctrl-D
const erase = new Set(['\u007f', '\b'])

/**
 * Reads a line at the tty in raw mode, so the tty doesn't echo it. Resolves
 * with undefined when cancelled.
 */
const promptHidden = (
  question: string,
  { input, output }: Terminal,
  setRawMode: (mode: boolean) => unknown,
) =>
  new Promise<string | undefined>((resolve) => {
    let answer = ''
    const finish = (result: string | undefined) => {
      input.off('data', onData)
      setRawMode(false)
      input.pause()
      output.write('\n')
      resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (enter.has(char)) return finish(answer.trim())
        if (cancel.has(char)) return finish(undefined)
        answer = erase.has(char) ? answer.slice(0, -1) : answer + char
      }
    }
    setRawMode(true)
    input.on('data', onData)
    input.resume()
    output.write(question)
  })

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
  const { setRawMode } = input
  // Without a tty, nothing here can stop the cookies being echoed.
  if (!input.isTTY || setRawMode === undefined) {
    console.error(
      'threadslop: install-gemini needs a tty; run it with docker exec -it',
    )
    return 1
  }
  const cookies: Record<string, string> = {}
  for (const name of cookieNames) {
    const value = await promptHidden(
      `${name} (from Firefox): `,
      { input, output },
      setRawMode.bind(input),
    )
    if (value === undefined) return 130
    cookies[name] = value
  }

  // A failure other than signed out, such as Google answering 503, is no fault
  // of the cookies, so it's reported as is.
  const signedIn = await checkGeminiSignIn({ cookies, fetch }).catch(
    (cause: unknown) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  )
  if (signedIn instanceof Error) {
    console.error(`threadslop: ${signedIn.message}`)
    return 1
  }
  if (signedIn === undefined) {
    console.error("threadslop: those cookies don't sign in to Gemini")
    return 1
  }
  const dataDir = createEnvironment(env).DATA_DIR
  mkdirSync(dataDir, { recursive: true })
  saveGeminiSession(dataDir, { cookies: signedIn })
  console.log('threadslop: signed in to Gemini, the next Sync pulls it')
  return 0
}
