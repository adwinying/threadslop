import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installChatGPT } from '~/installChatGPT'
import { createFakeChatGPT } from '~/testing/fakeChatGPT'
import { createTestApp } from '~/testing/fakeHost'
import { createTerminal } from '~/testing/fakeTerminal'

const prompt = '__Secure-next-auth.session-token (join .0 and .1 if split): '

const setup = () => {
  const chatgpt = createFakeChatGPT()
  const testApp = createTestApp({ hosts: [], fetch: chatgpt.fetch })
  const sessionFile = join(testApp.root, 'chatgpt-session.json')
  return {
    chatgpt,
    testApp,
    sessionMode: () => statSync(sessionFile).mode & 0o777,
    session: () => readFileSync(sessionFile, 'utf8'),
    install: (
      answers: string[],
      { args = [], isTTY = true }: { args?: string[]; isTTY?: boolean } = {},
    ) => {
      const terminal = createTerminal(answers, { isTTY })
      return {
        terminal,
        exitCode: installChatGPT(args, {
          env: { DATA_DIR: testApp.root },
          fetch: chatgpt.fetch,
          input: terminal.input,
          output: terminal.output,
        }),
      }
    },
  }
}

let log: ReturnType<typeof spyOn>
let error: ReturnType<typeof spyOn>
beforeEach(() => {
  log = spyOn(console, 'log').mockImplementation(() => undefined)
  error = spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  log.mockRestore()
  error.mockRestore()
})

describe('threadslop install-chatgpt', () => {
  test('stores a token that signs in, readable by its owner only, so the next Sync includes ChatGPT', async () => {
    const { testApp, sessionMode, install } = setup()

    expect(await install(['fake-session-token\r']).exitCode).toBe(0)
    expect(sessionMode()).toBe(0o600)

    await testApp.sync()
    expect(await (await testApp.handle('/health')).json()).toEqual({
      syncing: false,
      hosts: [expect.objectContaining({ host: 'chatgpt', lastError: null })],
    })
  })

  test("doesn't echo the token", async () => {
    const { install } = setup()

    const { terminal, exitCode } = install(['fake-session-token\r'])
    await exitCode

    expect(terminal.screen()).toBe(`${prompt}\n`)
  })

  test('refuses a token that is signed out, keeping the stored session', async () => {
    const { chatgpt, testApp, session, install } = setup()
    chatgpt.storeSession(testApp.root)
    const stored = session()

    expect(await install(['stale-session-token\r']).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      "threadslop: that token doesn't sign in to ChatGPT",
    )
    expect(session()).toBe(stored)
  })

  test('names the status when ChatGPT fails the check, rather than blaming the token', async () => {
    const { chatgpt, testApp, session, install } = setup()
    chatgpt.storeSession(testApp.root)
    const stored = session()
    chatgpt.failSession(503)

    expect(await install(['fake-session-token\r']).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      'threadslop: ChatGPT answered /api/auth/session with HTTP 503',
    )
    expect(session()).toBe(stored)
  })

  test('names Cloudflare when it challenges the check', async () => {
    const { chatgpt, install } = setup()
    chatgpt.challenge()

    expect(await install(['fake-session-token\r']).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith(
      'threadslop: Cloudflare challenged /api/auth/session with HTTP 403',
    )
  })

  test('refuses to prompt without a tty, where the token would echo', async () => {
    const { chatgpt, testApp, session, install } = setup()
    chatgpt.storeSession(testApp.root)
    const stored = session()

    const { terminal, exitCode } = install(['fake-session-token\r'], {
      isTTY: false,
    })

    expect(await exitCode).toBe(1)
    expect(terminal.screen()).toBe('')
    expect(session()).toBe(stored)
  })

  test('prints usage given arguments', async () => {
    const { install } = setup()

    expect(await install([], { args: ['--help'] }).exitCode).toBe(1)
    expect(error).toHaveBeenCalledWith('Usage: threadslop install-chatgpt')
  })
})
